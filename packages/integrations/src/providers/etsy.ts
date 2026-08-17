import { defineProvider } from "../provider";

/**
 * Etsy — orders in, stock and price out, a tracking number back.
 *
 * The same three-part shape every marketplace here has, against Etsy's Open API
 * v3. The whole contract is public: `etsy.com/openapi/generated/oas/3.0.0.json`
 * is OpenAPI 3.0.2, 76 paths, served to an ordinary GET, and every field name
 * below was read out of it rather than remembered.
 *
 * That is worth saying because the roadmap had Etsy filed under "waiting on
 * account approval", from a probe that got a 403. A seller account is needed to
 * make live calls — it is not needed to know what a call looks like, and those
 * are different blockers. The same mistake nearly skipped DHL Express.
 *
 * ## Two credentials that are the same string
 *
 * Etsy wants BOTH an OAuth bearer token and an `x-api-key` header on every v3
 * request, and the `x-api-key` value is the app's keystring — which is also the
 * OAuth client id. So this provider reads one field and sends it twice rather
 * than asking an operator to paste the same value into two boxes and wonder
 * which is which.
 *
 * The spec's own description of that header says to send
 * `keystring:shared_secret`, which is wrong and would fail every request; the
 * keystring alone is what v3 accepts. Recorded here because it is the kind of
 * thing that costs an afternoon.
 *
 * ## Why the shop id is a config field and not discovered
 *
 * `getShop` would resolve it, but every operation below is addressed by
 * `shop_id` and a wrong one is answered with an empty list rather than an
 * error — an integration that silently syncs nothing. Asking for it once, at
 * connect time, makes the failure a form error instead.
 */

const API = "https://openapi.etsy.com";

/** Receipts read per page. Etsy caps `limit` at 100; this is well under it
 *  because each receipt carries its own transactions inline, so a page is
 *  already a large body. */
const RECEIPTS_PAGE = 50;

/** Rows per destination batch. One PUT per row, and the inventory endpoint is
 *  one of the slower ones — the engine's default batch would time out. */
const PUSH_BATCH = 25;

const DAY_MS = 86_400_000;

const text = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * Etsy money is `{amount, divisor, currency_code}` — minor units with an
 * explicit divisor rather than a fixed two decimal places, because it also
 * carries currencies that do not have two.
 */
const money = (v: unknown): number | null => {
  const m = v as { amount?: unknown; divisor?: unknown } | null;
  const amount = num(m?.amount);
  const divisor = num(m?.divisor);
  if (amount === null || !divisor) return null;
  return amount / divisor;
};

const currency = (v: unknown): string | null =>
  text((v as { currency_code?: unknown } | null)?.currency_code);

interface Connection {
  shopId: string;
  headers: Record<string, string>;
}

const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const token = ctx.str("_oauthAccessToken");
  if (!token) throw new Error(`Etsy ${what} is not connected — finish the OAuth consent first`);
  // The OAuth client id IS the keystring the `x-api-key` header wants.
  const keystring = ctx.str("clientId");
  if (!keystring) throw new Error(`Etsy ${what} has no app keystring`);
  const shopId = ctx.str("shopId");
  if (!shopId || !/^\d+$/.test(shopId)) {
    throw new Error(`Etsy ${what} needs the numeric shop id — find it on your shop's Etsy URL`);
  }
  return {
    shopId,
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-key": keystring,
      accept: "application/json",
    },
  };
};

/**
 * Etsy's errors are `{error: "..."}` — one string, sometimes with the field
 * name inside it. There is no structured field list to pull out, so the string
 * is surfaced as-is rather than reformatted into a shape it does not have.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { error?: unknown; error_description?: unknown };
    detail = (text(body.error_description) ?? text(body.error) ?? detail).slice(0, 200);
  } catch {
    // Not JSON — a gateway in front of the API answers HTML on some failures.
  }
  if (res.status === 401) {
    return new Error(
      "Etsy rejected the token — reconnect the integration, and check the app still has the scopes it was granted",
    );
  }
  if (res.status === 403) {
    return new Error(`Etsy refused the request${detail ? `: ${detail}` : ""} — the app may lack the scope this needs`);
  }
  if (res.status === 404) {
    return new Error(`Etsy has no such shop or receipt and could not ${what}`);
  }
  return new Error(`Etsy responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

/** `<since-ms>:<offset>` — the window start and how far into it we are. */
const readSince = (cursor: string | null | undefined, lookbackDays: number): number => {
  const at = (cursor ?? "").indexOf(":");
  const raw = at === -1 ? cursor : (cursor ?? "").slice(0, at);
  const n = num(raw);
  return n && n > 0 ? n : Date.now() - lookbackDays * DAY_MS;
};

const readOffset = (cursor: string | null | undefined): number => {
  const at = (cursor ?? "").indexOf(":");
  const n = at === -1 ? null : num((cursor ?? "").slice(at + 1));
  return n && n > 0 ? n : 0;
};

const readLookbackDays = (raw: string | null): number => {
  const n = num(raw);
  return n && n > 0 ? n : 7;
};

/** One receipt, flattened to the columns an operator would want on the row. */
const receiptData = (r: Record<string, unknown>): Record<string, unknown> => ({
  receiptId: text(r.receipt_id),
  status: text(r.status),
  buyerName: text(r.name),
  buyerEmail: text(r.buyer_email),
  addressLine1: text(r.first_line),
  addressLine2: text(r.second_line),
  city: text(r.city),
  state: text(r.state),
  zip: text(r.zip),
  countryCode: text(r.country_iso),
  formattedAddress: text(r.formatted_address),
  messageFromBuyer: text(r.message_from_buyer),
  isPaid: r.is_paid === true,
  isShipped: r.is_shipped === true,
  isGift: r.is_gift === true,
  giftMessage: text(r.gift_message),
  total: money(r.grandtotal),
  currency: currency(r.grandtotal),
  subtotal: money(r.subtotal),
  shippingCost: money(r.total_shipping_cost),
  taxCost: money(r.total_tax_cost),
  discount: money(r.discount_amt),
  paymentMethod: text(r.payment_method),
  // Etsy sends both `create_timestamp` and `created_timestamp` with the same
  // value — a v3 rename it kept both halves of. Either is fine; the newer name
  // is preferred so a future removal of the old one changes nothing here.
  createdAt: num(r.created_timestamp) ?? num(r.create_timestamp),
  updatedAt: num(r.updated_timestamp) ?? num(r.update_timestamp),
});

/** One transaction — Etsy's word for a line on the receipt. */
const transactionData = (t: Record<string, unknown>): Record<string, unknown> => ({
  transactionId: text(t.transaction_id),
  listingId: text(t.listing_id),
  productId: text(t.product_id),
  sku: text(t.sku),
  title: text(t.title),
  quantity: num(t.quantity),
  price: money(t.price),
  currency: currency(t.price),
  shippingCost: money(t.shipping_cost),
  isDigital: t.is_digital === true,
  expectedShipDate: num(t.expected_ship_date),
});

export const etsy = defineProvider({
  id: "etsy",
  label: "Etsy",
  category: "marketplace",
  capabilities: ["source", "destination", "task"],
  /**
   * Etsy's published limit is 10 requests/second and 10,000/day per app. The
   * per-second figure is the one a bucket can hold to; the daily one is a quota
   * this cannot enforce, and the 429 is the real guarantee — the engine reads
   * it as busy rather than broken, so a sync that runs out resumes tomorrow
   * instead of tripping the breaker.
   */
  limits: { rps: 5, burst: 10 },
  oauth: {
    authorizeUrl: "https://www.etsy.com/oauth/connect",
    tokenUrl: `${API}/v3/public/oauth/token`,
    /**
     * Read scopes for the sync, write scopes for the two things this provider
     * pushes back. `transactions_w` is what `submit_tracking` needs — without
     * it the call 403s with a message about the app rather than the receipt.
     */
    scopes: ["transactions_r", "transactions_w", "listings_r", "listings_w", "shops_r"],
    // Required, not optional: Etsy's v3 authorization-code flow rejects a
    // request with no `code_challenge`.
    pkce: true,
    tokenAuth: "body",
  },
  configFields: [
    { key: "clientId", label: "App keystring", placeholder: "from your app on etsy.com/developers/your-apps" },
    { key: "clientSecret", label: "App shared secret", secret: true },
    {
      key: "shopId",
      label: "Shop ID",
      placeholder: "the numeric id, not the shop name",
    },
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
        key: "which",
        label: "Which orders",
        options: [
          { value: "all", label: "Everything" },
          { value: "unshipped", label: "Paid but not shipped" },
        ],
      },
    ],
    async pull(ctx) {
      const conn = readConnection(ctx, "sync");
      const since = readSince(ctx.cursor, readLookbackDays(ctx.setting("lookbackDays")));
      const offset = readOffset(ctx.cursor);

      const url = new URL(`${API}/v3/application/shops/${conn.shopId}/receipts`);
      url.searchParams.set("limit", String(RECEIPTS_PAGE));
      url.searchParams.set("offset", String(offset));
      // SECONDS, not milliseconds — Etsy's timestamps are epoch seconds
      // throughout, and passing millis asks for orders from the year 57000 and
      // gets an empty list rather than an error.
      url.searchParams.set("min_last_modified", String(Math.floor(since / 1000)));
      url.searchParams.set("sort_on", "updated");
      url.searchParams.set("sort_order", "asc");
      if (ctx.setting("which") === "unshipped") {
        url.searchParams.set("was_paid", "true");
        url.searchParams.set("was_shipped", "false");
      }

      const res = await ctx.fetch(url.toString(), { headers: conn.headers });
      if (!res.ok) throw await readError(res, "read the orders");
      const body = (await res.json()) as { count?: number; results?: Record<string, unknown>[] };
      const results = body.results ?? [];

      const records = [];
      for (const r of results) {
        const receiptId = text(r.receipt_id);
        if (!receiptId) continue;
        // Transactions ride along on the receipt, so there is no N+1 here —
        // unlike bol.com, whose list carries no address at all.
        const lines = Array.isArray(r.transactions) ? (r.transactions as Record<string, unknown>[]) : [];
        records.push({
          externalId: receiptId,
          data: receiptData(r),
          children: {
            lines: lines.map((t, i) => ({
              externalId: text(t.transaction_id) ?? `${receiptId}-${i + 1}`,
              data: transactionData(t),
            })),
          },
        });
      }

      // Etsy pages by offset and reports the full `count`, so "is there more"
      // is answerable without a short-page heuristic.
      const more = offset + results.length < (num(body.count) ?? 0) && results.length > 0;
      return {
        records,
        cursor: more ? `${since}:${offset + results.length}` : null,
        complete: !more,
        ...(more ? {} : { resumeAt: Date.now() }),
      };
    },
  },

  destination: {
    batchSize: PUSH_BATCH,
    settingFields: [
      {
        key: "addresses",
        /**
         * A safety choice, not a preference.
         *
         * Etsy's inventory PUT replaces the WHOLE listing, so a row that names
         * only a listing has to say what it means for a listing with five
         * variations. "The whole listing" writes the same quantity and price
         * onto every one of them, which is right for a single-variation
         * listing and destructive for anything else. "One variation" refuses a
         * row with no product id rather than guessing — the safer half, and
         * the default.
         */
        label: "Each row addresses",
        options: [
          { value: "variation", label: "One variation (needs a Product ID)" },
          { value: "listing", label: "The whole listing (every variation)" },
        ],
      },
    ],
    /**
     * Deliberately short. A listing's descriptive half — title, photos,
     * materials, the shop's own voice — belongs on Etsy, which is why this is
     * a destination and not a mirror. What a seller owns here is how many
     * there are and what they cost.
     */
    columns: [
      { value: "listingId", label: "Etsy listing ID" },
      { value: "productId", label: "Product (variation) ID" },
      { value: "quantity", label: "Stock quantity" },
      { value: "price", label: "Unit price" },
    ],
    async push(ctx) {
      const conn = readConnection(ctx, "push");
      // Defaults to the narrow reading — an unset setting must not be the
      // destructive one.
      const wholeListing = ctx.setting("addresses") === "listing";

      for (const row of ctx.rows) {
        const listingId = text(row.listingId);
        if (!listingId || !/^\d+$/.test(listingId)) continue;
        const quantity = num(row.quantity);
        const price = num(row.price);
        if (quantity === null && price === null) continue;

        // Etsy replaces the WHOLE inventory on a PUT, so the current one has to
        // be read first and edited. Writing a bare product would delete every
        // other variation on the listing — the destructive half of an endpoint
        // that looks like a patch.
        const current = await ctx.fetch(
          `${API}/v3/application/listings/${listingId}/inventory`,
          { headers: conn.headers },
        );
        if (!current.ok) throw await readError(current, `read the inventory for listing ${listingId}`);
        const inv = (await current.json()) as { products?: Record<string, unknown>[] };
        const products = Array.isArray(inv.products) ? inv.products : [];
        if (products.length === 0) continue;

        const productId = text(row.productId);
        // Refusing beats guessing: without a product id, "one variation" has
        // no way to know which of five it meant, and writing all five is the
        // outcome this setting exists to prevent.
        if (wholeListing === false && !productId) continue;
        const next = products.map((p) => {
          const offerings = Array.isArray(p.offerings) ? (p.offerings as Record<string, unknown>[]) : [];
          const mine = wholeListing || text(p.product_id) === productId;
          return {
            sku: text(p.sku) ?? "",
            property_values: p.property_values ?? [],
            offerings: offerings.map((o) => ({
              quantity: mine && quantity !== null ? quantity : (num(o.quantity) ?? 0),
              // Etsy takes the price back as a plain decimal on write even
              // though it hands it out as minor units with a divisor.
              price: mine && price !== null ? price : (money(o.price) ?? 0),
              is_enabled: o.is_enabled !== false,
            })),
          };
        });

        const res = await ctx.fetch(`${API}/v3/application/listings/${listingId}/inventory`, {
          method: "PUT",
          headers: { ...conn.headers, "content-type": "application/json" },
          body: JSON.stringify({ products: next }),
        });
        if (!res.ok) throw await readError(res, `update the inventory for listing ${listingId}`);
      }
    },
  },

  tasks: [
    {
      id: "submit_tracking",
      label: "Submit tracking",
      /**
       * NOT repeatable. Etsy treats this as marking the receipt shipped and
       * mails the buyer; sending it twice sends a second notification about a
       * parcel already announced.
       */
      settingFields: [
        {
          key: "receiptIdField",
          label: "Receipt ID field",
          placeholder: "the row field the sync wrote, e.g. receiptId",
        },
        {
          key: "trackingCodeField",
          label: "Tracking number field",
          placeholder: "e.g. carrier_shipment_id",
        },
        {
          key: "carrierNameField",
          label: "Carrier name field",
          placeholder: "the row field holding Etsy's carrier name, e.g. carrier",
        },
        {
          key: "notifyBuyer",
          label: "Email the buyer",
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        },
      ],
      outputs: [
        { key: "receiptId", label: "Receipt ID" },
        { key: "trackingCode", label: "Tracking number" },
        { key: "carrierName", label: "Carrier" },
        { key: "shipmentStatus", label: "Marketplace status" },
        { key: "submittedAt", label: "Submitted at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const rowValue = (key: string, what: string): string => {
          const field = ctx.setting(key);
          if (!field) throw new Error(`Etsy tracking needs the row field holding the ${what}`);
          const value = text(ctx.row[field]);
          if (!value) throw new Error(`Row field "${field}" holds no ${what}`);
          return value;
        };
        const receiptId = rowValue("receiptIdField", "receipt id");
        const trackingCode = rowValue("trackingCodeField", "tracking number");
        // Etsy matches this against its own carrier list and refuses anything
        // else, so it is the row's value rather than something invented here.
        const carrierName = rowValue("carrierNameField", "carrier name");

        const form = new URLSearchParams({
          tracking_code: trackingCode,
          carrier_name: carrierName,
          send_bcc: ctx.setting("notifyBuyer") === "no" ? "false" : "true",
        });

        const res = await ctx.fetch(
          `${API}/v3/application/shops/${conn.shopId}/receipts/${encodeURIComponent(receiptId)}/tracking`,
          {
            method: "POST",
            headers: { ...conn.headers, "content-type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          },
        );
        if (!res.ok) throw await readError(res, "submit the tracking number");
        const body = (await res.json()) as Record<string, unknown>;

        return {
          outputs: {
            receiptId,
            trackingCode,
            carrierName,
            // Etsy answers with the whole receipt; `is_shipped` is the half
            // that says whether the submission took.
            shipmentStatus: body.is_shipped === true ? "shipped" : (text(body.status) ?? "submitted"),
            submittedAt: Date.now(),
          },
        };
      },
    },
  ],
});
