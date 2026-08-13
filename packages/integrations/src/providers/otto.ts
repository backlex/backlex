import {
  defineProvider,
  type ListingAttribute,
  type ListingCategory,
  type ListingOption,
  type ListingVerdict,
} from "../provider";

/**
 * Otto — Germany's second marketplace, and the second European local here.
 *
 * Like Allegro, its whole contract is public: `api.otto.market/docs/openapi.json`
 * is 700 KB of OpenAPI served to anybody. Unlike Allegro, its taxonomy is
 * enumerable, which is the difference that decides whether a marketplace can
 * list at all in this engine.
 *
 * Four facts shape this file:
 *
 * **A category and its attributes arrive together.** `GET /v5/products/categories`
 * returns category GROUPS, each carrying its categories, its attributes and —
 * uniquely useful — its `variationThemes`. One paged walk answers the whole
 * mapping form, where Hepsiburada needs a call per attribute and Amazon needs a
 * schema fetched from a CDN.
 *
 * **The taxonomy is two levels and both are real.** A group holds categories; a
 * product names a CATEGORY, and the attributes belong to its GROUP. So the group
 * is offered as a branch and the categories under it as leaves, and `attributes`
 * resolves a leaf back to its group.
 *
 * **The brand is a registry, not a string.** `productDescription.brandId` is
 * required and Otto keeps its own brand list, so this provider declares a
 * `brands` lookup — the second after Trendyol's.
 *
 * **Required-ness is NOT taken from `relevance`.** The attribute definition has
 * a `relevance` field whose only published example is `HIGH`, and the spec
 * enumerates nothing. Rather than guess, only the exact value `MANDATORY` marks
 * an attribute required and anything unrecognised is left optional — the safe
 * direction, because a wrongly-required field blocks a form an operator could
 * have submitted, while a wrongly-optional one is refused by Otto with its own
 * message naming the field.
 */

const HOSTS = {
  production: "https://api.otto.market",
  sandbox: "https://api.otto.market/sandbox",
} as const;

type Environment = keyof typeof HOSTS;

/** Category groups per page on the taxonomy walk. Otto's own maximum. */
const CATEGORY_PAGE = 100;

/** Pages one taxonomy walk will take. Otto publishes a few hundred groups. */
const MAX_CATEGORY_PAGES = 20;

/** Products per publish call. Otto takes an array; this bounds the invocation. */
const PUBLISH_BATCH = 100;

/** Brand-search page size. */
const BRAND_PAGE = 50;

const DAY_MS = 86_400_000;

export const otto = defineProvider({
  id: "otto",
  label: "Otto",
  category: "marketplace",
  capabilities: ["source", "task", "listing"],
  // Deliberately NO `oauth` block. Otto mints a token from a partner username
  // and password, with no consent screen and nobody to redirect — so declaring
  // one would put a Connect button in the dialog that leads nowhere. Same call
  // UPS's client-credentials and Amazon's LWA got: the token is minted inside
  // the provider, per invocation. See `connect` below.
  configFields: [
    {
      key: "environment",
      label: "Environment",
      options: [
        { value: "production", label: "Production (api.otto.market)" },
        { value: "sandbox", label: "Sandbox" },
      ],
    },
    { key: "username", label: "Partner username" },
    { key: "password", label: "Partner password", secret: true },
  ],

  source: {
    childGroups: [{ key: "lines", label: "Order positions" }],
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
        key: "fulfillmentStatus",
        label: "Only these positions (optional)",
        options: [
          { value: "ANNOUNCED", label: "Announced" },
          { value: "PROCESSABLE", label: "Processable" },
          { value: "SENT", label: "Sent" },
          { value: "RETURNED", label: "Returned" },
          { value: "CANCELLED_BY_PARTNER", label: "Cancelled by partner" },
          { value: "CANCELLED_BY_MARKETPLACE", label: "Cancelled by marketplace" },
        ],
      },
    ],
    async pull(ctx) {
      const conn = await connect(ctx, "sync");
      const since = readSince(ctx.cursor, readLookbackDays(ctx.setting("lookbackDays")));
      const cursor = readNextCursor(ctx.cursor);

      const url = new URL(`${conn.host}/v4/orders`);
      // `fromDate` bounds LAST MODIFIED, which is what makes this a mirror: a
      // position that only changed status comes back.
      url.searchParams.set("fromDate", new Date(since).toISOString());
      url.searchParams.set("limit", "50");
      const status = ctx.setting("fulfillmentStatus");
      if (status) url.searchParams.set("fulfillmentStatus", status);
      if (cursor) url.searchParams.set("nextcursor", cursor);

      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, "read the orders");
      const body = (await res.json()) as { resources?: Record<string, unknown>[]; links?: Record<string, unknown>[] };
      const orders = body.resources ?? [];

      const records = orders.map((o) => {
        const positions = Array.isArray(o.positionItems) ? (o.positionItems as Record<string, unknown>[]) : [];
        return {
          externalId: text(o.salesOrderId) ?? text(o.orderNumber) ?? "",
          data: orderData(o),
          children: {
            lines: positions.map((p, i) => ({
              externalId: text(p.positionItemId) ?? String(i + 1),
              data: positionData(p),
            })),
          },
        };
      });

      // Otto pages by an opaque cursor carried on a `next` link rather than an
      // offset, so the window has to travel beside it in ours.
      const next = nextLink(body.links);
      return {
        records,
        cursor: next ? `${since}|${next}` : null,
        complete: !next,
        ...(next ? {} : { resumeAt: Date.now() }),
      };
    },
  },

  tasks: [
    {
      id: "ship_positions",
      label: "Report a shipment",
      settingFields: [
        { key: "carrierField", label: "Carrier column", placeholder: "carrier_code" },
        { key: "trackingField", label: "Tracking number column", placeholder: "tracking_number" },
        { key: "positionIdsField", label: "Position IDs column", placeholder: "marketplace_position_ids" },
        { key: "fromCountry", label: "Ship-from country (ISO 3166-1 alpha-2)", placeholder: "DE" },
        { key: "fromPostCode", label: "Ship-from post code" },
        { key: "fromCity", label: "Ship-from city" },
      ],
      outputs: [
        { key: "shippedPositions", label: "Positions reported" },
        { key: "shippedAt", label: "Reported at" },
      ],
      async run(ctx) {
        const conn = await connect(ctx, "task");
        const carrier = required(ctx, "carrierField", "carrier");
        const tracking = required(ctx, "trackingField", "tracking number");
        // Otto reports a shipment against POSITIONS, not against an order, and
        // a row carries them as a list — so unlike eBay's, they are not looked
        // up: the sync already wrote them onto the row.
        const ids = splitList(ctx.row[ctx.setting("positionIdsField") ?? ""]);
        if (ids.length === 0) throw new Error("The row names no Otto position ids to report as shipped");

        const shipDate = new Date().toISOString();
        const res = await ctx.fetch(`${conn.host}/v1/shipments`, {
          method: "POST",
          headers: { ...headersFor(conn), "Content-Type": "application/json" },
          body: JSON.stringify({
            trackingKey: { carrier, trackingNumber: tracking },
            shipDate,
            shipFromAddress: {
              countryCode: ctx.setting("fromCountry") ?? "DE",
              postCode: ctx.setting("fromPostCode") ?? "",
              city: ctx.setting("fromCity") ?? "",
            },
            positionItems: ids.map((id) => ({ positionItemId: id })),
          }),
        });
        if (!res.ok) throw await readError(res, "report the shipment");
        return { outputs: { shippedPositions: ids.length, shippedAt: Date.parse(shipDate) } };
      },
    },
  ],

  listing: {
    settingFields: [
      { key: "vat", label: "VAT rate", options: [
        { value: "FULL", label: "Full rate" },
        { value: "REDUCED", label: "Reduced rate" },
      ] },
      { key: "currency", label: "Currency (ISO 4217)", placeholder: "EUR" },
    ],
    columns: [
      { value: "brandId", label: "Otto brand" },
      { value: "description", label: "Description" },
      { value: "bulletPoints", label: "Bullet points, one per line (optional)" },
      { value: "images", label: "Image URLs" },
    ],
    variantColumns: [
      { value: "sku", label: "Seller SKU" },
      { value: "ean", label: "EAN" },
      { value: "mpn", label: "Manufacturer part number (optional)" },
      { value: "price", label: "Price" },
      { value: "msrp", label: "Recommended retail price (optional)" },
    ],
    /** Otto's status feed is keyed by the seller's own SKU. */
    referenceColumn: "sku",
    outputs: [
      { key: "listingId", label: "Otto MOIN (listing id)" },
      { key: "listingStatus", label: "Listing status" },
      { key: "listingError", label: "Rejection reason" },
      { key: "listedAt", label: "Listed at" },
    ],
    lookups: [{ key: "brands", label: "Otto brands" }],

    async categories(ctx) {
      const conn = await connect(ctx, "listing");
      const groups = await categoryGroups(ctx, conn);
      const out: ListingCategory[] = [];
      for (const group of groups) {
        const id = text(group.categoryGroup);
        if (!id) continue;
        // The group is a branch, not a listable category — a product names one
        // of the categories under it, and the attributes belong to the group.
        out.push({ id, name: id, parentId: null, leaf: false });
        for (const raw of Array.isArray(group.categories) ? group.categories : []) {
          const name = text(raw);
          if (name) out.push({ id: name, name, parentId: id, leaf: true });
        }
      }
      return out;
    },

    async attributes(ctx) {
      const conn = await connect(ctx, "listing");
      const groups = await categoryGroups(ctx, conn);
      // A leaf resolves back to the group that owns it; a group id is accepted
      // too, so a workspace that mapped one still gets the same answer.
      const group = groups.find(
        (g) =>
          text(g.categoryGroup) === ctx.categoryId ||
          (Array.isArray(g.categories) && g.categories.some((c) => text(c) === ctx.categoryId)),
      );
      if (!group) throw new Error(`Otto has no category "${ctx.categoryId}"`);

      const themes = new Set(
        (Array.isArray(group.variationThemes) ? group.variationThemes : []).map((t) => text(t)).filter(Boolean),
      );
      const out: ListingAttribute[] = [];
      for (const raw of Array.isArray(group.attributes) ? group.attributes : []) {
        const a = raw as Record<string, unknown>;
        const name = text(a.name);
        if (!name) continue;
        const allowed = (Array.isArray(a.allowedValues) ? a.allowedValues : [])
          .map((v) => text(v))
          .filter((v): v is string => Boolean(v));
        out.push({
          id: name,
          name: text(a.description) ? `${name} — ${text(a.description)}`.slice(0, 120) : name,
          // `relevance` is not enumerated anywhere in Otto's spec, whose only
          // example is "HIGH". Only the exact word is trusted; anything else
          // stays optional, which is the direction that cannot block a form.
          required: (text(a.relevance) ?? "").toUpperCase() === "MANDATORY",
          allowCustom: allowed.length === 0,
          // Otto says outright which attributes a variant may differ on.
          variant: themes.has(name),
          multiple: a.multiValue === true,
          values: allowed.map((v) => ({ id: v, name: v })),
        });
      }
      return out.sort((a, b) => (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1));
    },

    async lookup(ctx) {
      if (ctx.lookup !== "brands") throw new Error(`Otto has no "${ctx.lookup}" registry`);
      const conn = await connect(ctx, "listing");
      const page = Number(ctx.cursor ?? "0") || 0;
      const url = new URL(`${conn.host}/v5/products/brands`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(BRAND_PAGE));
      if (ctx.query) url.searchParams.set("brandName", ctx.query);

      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, "search the brands");
      const body = (await res.json()) as { brands?: Record<string, unknown>[] };
      const raw = Array.isArray(body.brands) ? body.brands : [];
      const items: ListingOption[] = raw
        // A brand Otto marks unusable cannot carry a listing, so offering it
        // would be offering a choice that fails at publish time.
        .filter((b) => b.usable !== false)
        .map((b) => ({ id: text(b.id) ?? "", name: text(b.name) ?? "" }))
        .filter((b) => b.id && b.name);
      return { items, cursor: raw.length === BRAND_PAGE ? String(page + 1) : null };
    },

    async publish(ctx) {
      const conn = await connect(ctx, "listing");
      const currency = (ctx.setting("currency") ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error("Set the listing's currency to an ISO 4217 code before publishing");
      }
      const vat = ctx.setting("vat") ?? "FULL";

      const settled: ListingVerdict[] = [];
      const payload: Record<string, unknown>[] = [];
      for (const product of ctx.products) {
        const brandId = text(product.fields.brandId);
        for (const variant of product.variants) {
          const sku = text(variant.fields.sku) ?? variant.reference;
          const ean = text(variant.fields.ean);
          if (!sku || !brandId || !ean) {
            // Refused here rather than at Otto: all three are required by the
            // contract, and a batch it rejects wholesale tells an operator
            // nothing about which row was at fault.
            settled.push({
              reference: variant.reference,
              status: "rejected",
              errors: [!sku ? "no seller SKU" : !brandId ? "no Otto brand on the product" : "no EAN"],
            });
            continue;
          }
          if (payload.length >= PUBLISH_BATCH) break;

          const attributes = variant.attributes
            .filter((b) => b.attributeId && (b.valueId ?? b.custom))
            .map((b) => ({ name: b.attributeId, values: [String(b.valueId ?? b.custom)] }));

          payload.push({
            // Groups this product's variants into one Otto article, the same
            // job Trendyol's and n11's `productMainId` does.
            productReference: product.groupId,
            sku,
            ean,
            ...(text(variant.fields.mpn) ? { mpn: text(variant.fields.mpn) } : {}),
            productDescription: {
              category: product.categoryId,
              brandId,
              ...(text(product.fields.description) ? { description: text(product.fields.description) } : {}),
              bulletPoints: splitLines(product.fields.bulletPoints),
              attributes,
            },
            mediaAssets: splitList(product.fields.images).map((location) => ({ type: "IMAGE", location })),
            pricing: {
              standardPrice: { amount: num(variant.fields.price) ?? 0, currency },
              vat,
              ...(num(variant.fields.msrp) !== null
                ? { msrp: { amount: num(variant.fields.msrp), currency } }
                : {}),
            },
          });
        }
      }

      if (payload.length === 0) return { batchId: "", settled };

      const res = await ctx.fetch(`${conn.host}/v5/products`, {
        method: "POST",
        headers: {
          ...headersFor(conn),
          "Content-Type": "application/json",
          // Otto requires the caller to stamp the request; it uses it to order
          // two updates of the same SKU that arrive together.
          "X-Request-Timestamp": new Date().toISOString(),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw await readError(res, "send the products");

      // 202 with a progress document, not a ticket: there is no id to poll, so
      // the batch id is the moment it was sent and the status feed is asked
      // what changed since. The engine drops verdicts this batch never sent.
      return { batchId: String(Date.now()), settled };
    },

    async poll(ctx) {
      const conn = await connect(ctx, "listing");
      const since = Number(ctx.batchId);
      if (!Number.isFinite(since)) return [];

      const url = new URL(`${conn.host}/v5/products/marketplace-status`);
      // A second earlier: Otto stamps `lastModified` itself, and a boundary
      // that excluded what was just sent would report it pending for ever.
      url.searchParams.set("fromDate", new Date(since - 1000).toISOString());
      url.searchParams.set("limit", "100");

      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, "read the listing statuses");
      const body = (await res.json()) as { marketPlaceStatus?: Record<string, unknown>[] };
      const out: ListingVerdict[] = [];
      for (const raw of body.marketPlaceStatus ?? []) {
        const sku = text(raw.sku);
        if (!sku) continue;
        const errors = (Array.isArray(raw.errors) ? raw.errors : [])
          .map((e) => (typeof e === "string" ? e : text((e as Record<string, unknown>).message)))
          .filter((e): e is string => Boolean(e));
        const status = (text(raw.status) ?? "").toUpperCase();
        if (errors.length > 0) {
          out.push({ reference: sku, status: "rejected", errors });
        } else if (status === "ONLINE") {
          // The MOIN is Otto's own id for the article, and it only exists once
          // the product does.
          out.push({ reference: sku, status: "accepted", externalId: text(raw.moin) ?? sku });
        } else {
          out.push({ reference: sku, status: "pending" });
        }
      }
      return out;
    },
  },
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  host: string;
  token: string;
}

/**
 * Otto mints a token from a partner username and password.
 *
 * One per invocation, like Amazon's LWA token. There is deliberately no
 * cross-invocation cache: it would be a module-level map keyed by somebody's
 * password, which is a worse thing to own than one extra request per run.
 */
const connect = async (
  ctx: { str(k: string): string | null; fetch: (u: string, i?: RequestInit) => Promise<Response> },
  what: string,
): Promise<Connection> => {
  const environment = ctx.str("environment");
  const host = HOSTS[(environment ?? "") as Environment] ?? HOSTS.production;
  const username = ctx.str("username");
  const password = ctx.str("password");
  if (!username || !password) throw new Error(`Otto ${what} has no partner username and password`);

  const res = await ctx.fetch(`${host}/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "password", username, password, client_id: "token-otto-api" }).toString(),
  });
  if (!res.ok) {
    // Deliberately does NOT quote the response: this is the one call whose body
    // carries the partner's password.
    throw new Error("Otto refused the partner credentials — check the username and password");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const token = text(body.access_token);
  if (!token) throw new Error("Otto returned no access token");
  return { host, token };
};

const headersFor = (conn: Connection): Record<string, string> => ({
  Authorization: `Bearer ${conn.token}`,
  Accept: "application/json",
});

const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { errors?: { title?: string; detail?: string }[]; title?: string; detail?: string };
    const first = body.errors?.[0];
    detail = (first?.detail ?? first?.title ?? body.detail ?? body.title ?? detail).slice(0, 200);
  } catch {
    // Not JSON — the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`Otto refused the request and could not ${what} — check the partner credentials${detail ? `: ${detail}` : ""}`);
  }
  return new Error(`Otto responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

// ── The taxonomy ─────────────────────────────────────────────────────────────

/**
 * Every category group, walked to the end.
 *
 * Paged, and enumerable — which is the whole reason Otto can list where Allegro
 * cannot. Bounded by {@link MAX_CATEGORY_PAGES} so a paging bug cannot turn a
 * form into an unbounded walk.
 */
const categoryGroups = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_CATEGORY_PAGES; page += 1) {
    const url = new URL(`${conn.host}/v5/products/categories`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(CATEGORY_PAGE));
    const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
    if (!res.ok) throw await readError(res, "read the categories");
    const body = (await res.json()) as { categoryGroups?: Record<string, unknown>[] };
    const groups = Array.isArray(body.categoryGroups) ? body.categoryGroups : [];
    out.push(...groups);
    if (groups.length < CATEGORY_PAGE) break;
  }
  return out;
};

// ── Orders ───────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : 7;
};

/** Cursor is `<sinceMs>|<opaque next cursor>`. */
const readSince = (cursor: string | null, lookbackDays: number): number => {
  if (cursor) {
    const n = Number(cursor.split("|")[0]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now() - lookbackDays * DAY_MS;
};

const readNextCursor = (cursor: string | null): string | null => {
  if (!cursor) return null;
  const rest = cursor.slice(cursor.indexOf("|") + 1);
  return cursor.includes("|") && rest ? rest : null;
};

/** Otto pages by an opaque `nextcursor` carried on a link relation. */
const nextLink = (links: Record<string, unknown>[] | undefined): string | null => {
  for (const link of links ?? []) {
    if (text(link.rel) !== "next") continue;
    const href = text(link.href);
    if (!href) continue;
    try {
      return new URL(href, "https://api.otto.market").searchParams.get("nextcursor");
    } catch {
      return null;
    }
  }
  return null;
};

const orderData = (o: Record<string, unknown>): Record<string, unknown> => {
  const address = (o.deliveryAddress ?? {}) as Record<string, unknown>;
  const lifecycle = (o.orderLifecycleInformation ?? {}) as Record<string, unknown>;
  return {
    salesOrderId: text(o.salesOrderId),
    orderNumber: text(o.orderNumber),
    orderDate: text(o.orderDate),
    lastModifiedDate: text(o.lastModifiedDate),
    lifecycleStatus: text(lifecycle.orderStatus),
    firstName: text(address.firstName),
    lastName: text(address.lastName),
    street: text(address.street),
    houseNumber: text(address.houseNumber),
    addition: text(address.addition),
    city: text(address.city),
    zipCode: text(address.zipCode),
    countryCode: text(address.countryCode),
    suspectedFraudCase: o.suspectedFraudCase === true,
  };
};

const positionData = (p: Record<string, unknown>): Record<string, unknown> => {
  const product = (p.product ?? {}) as Record<string, unknown>;
  const price = (p.itemValueGrossPrice ?? {}) as Record<string, unknown>;
  const tracking = (p.trackingInfo ?? {}) as Record<string, unknown>;
  return {
    positionItemId: text(p.positionItemId),
    sku: text(product.sku),
    ean: text(product.ean),
    title: text(product.title),
    articleNumber: text(product.articleNumber),
    fulfillmentStatus: text(p.fulfillmentStatus),
    unitPrice: num(price.amount),
    currency: text(price.currency),
    sentDate: text(p.sentDate),
    trackingNumber: text(tracking.trackingNumber),
    carrier: text(tracking.carrier),
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

const splitList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((v) => text(v) ?? "").filter(Boolean);
  const s = text(raw);
  if (!s) return [];
  return s
    .split(/[\n,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
};

const splitLines = (raw: unknown): string[] => {
  const s = text(raw);
  if (!s) return [];
  return s
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
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
