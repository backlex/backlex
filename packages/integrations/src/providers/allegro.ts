import { defineProvider } from "../provider";

/**
 * Allegro — Poland's largest marketplace, and the first European local here.
 *
 * Its whole contract is public: `developer.allegro.pl/swagger.yaml` is 1.5 MB of
 * OpenAPI served to anybody, no account and no bot wall. That is rare enough in
 * this package to be worth saying — n11, Hepsiburada and eBay all had to be read
 * through a browser.
 *
 * Three facts shape this file:
 *
 * **Every request carries a vendor media type.** `Accept:
 * application/vnd.allegro.public.v1+json`, not `application/json`. Allegro
 * answers a plain `application/json` with a 406, which reads like an outage
 * rather than a header mistake.
 *
 * **Orders are "checkout forms", and they mirror properly.** The filter bounds
 * `updatedAt`, so a status change brings the order back — the same real-mirror
 * shape eBay, Amazon and n11 have, and unlike Hepsiburada's creation-bounded
 * window.
 *
 * **A seller status write is optimistically concurrent.** `PUT
 * …/fulfillment` takes the `checkoutForm.revision` it was read at, so two
 * writers cannot silently overwrite each other. The revision is pulled onto the
 * order row for exactly that reason.
 *
 * ## Why there is no `listing` here, and what it would take
 *
 * A listing provider has to hand back the whole taxonomy: the engine caches it
 * and the operator searches it. Allegro will not give it. `GET /sale/categories`
 * returns the CHILDREN of one node (`?parent.id=`) and there is no endpoint that
 * returns the tree — so enumerating roughly twenty-three thousand categories
 * means thousands of round trips, which is not a form an operator can wait on.
 *
 * That is a genuine gap in the sixth shape rather than a quirk of Allegro's:
 * `IntegrationListing.categories` assumes a taxonomy small enough to enumerate,
 * and Trendyol's 3,867 nodes were what set that expectation. Closing it means a
 * provider being able to answer "the children of X" and the picker walking
 * levels — a real extension to the shape and the admin form, not a flag. Until
 * then, listing on Allegro would mean either a form that takes hours to draw or
 * a category picker that quietly only offers the top level. Neither is worth
 * shipping, so this provider does what it can do properly: orders in,
 * fulfilment back.
 *
 * `POST /sale/product-offers` and `/sale/matching-categories` are the endpoints
 * that work would build on.
 */

/** Where the API lives. Sandbox is a separate host AND a separate account. */
const HOSTS = {
  production: { api: "https://api.allegro.pl", auth: "https://allegro.pl" },
  sandbox: { api: "https://api.allegro.pl.allegrosandbox.pl", auth: "https://allegro.pl.allegrosandbox.pl" },
} as const;

type Environment = keyof typeof HOSTS;

/**
 * Allegro's own media type, on every request.
 *
 * Not decoration and not a nicety: a plain `application/json` is answered 406,
 * which surfaces as a failing sync with nothing in it about headers.
 */
const MEDIA = "application/vnd.allegro.public.v1+json";

/** Orders per page. Allegro's own maximum is 100. */
const ORDERS_PAGE = 100;

/** The languages Allegro will localise its messages into. */
const LANGUAGES = [
  { value: "pl-PL", label: "Polish" },
  { value: "en-US", label: "English" },
  { value: "cs-CZ", label: "Czech" },
  { value: "sk-SK", label: "Slovak" },
  { value: "hu-HU", label: "Hungarian" },
  { value: "uk-UA", label: "Ukrainian" },
] as const;

const DAY_MS = 86_400_000;

export const allegro = defineProvider({
  id: "allegro",
  label: "Allegro",
  category: "marketplace",
  capabilities: ["source", "task"],
  oauth: {
    authorizeUrl: "https://allegro.pl/auth/oauth/authorize",
    tokenUrl: "https://allegro.pl/auth/oauth/token",
    // Allegro scopes the token to what the application was registered for
    // rather than to what the authorize call asks for, so nothing is requested
    // here — asking for a scope the application does not hold is refused.
    scopes: [],
    tokenAuth: "basic",
  },
  configFields: [
    {
      key: "environment",
      label: "Environment",
      options: [
        { value: "production", label: "Production (allegro.pl)" },
        { value: "sandbox", label: "Sandbox (allegrosandbox.pl)" },
      ],
    },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "language", label: "Message language (optional)", options: LANGUAGES.map((l) => ({ ...l })) },
  ],

  source: {
    childGroups: [{ key: "lines", label: "Order lines" }],
    settingFields: [
      {
        key: "lookbackDays",
        label: "First run reads",
        options: [
          { value: "1", label: "Last 24 hours" },
          { value: "7", label: "Last 7 days" },
          { value: "30", label: "Last 30 days" },
        ],
      },
      {
        key: "status",
        label: "Only these orders (optional)",
        options: [
          { value: "READY_FOR_PROCESSING", label: "Ready for processing" },
          { value: "PROCESSING", label: "Processing" },
          { value: "SENT", label: "Sent" },
          { value: "PICKED_UP", label: "Picked up" },
          { value: "CANCELLED", label: "Cancelled" },
        ],
      },
    ],
    async pull(ctx) {
      const conn = readConnection(ctx, "sync");
      const since = readSince(ctx.cursor, readLookbackDays(ctx.setting("lookbackDays")));
      const offset = readOffset(ctx.cursor);

      const url = new URL(`${conn.api}/order/checkout-forms`);
      // Bounds LAST MODIFIED, so an order that only changed status comes back.
      url.searchParams.set("updatedAt.gte", new Date(since).toISOString());
      url.searchParams.set("limit", String(ORDERS_PAGE));
      url.searchParams.set("offset", String(offset));
      const status = ctx.setting("status");
      if (status) url.searchParams.set("fulfillment.status", status);

      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, "read the orders");
      const body = (await res.json()) as { checkoutForms?: Record<string, unknown>[]; totalCount?: unknown };
      const forms = body.checkoutForms ?? [];

      const records = forms.map((f) => {
        const lines = Array.isArray(f.lineItems) ? (f.lineItems as Record<string, unknown>[]) : [];
        return {
          externalId: text(f.id) ?? "",
          data: orderData(f),
          children: {
            lines: lines.map((l, i) => ({ externalId: text(l.id) ?? String(i + 1), data: lineData(l) })),
          },
        };
      });

      const total = num(body.totalCount) ?? 0;
      const seen = offset + forms.length;
      const more = forms.length > 0 && seen < total;
      return {
        records,
        cursor: more ? `${since}:${seen}` : null,
        complete: !more,
        // The watermark only moves when the walk finished, or a later page's
        // orders would be skipped for ever.
        ...(more ? {} : { resumeAt: Date.now() }),
      };
    },
  },

  tasks: [
    {
      id: "set_fulfillment_status",
      label: "Set order status",
      settingFields: [
        { key: "orderIdField", label: "Order ID column", placeholder: "marketplace_order_id" },
        { key: "revisionField", label: "Order revision column", placeholder: "marketplace_revision" },
        {
          key: "status",
          label: "New status",
          options: [
            { value: "PROCESSING", label: "Processing" },
            { value: "READY_FOR_SHIPMENT", label: "Ready for shipment" },
            { value: "SENT", label: "Sent" },
            { value: "PICKED_UP", label: "Picked up" },
          ],
        },
        { key: "carrierField", label: "Carrier ID column (optional)", placeholder: "carrier_code" },
        { key: "trackingField", label: "Tracking number column (optional)", placeholder: "tracking_number" },
      ],
      outputs: [
        { key: "status", label: "Status set" },
        { key: "sentAt", label: "Reported at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const orderId = required(ctx, "orderIdField", "order id");
        const status = ctx.setting("status");
        if (!status) throw new Error("Pick the status this step should set before running it");

        const url = new URL(`${conn.api}/order/checkout-forms/${encodeURIComponent(orderId)}/fulfillment`);
        // Optimistic concurrency: Allegro refuses the write when the order has
        // moved since it was read. Sent when the column holds one — omitting it
        // is Allegro's own "write regardless", and that is the operator's call
        // rather than a silent default.
        const revision = optional(ctx, "revisionField");
        if (revision) url.searchParams.set("checkoutForm.revision", revision);

        const carrier = optional(ctx, "carrierField");
        const tracking = optional(ctx, "trackingField");
        const body: Record<string, unknown> = { status };
        if (carrier && tracking) {
          // Both or neither: a waybill with no carrier is not a shipment
          // Allegro can show a buyer, and it rejects the pair half-filled.
          body.shipmentSummary = { lineItemsSent: null };
          body.shipments = [{ carrierId: carrier, waybill: tracking }];
        }

        const res = await ctx.fetch(url.toString(), {
          method: "PUT",
          headers: { ...headersFor(conn), "Content-Type": MEDIA },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw await readError(res, `set the status of order ${orderId}`);
        return { outputs: { status, sentAt: Date.now() } };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  api: string;
  language: string;
  token: string;
}

const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const environment = ctx.str("environment");
  const hosts = HOSTS[(environment ?? "") as Environment] ?? HOSTS.production;
  const token = ctx.str("_oauthAccessToken");
  if (!token) throw new Error(`Allegro ${what} is not connected — finish the OAuth consent first`);
  const language = ctx.str("language");
  return {
    api: hosts.api,
    language: LANGUAGES.some((l) => l.value === language) ? (language as string) : "pl-PL",
    token,
  };
};

const headersFor = (conn: Connection): Record<string, string> => ({
  Authorization: `Bearer ${conn.token}`,
  // The vendor media type, not `application/json`. Allegro answers the plain
  // one with a 406.
  Accept: MEDIA,
  "Accept-Language": conn.language,
});

/**
 * Allegro's errors are `{errors:[{code, message, userMessage, path}]}`.
 *
 * `userMessage` is written for a seller and names the field; `message` is the
 * developer-facing summary. The first is quoted when present.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { errors?: { message?: string; userMessage?: string }[] };
    const first = body.errors?.[0];
    detail = (first?.userMessage ?? first?.message ?? detail).slice(0, 200);
  } catch {
    // Not JSON — a gateway page. The truncated body is still the most useful
    // thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `Allegro refused the request and could not ${what} — the connection may need re-authorizing${detail ? `: ${detail}` : ""}`,
    );
  }
  if (res.status === 406) {
    return new Error(
      `Allegro refused the media type and could not ${what} — this is a header fault rather than an outage`,
    );
  }
  return new Error(`Allegro responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

// ── Orders ───────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : 7;
};

/** Cursor is `<sinceMs>:<offset>` — the window travels with the offset. */
const readSince = (cursor: string | null, lookbackDays: number): number => {
  if (cursor) {
    const n = Number(cursor.split(":")[0]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now() - lookbackDays * DAY_MS;
};

const readOffset = (cursor: string | null): number => {
  if (!cursor) return 0;
  const n = Number(cursor.split(":")[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const orderData = (f: Record<string, unknown>): Record<string, unknown> => {
  const buyer = (f.buyer ?? {}) as Record<string, unknown>;
  const delivery = (f.delivery ?? {}) as Record<string, unknown>;
  const address = (delivery.address ?? {}) as Record<string, unknown>;
  const summary = (f.summary ?? {}) as Record<string, unknown>;
  const total = (summary.totalToPay ?? {}) as Record<string, unknown>;
  const fulfillment = (f.fulfillment ?? {}) as Record<string, unknown>;
  return {
    orderId: text(f.id),
    updatedAt: text(f.updatedAt),
    // Carried onto the row on purpose: the status write is optimistically
    // concurrent and this is the value it has to present.
    revision: text(f.revision),
    status: text(f.status),
    fulfillmentStatus: text(fulfillment.status),
    buyerLogin: text(buyer.login),
    buyerEmail: text(buyer.email),
    buyerFirstName: text(buyer.firstName),
    buyerLastName: text(buyer.lastName),
    total: num(total.amount),
    currency: text(total.currency),
    deliveryMethod: text((delivery.method as Record<string, unknown> | undefined)?.name),
    recipientName: [text(address.firstName), text(address.lastName)].filter(Boolean).join(" ") || null,
    companyName: text(address.companyName),
    street: text(address.street),
    city: text(address.city),
    postCode: text(address.zipCode),
    countryCode: text(address.countryCode),
    phone: text(address.phoneNumber),
    note: text(f.messageToSeller),
  };
};

const lineData = (l: Record<string, unknown>): Record<string, unknown> => {
  const offer = (l.offer ?? {}) as Record<string, unknown>;
  const price = (l.price ?? {}) as Record<string, unknown>;
  const external = (offer.external ?? {}) as Record<string, unknown>;
  return {
    lineId: text(l.id),
    offerId: text(offer.id),
    // The seller's OWN code when the offer carries one — which is what a
    // workspace matches its product on, where Allegro's offer id is theirs.
    sku: text(external.id),
    title: text(offer.name),
    quantity: num(l.quantity),
    unitPrice: num(price.amount),
    currency: text(price.currency),
    boughtAt: text(l.boughtAt),
  };
};

// ── Shared ───────────────────────────────────────────────────────────────────

/** Every `*Field` setting names a COLUMN on the row, not a value. */
const required = (
  ctx: { setting(k: string): string | null; row: Readonly<Record<string, unknown>> },
  key: string,
  what: string,
): string => {
  const column = ctx.setting(key);
  if (!column) throw new Error(`Set the ${what} column on the task before running it`);
  const value = text(ctx.row[column]);
  if (!value) throw new Error(`The row has no ${what} in "${column}"`);
  return value;
};

const optional = (
  ctx: { setting(k: string): string | null; row: Readonly<Record<string, unknown>> },
  key: string,
): string | null => {
  const column = ctx.setting(key);
  return column ? text(ctx.row[column]) : null;
};

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
