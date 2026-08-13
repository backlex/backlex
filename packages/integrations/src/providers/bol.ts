import { defineProvider } from "../provider";

/**
 * bol.com — the Netherlands and Belgium, and the marketplace that is NOT a
 * listing.
 *
 * Its whole contract is public, and finding it is the first lesson: the
 * guessable `…/Retailer-API/v10/retailer.json` is a 404, and the real path is
 * the `spec-url` sitting inside the redoc viewer page at
 * `api.bol.com/retailer/public/redoc/v10/retailer.html`. Read the viewer to find
 * the spec.
 *
 * **It has no `listing`, and that is the finding rather than a gap.** Creating
 * an offer here is `{ean, condition, pricing, stock, fulfilment}` — no category,
 * no attributes, no title, no description, no images. You are not putting a
 * product on sale at bol.com; you are adding an OFFER against a product already
 * in bol's own catalogue. That is destination-shaped, and it is exactly the call
 * Hepsiburada's `fastlisting` got for the same reason. So this provider mirrors
 * price and stock OUT, brings orders IN, and reports a shipment back.
 *
 * Four things shape the code:
 *
 * **A vendor media type on every request** — `application/vnd.retailer.v10+json`,
 * on both `Accept` and `Content-Type`. The second marketplace here to want one,
 * after Allegro.
 *
 * **The token is client-credentials, minted here.** `POST login.bol.com/token`
 * with HTTP Basic and no body — and it must say `Content-Length: 0`, because
 * without it bol's edge answers **411** rather than anything about credentials.
 * Verified by probe: bad credentials give `401 {"error":"invalid_client"}`.
 * There is no consent screen and nobody to redirect, so no `oauth` block.
 *
 * **Every write is asynchronous.** Price, stock and shipment all answer `202`
 * with a `ProcessStatus`, so a `2xx` here means "accepted", never "applied".
 * The push reports what it handed over and says so rather than implying the
 * price is live.
 *
 * **The order list is a summary.** `GET /retailer/orders` returns
 * `ReducedOrder` — ids, EANs, quantities and statuses, but no address. The
 * address is a second call per order, which is why the page is what it is.
 */

const API = "https://api.bol.com";
const LOGIN = "https://login.bol.com/token";

/** bol's own media type, on both headers of every API call. */
const MEDIA = "application/vnd.retailer.v10+json";

/**
 * Orders whose full detail one run will fetch.
 *
 * bol's own page is 50, but each order costs a SECOND request for its address —
 * so a page of fifty is fifty-one calls. Twenty-five is a run that finishes
 * inside a Worker invocation's subrequest budget; the next run resumes.
 */
const ORDERS_PAGE = 25;

/**
 * Rows per push.
 *
 * Each one is up to TWO calls (price and stock are separate endpoints), so the
 * engine's default batch would be hundreds of subrequests.
 */
const PUSH_BATCH = 40;

const DAY_MS = 86_400_000;

export const bol = defineProvider({
  id: "bol",
  label: "bol.com",
  category: "marketplace",
  capabilities: ["source", "destination", "task"],
  // No `oauth` block: the token is client-credentials, so there is no consent
  // screen and nobody to redirect. Same call Otto, UPS and Amazon got.
  configFields: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
  ],

  source: {
    childGroups: [{ key: "lines", label: "Order items" }],
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
        key: "fulfilmentMethod",
        label: "Fulfilment",
        options: [
          { value: "ALL", label: "Both" },
          { value: "FBR", label: "Fulfilled by me (FBR)" },
          { value: "FBB", label: "Fulfilled by bol.com (FBB)" },
        ],
      },
      {
        key: "status",
        label: "Which orders",
        options: [
          { value: "ALL", label: "Open and shipped" },
          { value: "OPEN", label: "Open only" },
          { value: "SHIPPED", label: "Shipped only" },
        ],
      },
    ],
    async pull(ctx) {
      const conn = await connect(ctx, "sync");
      const since = readSince(ctx.cursor, readLookbackDays(ctx.setting("lookbackDays")));
      const page = readPage(ctx.cursor);

      const url = new URL(`${API}/retailer/orders`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("fulfilment-method", ctx.setting("fulfilmentMethod") ?? "ALL");
      url.searchParams.set("status", ctx.setting("status") ?? "ALL");
      // A DATE, not a timestamp — bol filters on the day an order item last
      // changed. So the window is coarser than every other marketplace here,
      // and a run re-reads the whole day rather than the minute.
      url.searchParams.set("latest-change-date", new Date(since).toISOString().slice(0, 10));

      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, "read the orders");
      const body = (await res.json()) as { orders?: Record<string, unknown>[] };
      const summaries = (body.orders ?? []).slice(0, ORDERS_PAGE);

      const records = [];
      for (const summary of summaries) {
        const orderId = text(summary.orderId);
        if (!orderId) continue;
        // The list carries no address at all, so the row an operator can act on
        // needs a second call. This is the N+1 that sets ORDERS_PAGE.
        const detail = await readOrder(ctx, conn, orderId);
        const items = Array.isArray(detail?.orderItems)
          ? (detail!.orderItems as Record<string, unknown>[])
          : (Array.isArray(summary.orderItems) ? (summary.orderItems as Record<string, unknown>[]) : []);
        records.push({
          externalId: orderId,
          data: orderData(orderId, summary, detail),
          children: {
            lines: items.map((it, i) => ({
              externalId: text(it.orderItemId) ?? String(i + 1),
              data: itemData(it),
            })),
          },
        });
      }

      // bol pages by number and stops answering when a page is short.
      const more = (body.orders ?? []).length >= ORDERS_PAGE;
      return {
        records,
        cursor: more ? `${since}:${page + 1}` : null,
        complete: !more,
        ...(more ? {} : { resumeAt: Date.now() }),
      };
    },
  },

  destination: {
    // Two calls per row at worst, so the engine's default batch would be
    // hundreds of subrequests.
    batchSize: PUSH_BATCH,
    settingFields: [
      {
        key: "fulfilmentParty",
        label: "Whose stock this is",
        options: [
          { value: "retailer", label: "Mine (FBR)" },
          { value: "bol", label: "bol.com's (FBB)" },
        ],
      },
    ],
    /**
     * The closed set, and it is short on purpose.
     *
     * An offer's descriptive half belongs to bol's catalogue, not to the
     * seller — which is the whole reason this is a destination. What a seller
     * owns is the price and the stock.
     */
    columns: [
      { value: "offerId", label: "bol.com offer ID" },
      { value: "price", label: "Unit price" },
      { value: "stock", label: "Stock quantity" },
    ],
    async push(ctx) {
      const conn = await connect(ctx, "push");
      const party = ctx.setting("fulfilmentParty") === "bol" ? "bol" : "retailer";
      let written = 0;

      for (const row of ctx.rows) {
        const offerId = text(row.offerId);
        // An offer id is bol's, and there is nothing sensible to do without
        // one — a row missing it is skipped rather than guessed at.
        if (!offerId || !/^[A-Za-z0-9-]{1,64}$/.test(offerId)) continue;

        const price = num(row.price);
        if (price !== null) {
          const res = await ctx.fetch(`${API}/retailer/offers/${encodeURIComponent(offerId)}/price`, {
            method: "PUT",
            headers: { ...headersFor(conn), "Content-Type": MEDIA },
            // A single-unit bundle: bol prices by quantity band, and one band
            // of one is what "the price of this offer" means.
            body: JSON.stringify({ pricing: { bundlePrices: [{ quantity: 1, unitPrice: price }] } }),
          });
          if (!res.ok) throw await readError(res, `price offer ${offerId}`);
        }

        const stock = num(row.stock);
        if (stock !== null) {
          const res = await ctx.fetch(`${API}/retailer/offers/${encodeURIComponent(offerId)}/stock`, {
            method: "PUT",
            headers: { ...headersFor(conn), "Content-Type": MEDIA, "X-Fulfilment-Party": party },
            body: JSON.stringify({ amount: Math.max(0, Math.round(stock)), managedByRetailer: party === "retailer" }),
          });
          if (!res.ok) throw await readError(res, `stock offer ${offerId}`);
        }

        if (price !== null || stock !== null) written += 1;
      }

      // Every write here answers 202 with a process id: bol has ACCEPTED them,
      // not applied them. Nothing is returned because the contract has nothing
      // to return — the engine counts the rows it handed over.
      void written;
    },
  },

  tasks: [
    {
      id: "ship_order",
      label: "Report a shipment",
      settingFields: [
        { key: "orderItemIdsField", label: "Order item IDs column", placeholder: "marketplace_item_ids" },
        { key: "transporterField", label: "Transporter code column", placeholder: "carrier_code" },
        { key: "trackingField", label: "Track & trace column", placeholder: "tracking_number" },
      ],
      outputs: [
        { key: "processStatusId", label: "bol.com process ID" },
        { key: "reportedItems", label: "Items reported" },
        { key: "shippedAt", label: "Reported at" },
      ],
      async run(ctx) {
        const conn = await connect(ctx, "task");
        const ids = splitList(ctx.row[ctx.setting("orderItemIdsField") ?? ""]);
        if (ids.length === 0) throw new Error("The row names no bol.com order item ids to report as shipped");
        const transporterCode = required(ctx, "transporterField", "transporter code");
        const trackAndTrace = required(ctx, "trackingField", "track & trace code");

        const res = await ctx.fetch(`${API}/retailer/shipments`, {
          method: "POST",
          headers: { ...headersFor(conn), "Content-Type": MEDIA },
          body: JSON.stringify({
            orderItems: ids.map((orderItemId) => ({ orderItemId })),
            // Stable across every retry of this triple, so a retry that bol
            // does see reads as the same shipment rather than a second one.
            shipmentReference: ctx.idempotencyKey.slice(0, 40),
            transport: { transporterCode, trackAndTrace },
          }),
        });
        if (!res.ok) throw await readError(res, "report the shipment");
        const body = (await res.json().catch(() => ({}))) as { processStatusId?: unknown };
        return {
          outputs: {
            processStatusId: text(body.processStatusId),
            reportedItems: ids.length,
            shippedAt: Date.now(),
          },
        };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  token: string;
}

/**
 * Mint a client-credentials token.
 *
 * One per invocation, like Otto's and Amazon's. `Content-Length: 0` is not
 * optional decoration: bol's edge answers **411 Bad Request** to a POST with no
 * body and no length, which reads like an outage rather than a malformed
 * request. Probed to be sure — with the header, bad credentials answer
 * `401 {"error":"invalid_client"}`.
 */
const connect = async (
  ctx: { str(k: string): string | null; fetch: (u: string, i?: RequestInit) => Promise<Response> },
  what: string,
): Promise<Connection> => {
  const clientId = ctx.str("clientId");
  const clientSecret = ctx.str("clientSecret");
  if (!clientId || !clientSecret) throw new Error(`bol.com ${what} has no client id and secret`);

  const res = await ctx.fetch(`${LOGIN}?grant_type=client_credentials`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      Accept: "application/json",
      "Content-Length": "0",
    },
  });
  if (!res.ok) {
    // Deliberately does NOT quote the response: this is the call that carries
    // the client secret.
    throw new Error("bol.com refused the client credentials — check the client id and secret in the retailer portal");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const token = text(body.access_token);
  if (!token) throw new Error("bol.com returned no access token");
  return { token };
};

const headersFor = (conn: Connection): Record<string, string> => ({
  Authorization: `Bearer ${conn.token}`,
  Accept: MEDIA,
});

/**
 * bol's errors are RFC 7807 `Problem` documents: `{type, title, status, detail,
 * violations:[{name, reason}]}`.
 *
 * A violation names the FIELD, which "Bad Request" does not, so the first one
 * is quoted when there is one.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as {
      detail?: string;
      title?: string;
      violations?: { name?: string; reason?: string }[];
    };
    const v = body.violations?.[0];
    detail = (v ? `${v.name ?? "field"}: ${v.reason ?? ""}`.trim() : (body.detail ?? body.title ?? detail)).slice(0, 200);
  } catch {
    // Not JSON — bol's edge answers HTML on a 411 and on some gateway faults,
    // and the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`bol.com refused the request and could not ${what} — the token may have expired${detail ? `: ${detail}` : ""}`);
  }
  return new Error(`bol.com responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

// ── Orders ───────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : 7;
};

/** Cursor is `<sinceMs>:<page>` — the window travels with the page number. */
const readSince = (cursor: string | null, lookbackDays: number): number => {
  if (cursor) {
    const n = Number(cursor.split(":")[0]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now() - lookbackDays * DAY_MS;
};

const readPage = (cursor: string | null): number => {
  if (!cursor) return 1;
  const n = Number(cursor.split(":")[1]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/** The full order, for its address. `null` when bol will not give it — the
 *  summary is still worth importing, so this degrades rather than failing. */
const readOrder = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  orderId: string,
): Promise<Record<string, unknown> | null> => {
  const res = await ctx.fetch(`${API}/retailer/orders/${encodeURIComponent(orderId)}`, {
    headers: headersFor(conn),
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
};

const orderData = (
  orderId: string,
  summary: Record<string, unknown>,
  detail: Record<string, unknown> | null,
): Record<string, unknown> => {
  const ship = (detail?.shipmentDetails ?? {}) as Record<string, unknown>;
  const bill = (detail?.billingDetails ?? {}) as Record<string, unknown>;
  return {
    orderId,
    orderPlacedDateTime: text(summary.orderPlacedDateTime) ?? text(detail?.orderPlacedDateTime),
    pickupPoint: detail?.pickupPoint === true,
    firstName: text(ship.firstName),
    surname: text(ship.surname),
    email: text(ship.email),
    company: text(ship.company),
    streetName: text(ship.streetName),
    houseNumber: text(ship.houseNumber),
    houseNumberExtension: text(ship.houseNumberExtension),
    zipCode: text(ship.zipCode),
    city: text(ship.city),
    countryCode: text(ship.countryCode),
    deliveryPhoneNumber: text(ship.deliveryPhoneNumber),
    billingFirstName: text(bill.firstName),
    billingSurname: text(bill.surname),
    billingZipCode: text(bill.zipCode),
  };
};

const itemData = (it: Record<string, unknown>): Record<string, unknown> => {
  const product = (it.product ?? {}) as Record<string, unknown>;
  const offer = (it.offer ?? {}) as Record<string, unknown>;
  return {
    orderItemId: text(it.orderItemId),
    // bol identifies a product by EAN — there is no seller SKU on the order.
    ean: text(it.ean) ?? text(product.ean),
    title: text(product.title),
    offerId: text(offer.offerId),
    offerReference: text(offer.reference),
    fulfilmentMethod: text(it.fulfilmentMethod),
    fulfilmentStatus: text(it.fulfilmentStatus),
    quantity: num(it.quantity),
    quantityShipped: num(it.quantityShipped),
    quantityCancelled: num(it.quantityCancelled),
    cancellationRequest: it.cancellationRequest === true,
    unitPrice: num(it.unitPrice),
    latestChangedDateTime: text(it.latestChangedDateTime),
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
