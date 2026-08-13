import {
  defineProvider,
  type ListingAttribute,
  type ListingAttributeBinding,
  type ListingCategory,
  type ListingVerdict,
} from "../provider";
import { takeToken } from "../throttle";

/**
 * Amazon Selling Partner API — a seller's orders in, and the shipment
 * confirmation the marketplace expects back.
 *
 * The fifth marketplace and the first one outside Türkiye, which is the point:
 * the three before it fitted the same shape, and this is the test of whether
 * the shape was Turkish or just marketplace-sized. It was marketplace-sized —
 * an order is a header with lines, a confirmation is a task, and neither the
 * engine nor the record model needed anything new.
 *
 * Five things about this API shape the code, and every one of them is a fact
 * the other four marketplaces did not have.
 *
 * **The credential is not the credential.** Every request carries an access
 * token minted from a long-lived LWA refresh token, and it lasts an hour. One
 * is minted per invocation and reused for every request inside it — see
 * {@link accessToken}. There is deliberately no cross-invocation cache: a
 * module-level map keyed by somebody's refresh token is a worse thing to own
 * than one extra request per page, and the strictest endpoint here is limited
 * to a request a minute anyway.
 *
 * **The address is redacted unless you ask properly.** Buyer information and
 * the shipping address are restricted, and reading them needs a Restricted Data
 * Token minted for the exact path and elements — a second token, on top of the
 * first. Since an order without an address is nearly useless to the carrier
 * integration this engine exists to feed, the RDT is requested by default and
 * its refusal is a degradation rather than a failure. See {@link restrictedToken}.
 *
 * **The lines are a second call, per order.** Unlike every marketplace before
 * it, Amazon does not return an order's items with the order. That is an N+1,
 * and it is why the page is capped at {@link ORDERS_PAGE} rather than at the
 * hundred the API would allow: a page of a hundred orders is a hundred and one
 * requests, and `getOrderItems` is limited to two a second.
 *
 * **The rate limits are per operation, and one of them is brutal.** `getOrders`
 * is 0.0167 requests a second — one a minute, burst 20. `getOrderItems` is 0.5,
 * `confirmShipment` 2. A provider-wide limit at the strictest of those would
 * put a minute in front of an operator clicking a button, so each takes its own
 * token from the engine's bucket. See {@link ORDERS_PACE}.
 *
 * **There is still no destination here** — but the reason has changed, and so
 * has the answer. It used to be that an attribute's value shape is defined per
 * product type and is not in the operation reference, so a hand-written payload
 * would be a guess about a seller's own catalogue. That was the right call and
 * it is why this provider shipped without either write path. The follow-up it
 * asked for is the `listing` block below: it READS the product type definition,
 * fetches the JSON Schema the definition links to, and builds every value from
 * it. Price and quantity now travel that way. A separate destination — mirroring
 * price and stock for listings somebody else created — is a different job and
 * is not built.
 *
 * **Variations are not built, deliberately.** Amazon does not mark an attribute
 * as the one that varies, the way Trendyol and n11 do; it wants a parent SKU
 * carrying a `variation_theme` and children pointing at it. So a workspace's
 * variants are listed here as standalone SKUs — correct listings, each on its
 * own page, rather than one page with a size picker. Grouping them is a real
 * feature, not a flag, and it needs the relationship attributes read off the
 * same schema. Said out loud in the docs rather than left to be discovered.
 */

/**
 * Where the API lives, per region. A closed set: never built from input.
 *
 * Amazon groups its marketplaces into three endpoints, and a request for a
 * marketplace outside its endpoint's region is refused — which is why the two
 * are separate fields below rather than one guess.
 */
const HOSTS = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
} as const;

type Region = keyof typeof HOSTS;

/** Login with Amazon's token endpoint. One host, all regions. */
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/**
 * The marketplaces a connection can address, by the id every request carries.
 *
 * A closed set because it reaches a query parameter and because a mistyped
 * marketplace id is answered with an empty page rather than an error — the
 * worst kind of wrong, since a sync would report clean runs for ever.
 */
const MARKETPLACES = [
  { value: "A33AVAJ2PDY3EV", label: "Türkiye (amazon.com.tr)" },
  { value: "ATVPDKIKX0DER", label: "United States" },
  { value: "A2EUQ1WTGCTBG2", label: "Canada" },
  { value: "A1AM78C64UM0Y8", label: "Mexico" },
  { value: "A2Q3Y263D00KWC", label: "Brazil" },
  { value: "A1F83G8C2ARO7P", label: "United Kingdom" },
  { value: "A1PA6795UKMFR9", label: "Germany" },
  { value: "A13V1IB3VIYZZH", label: "France" },
  { value: "APJ6JRA9NG5V4", label: "Italy" },
  { value: "A1RKKUPIHCS9HS", label: "Spain" },
  { value: "A1805IZSGTT6HS", label: "Netherlands" },
  { value: "A2NODRKZP88ZB9", label: "Sweden" },
  { value: "A1C3SOZRARQ6R3", label: "Poland" },
  { value: "A2VIGQ35RCS4UG", label: "United Arab Emirates" },
  { value: "A17E79C6D8DWNP", label: "Saudi Arabia" },
  { value: "A21TJRUUN4KGV", label: "India" },
  { value: "A1VC38T7YXB528", label: "Japan" },
  { value: "A39IBJ37TRP1C6", label: "Australia" },
  { value: "A19VAU5U5O7RUS", label: "Singapore" },
] as const;

/**
 * How many orders one page may carry.
 *
 * Far below the hundred the API allows, because each order costs a second
 * request for its items. A page of a hundred is a hundred and one requests
 * against an endpoint limited to two a second — twenty-five is a run that
 * finishes.
 */
const ORDERS_PAGE = 25;

/**
 * The published pace of the three operations this provider uses.
 *
 * Per operation rather than provider-wide, because they differ by two orders of
 * magnitude: pacing a shipment confirmation at the order list's rate would put
 * a minute in front of a button. Keyed per seller for the same reason the
 * engine's own bucket is — two workspaces holding two sellers' credentials have
 * two independent quotas at Amazon.
 */
const ORDERS_PACE = { rps: 0.0167, burst: 20 } as const;
const ITEMS_PACE = { rps: 0.5, burst: 30 } as const;
const CONFIRM_PACE = { rps: 2, burst: 10 } as const;

/** The widest window a first run reads, and the cap on any one window. */
const MAX_WINDOW_DAYS = 30;
const DEFAULT_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;

/** Mid-run cursor: `c:<windowEnd>:<nextToken>`. Continues THIS run. */
const CURSOR_PREFIX = "c:";
/** A finished window's end, in epoch ms. Starts the NEXT run. */
const RESUME_PREFIX = "t:";

export const amazon = defineProvider({
  id: "amazon",
  label: "Amazon",
  category: "marketplace",
  capabilities: ["source", "task", "listing"],
  /**
   * A modest provider-wide floor. The real pacing is per operation — see
   * {@link ORDERS_PACE} — because Amazon publishes it that way and the spread
   * between the fastest and the slowest is a factor of a hundred.
   */
  limits: { rps: 2, burst: 5 },
  configFields: [
    {
      key: "region",
      label: "Region",
      options: [
        { value: "na", label: "North America" },
        { value: "eu", label: "Europe (incl. Türkiye)" },
        { value: "fe", label: "Far East" },
      ],
    },
    { key: "marketplaceId", label: "Marketplace", options: MARKETPLACES },
    {
      key: "sellerId",
      label: "Seller ID (merchant token)",
      placeholder: "the merchant token from Seller Central → Account Info",
    },
    { key: "clientId", label: "LWA client ID", secret: true },
    { key: "clientSecret", label: "LWA client secret", secret: true },
    { key: "refreshToken", label: "LWA refresh token", secret: true },
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
          { value: "30", label: "Last 30 days (max)" },
        ],
      },
      {
        key: "buyerInfo",
        label: "Buyer name and address",
        options: [
          { value: "request", label: "Request it (needs the PII role)" },
          { value: "skip", label: "Leave it redacted" },
        ],
      },
    ],
    /**
     * One page of orders updated inside the current window, each with its
     * items.
     *
     * The filter is `LastUpdatedAfter`, not `CreatedAfter`, and that is what
     * makes this a mirror rather than a snapshot: an order shipped a week after
     * it was placed comes back into the window on the day it changes. The
     * window therefore advances between runs, exactly as Trendyol's and n11's
     * do, rather than being re-walked as Hepsiburada's must be.
     */
    async pull(ctx) {
      const conn = readConnection(ctx, "sync");
      const token = await accessToken(ctx, conn);
      const cursor = ctx.cursor ?? "";

      const url = new URL(`${conn.host}/orders/v0/orders`);
      url.searchParams.set("MarketplaceIds", conn.marketplaceId);
      url.searchParams.set("MaxResultsPerPage", String(Math.min(ctx.limit, ORDERS_PAGE)));

      // A NextToken already encodes the filters it was opened with, and Amazon
      // refuses a page whose filters changed mid-walk — so the dates are sent
      // on the first request of a window and never again.
      let windowEnd: number | null = null;
      if (cursor.startsWith(CURSOR_PREFIX)) {
        const rest = cursor.slice(CURSOR_PREFIX.length);
        const split = rest.indexOf(":");
        windowEnd = split < 0 ? null : readEpoch(rest.slice(0, split));
        // Amazon's token is opaque and may hold anything, so only the FIRST
        // separator is structure — the remainder is echoed back untouched.
        url.searchParams.set("NextToken", split < 0 ? rest : rest.slice(split + 1));
      } else {
        const now = Date.now();
        const resumeFrom = cursor.startsWith(RESUME_PREFIX) ? readEpoch(cursor.slice(RESUME_PREFIX.length)) : null;
        const start = resumeFrom ?? now - readLookbackDays(ctx.setting("lookbackDays")) * DAY_MS;
        // Clamped both ways: never wider than a window this side will finish,
        // and never past now — an end in the future is a window that can never
        // complete and a resume token that skips whatever lands after it.
        windowEnd = Math.min(start + MAX_WINDOW_DAYS * DAY_MS, now);
        url.searchParams.set("LastUpdatedAfter", new Date(start).toISOString());
        url.searchParams.set("LastUpdatedBefore", new Date(windowEnd).toISOString());
      }

      // The address is restricted. Requesting it needs a token minted for this
      // exact path and these exact elements — and a seller whose application
      // has no PII role gets a refusal, which degrades to a redacted order
      // rather than failing the sync.
      const wantsBuyerInfo = ctx.setting("buyerInfo") !== "skip";
      const orderToken = wantsBuyerInfo ? await restrictedToken(ctx, conn, token) : token;

      await takeToken(`amazon:orders:${conn.sellerId}`, ORDERS_PACE);
      const res = await ctx.fetch(url.toString(), { headers: headersFor(orderToken) });
      if (!res.ok) throw await readError(res, "read the orders");

      const body = (await res.json()) as { payload?: { Orders?: Record<string, unknown>[]; NextToken?: unknown } };
      const orders = body.payload?.Orders ?? [];

      const records: {
        externalId: string;
        data: Record<string, unknown>;
        children: Record<string, { externalId: string; data: Record<string, unknown> }[]>;
      }[] = [];
      for (const order of orders) {
        const id = text(order.AmazonOrderId);
        if (!id) continue;
        records.push({
          externalId: id,
          data: orderData(order),
          children: { lines: await orderItems(ctx, conn, orderToken, id) },
        });
      }

      const next = text(body.payload?.NextToken);
      if (next) return { records, cursor: `${CURSOR_PREFIX}${windowEnd ?? ""}:${next}` };

      // The window is finished. Its END becomes the next run's start — the same
      // instant on both sides rather than one millisecond later, because an
      // order updated exactly on the boundary being read twice is free (rows
      // are upserted) and being skipped is not.
      return {
        records,
        cursor: null,
        ...(windowEnd === null ? {} : { resumeToken: `${RESUME_PREFIX}${windowEnd}` }),
      };
    },
  },
  /**
   * One task: tell Amazon the parcel is on its way.
   *
   * `confirmShipment` needs the order's ITEMS — an id and a quantity per line —
   * so the task reads them itself rather than asking an operator to keep a list
   * in a column, exactly as n11's and Çiçeksepeti's tasks do. That is the third
   * provider to need it, which is worth saying out loud: if a fourth does, the
   * lookup belongs in the engine rather than in three provider files.
   *
   * It is not repeatable. Confirming a shipment twice is telling a marketplace
   * twice, and Amazon answers the second one with an error the operator did not
   * cause.
   */
  tasks: [
    {
      id: "confirm_shipment",
      label: "Confirm shipment",
      settingFields: [
        {
          key: "orderIdField",
          label: "Order ID field",
          placeholder: "the row field holding the Amazon order id, e.g. marketplace_order_id",
        },
        {
          key: "carrierCodeField",
          label: "Carrier code field",
          placeholder: "the row field holding Amazon's carrier code, e.g. carrier_code",
        },
        {
          key: "trackingNumberField",
          label: "Tracking number field",
          placeholder: "the row field holding the carrier's tracking number",
        },
        {
          key: "shippingMethodField",
          label: "Shipping method field (optional)",
          placeholder: "the row field holding the service level, e.g. shipping_method",
        },
      ],
      outputs: [
        { key: "status", label: "Shipment status" },
        { key: "carrierCode", label: "Carrier code sent" },
        { key: "trackingNumber", label: "Tracking number sent" },
        { key: "confirmedItems", label: "Lines confirmed" },
        { key: "shippedAt", label: "Shipped at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const orderId = readOrderId(ctx);

        // Everything decidable from the step and the row is decided before the
        // items lookup, so a misconfigured step fails immediately instead of
        // after a paced request.
        const carrierCode = requiredRowValue(ctx, "carrierCodeField", "carrier code");
        const trackingNumber = requiredRowValue(ctx, "trackingNumberField", "tracking number");
        const shippingMethod = optionalRowValue(ctx, "shippingMethodField");

        const token = await accessToken(ctx, conn);
        const lines = await orderItems(ctx, conn, token, orderId);
        const orderItemsPayload = lines
          .map((l) => ({ orderItemId: l.externalId, quantity: num(l.data.quantityOrdered) ?? 0 }))
          .filter((l) => l.quantity > 0);
        if (orderItemsPayload.length === 0) {
          throw new Error(`Amazon order ${orderId} has no line to confirm`);
        }

        const shipDate = new Date().toISOString();
        await takeToken(`amazon:confirm:${conn.sellerId}`, CONFIRM_PACE);
        const res = await ctx.fetch(
          `${conn.host}/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
          {
            method: "POST",
            headers: { ...headersFor(token), "Content-Type": "application/json" },
            body: JSON.stringify({
              marketplaceId: conn.marketplaceId,
              packageDetail: {
                // Amazon requires a reference unique per order. The engine's
                // idempotency key is stable for this (integration, task, row)
                // and the same across every retry, which is exactly the
                // property this field wants — so a retry confirms the same
                // package rather than declaring a second one.
                packageReferenceId: packageReference(ctx.idempotencyKey),
                carrierCode,
                ...(shippingMethod === null ? {} : { shippingMethod }),
                trackingNumber,
                shipDate,
                orderItems: orderItemsPayload,
              },
            }),
          },
        );
        if (!res.ok) throw await readError(res, "confirm the shipment");

        return {
          outputs: {
            status: "Shipped",
            carrierCode,
            trackingNumber,
            confirmedItems: orderItemsPayload.length,
            shippedAt: Date.parse(shipDate),
          },
        };
      },
    },
  ],

  /**
   * Putting a product on sale — the sixth shape, and the one this provider
   * shipped without.
   *
   * The reason it was left out is in the header above: an attribute's value
   * shape is defined per product type and is not in the operation reference, so
   * a hand-written payload would have been a guess about a seller's own
   * catalogue. That reason no longer holds, because the Product Type
   * Definitions API hands the schema over — and this implementation is driven
   * BY that schema rather than by a remembered example.
   *
   * Four things here differ from every marketplace before it:
   *
   * **The taxonomy is FLAT and has no tree.** Amazon's "categories" are product
   * types, returned as a plain list with no parent. Every node is therefore a
   * leaf, and the picker is a search rather than a walk.
   *
   * **The attributes are behind a second, signed link.** The definition names a
   * `schema.link.resource` on Amazon's own CDN, and the actual JSON Schema is
   * fetched from there. Hepsiburada set the precedent of a provider making its
   * own second call; this one goes further, because the schema is also what
   * tells `publish` how to WRAP each value.
   *
   * **The answer is synchronous, and it is still not the verdict.** A PUT
   * answers `ACCEPTED` or `INVALID` immediately — the only marketplace here
   * that refuses on the spot. But `ACCEPTED` means "queued without blocking
   * problems", not "on sale": Amazon settles it afterwards, and issues can
   * appear minutes later. So an immediate `INVALID` closes that unit and
   * everything else is polled, which is exactly the two-phase shape the engine
   * already models.
   *
   * **One call per unit.** There is no batch endpoint here; the SKU is in the
   * path. At five requests a second that is the binding constraint on a run.
   */
  listing: {
    settingFields: [
      {
        key: "currency",
        label: "Currency (ISO 4217)",
        placeholder: "EUR",
      },
      {
        key: "conditionType",
        label: "Condition",
        options: [
          { value: "new_new", label: "New" },
          { value: "refurbished_refurbished", label: "Refurbished" },
          { value: "used_like_new", label: "Used — like new" },
          { value: "used_very_good", label: "Used — very good" },
          { value: "used_good", label: "Used — good" },
          { value: "used_acceptable", label: "Used — acceptable" },
        ],
      },
      {
        key: "languageTag",
        label: "Language tag for text (optional)",
        placeholder: "en_US",
      },
    ],
    /**
     * Product-level fields.
     *
     * Deliberately short. Everything beyond the handful every product type
     * shares is reached through the ATTRIBUTE mapper, because which attributes
     * exist is a property of the chosen product type — the whole reason this
     * shape interrogates the provider instead of declaring a form.
     */
    columns: [
      { value: "title", label: "Title (item_name)" },
      { value: "description", label: "Description (product_description)" },
      { value: "brand", label: "Brand" },
      { value: "bulletPoints", label: "Bullet points, one per line (optional)" },
      { value: "images", label: "Image URLs (optional)" },
    ],
    variantColumns: [
      { value: "sku", label: "Seller SKU" },
      { value: "quantity", label: "Stock quantity" },
      { value: "price", label: "Price" },
    ],
    /**
     * The SKU, and it is the strongest reference of any provider here: Amazon
     * does not merely echo it, it is the resource being addressed — the PUT
     * path IS the SKU, and both the response and every later read carry it.
     */
    referenceColumn: "sku",
    outputs: [
      { key: "listingId", label: "Seller SKU (listing id)" },
      { key: "listingStatus", label: "Listing status" },
      { key: "listingError", label: "Rejection reason" },
      { key: "listedAt", label: "Listed at" },
    ],

    async categories(ctx) {
      const conn = readConnection(ctx, "listing");
      const token = await accessToken(ctx, conn);
      await takeToken(`amazon:definitions:${conn.sellerId}`, DEFINITIONS_PACE);
      const url = `${conn.host}/definitions/2020-09-01/productTypes?marketplaceIds=${encodeURIComponent(conn.marketplaceId)}`;
      const res = await ctx.fetch(url, { headers: headersFor(token) });
      if (!res.ok) throw await readError(res, "read the product types");
      const body = (await res.json()) as { productTypes?: unknown };
      const list = Array.isArray(body.productTypes) ? body.productTypes : [];
      const out: ListingCategory[] = [];
      for (const raw of list) {
        const pt = raw as Record<string, unknown>;
        const name = text(pt.name);
        if (!name) continue;
        // No parent, and leaf for everyone: Amazon publishes product types as a
        // flat vocabulary. Saying so here is what keeps the picker honest
        // rather than drawing a one-level tree that means nothing.
        out.push({ id: name, name: text(pt.displayName) ?? name, parentId: null, leaf: true });
      }
      return out;
    },

    async attributes(ctx) {
      const conn = readConnection(ctx, "listing");
      const token = await accessToken(ctx, conn);
      const schema = await productTypeSchema(ctx, conn, token, ctx.categoryId);
      return schemaAttributes(schema);
    },

    async publish(ctx) {
      const conn = readConnection(ctx, "listing");
      const token = await accessToken(ctx, conn);
      const currency = (ctx.setting("currency") ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error("Set the listing's currency to an ISO 4217 code before publishing — Amazon prices carry it explicitly");
      }
      const conditionType = ctx.setting("conditionType") ?? "new_new";
      const languageTag = (ctx.setting("languageTag") ?? "").trim() || null;

      // One schema per product type in this batch, not per unit. A run is
      // normally one or two types, and the schema is the largest thing fetched
      // here.
      const schemas = new Map<string, ProductTypeSchema>();
      const settled: ListingVerdict[] = [];
      let accepted = 0;

      for (const product of ctx.products) {
        let schema = schemas.get(product.categoryId);
        if (!schema) {
          schema = await productTypeSchema(ctx, conn, token, product.categoryId);
          schemas.set(product.categoryId, schema);
        }
        for (const variant of product.variants) {
          const sku = text(variant.fields.sku) ?? variant.reference;
          if (!sku) {
            settled.push({ reference: variant.reference, status: "rejected", errors: ["no seller SKU"] });
            continue;
          }
          const attributes = buildAttributes({
            schema,
            product,
            variant,
            conn,
            currency,
            conditionType,
            languageTag,
          });

          await takeToken(`amazon:listings:${conn.sellerId}`, LISTINGS_PACE);
          const res = await ctx.fetch(
            `${conn.host}/listings/2021-08-01/items/${encodeURIComponent(conn.sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${encodeURIComponent(conn.marketplaceId)}`,
            {
              method: "PUT",
              headers: { ...headersFor(token), "Content-Type": "application/json" },
              body: JSON.stringify({
                productType: product.categoryId,
                requirements: "LISTING",
                attributes,
              }),
            },
          );
          if (!res.ok) throw await readError(res, `list ${sku}`);
          const body = (await res.json().catch(() => ({}))) as {
            status?: unknown;
            issues?: { message?: unknown; severity?: unknown }[];
          };
          const status = text(body.status);
          const errors = (body.issues ?? [])
            .filter((i) => text(i.severity) === "ERROR")
            .map((i) => text(i.message) ?? "")
            .filter(Boolean);
          if (status === "INVALID") {
            // Refused on the spot, so this unit is settled and must not be
            // polled — the same reading n11's `REJECT` gets.
            settled.push({
              reference: variant.reference,
              status: "rejected",
              errors: errors.length > 0 ? errors : ["Amazon refused the listing without saying why"],
            });
            continue;
          }
          accepted += 1;
        }
      }

      // The batch id is the moment the publish ran, because that is what the
      // poll asks with: Amazon has no batch, only listings that were last
      // updated after a point in time. The engine drops any verdict whose
      // reference this batch never sent, which is what makes that safe.
      return { batchId: accepted > 0 ? String(Date.now()) : "", settled };
    },

    async poll(ctx) {
      const conn = readConnection(ctx, "listing");
      const token = await accessToken(ctx, conn);
      const since = Number(ctx.batchId);
      if (!Number.isFinite(since)) return [];

      const out: ListingVerdict[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < POLL_PAGES; page += 1) {
        const url = new URL(`${conn.host}/listings/2021-08-01/items/${encodeURIComponent(conn.sellerId)}`);
        url.searchParams.set("marketplaceIds", conn.marketplaceId);
        url.searchParams.set("includedData", "summaries,issues");
        // A second before the publish: Amazon stamps `lastUpdatedDate` itself,
        // and a boundary that excluded the unit we just sent would report it
        // pending for ever.
        url.searchParams.set("lastUpdatedAfter", new Date(since - 1000).toISOString());
        url.searchParams.set("pageSize", "20");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        await takeToken(`amazon:listings-search:${conn.sellerId}`, SEARCH_PACE);
        const res = await ctx.fetch(url.toString(), { headers: headersFor(token) });
        if (!res.ok) throw await readError(res, "read the listing statuses");
        const body = (await res.json()) as {
          items?: Record<string, unknown>[];
          pagination?: { nextToken?: unknown };
        };
        for (const item of body.items ?? []) {
          const verdict = readItemVerdict(item);
          if (verdict) out.push(verdict);
        }
        pageToken = text(body.pagination?.nextToken);
        if (!pageToken) break;
      }
      return out;
    },
  },
});


// ── Listing ──────────────────────────────────────────────────────────────────

/** The published pace of the listing operations, from the API's own reference. */
const DEFINITIONS_PACE = { rps: 5, burst: 10 } as const;
const LISTINGS_PACE = { rps: 5, burst: 10 } as const;
const SEARCH_PACE = { rps: 5, burst: 5 } as const;

/** Pages one poll walks. Bounds the invocation; the next sweep resumes. */
const POLL_PAGES = 5;

/**
 * Hosts a product type schema may be fetched from.
 *
 * The link comes out of an authenticated Amazon response rather than from a
 * caller, so this is not an SSRF guard so much as a promise about where this
 * provider will send a seller's access token — which is why the token is NOT
 * sent with it. Same call the EasyPost label host got.
 */
const SCHEMA_HOSTS = [".amazonaws.com", ".media-amazon.com", ".ssl-images-amazon.com"] as const;

/** A product type's JSON Schema, as far as this provider reads it. */
interface ProductTypeSchema {
  properties: Record<string, Record<string, unknown>>;
  required: readonly string[];
}

/**
 * Fetch a product type definition and then the schema it links to.
 *
 * Two requests, and the second one is to a signed URL on a CDN. The definition
 * is asked for with `requirements=LISTING` because that is the set a seller
 * creating their own listing has to satisfy; the offer-only and product-only
 * sets exist for sellers adding to someone else's catalogue entry.
 */
const productTypeSchema = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  token: string,
  productType: string,
): Promise<ProductTypeSchema> => {
  if (!/^[A-Z0-9_]{1,80}$/.test(productType)) {
    throw new Error(`"${productType}" is not an Amazon product type`);
  }
  await takeToken(`amazon:definitions:${conn.sellerId}`, DEFINITIONS_PACE);
  const url =
    `${conn.host}/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}` +
    `?marketplaceIds=${encodeURIComponent(conn.marketplaceId)}&sellerId=${encodeURIComponent(conn.sellerId)}` +
    `&requirements=LISTING&requirementsEnforced=ENFORCED`;
  const res = await ctx.fetch(url, { headers: headersFor(token) });
  if (!res.ok) throw await readError(res, `read the "${productType}" definition`);
  const body = (await res.json()) as { schema?: { link?: { resource?: unknown } } };
  const link = text(body.schema?.link?.resource);
  if (!link) throw new Error(`Amazon returned no schema for "${productType}"`);

  let host: string;
  try {
    host = new URL(link).hostname;
  } catch {
    throw new Error("Amazon returned an unreadable schema link");
  }
  if (!SCHEMA_HOSTS.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`Amazon pointed the "${productType}" schema at ${host}, which is not one of its own hosts`);
  }

  // No credentials on this leg: the link is already signed, and Amazon's access
  // token has no business travelling to a CDN.
  const schemaRes = await ctx.fetch(link, { headers: { Accept: "application/json" } });
  if (!schemaRes.ok) throw new Error(`Amazon's schema host responded ${schemaRes.status} for "${productType}"`);
  const schema = (await schemaRes.json()) as { properties?: unknown; required?: unknown };
  const properties: Record<string, Record<string, unknown>> = {};
  if (schema.properties && typeof schema.properties === "object") {
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (v && typeof v === "object") properties[k] = v as Record<string, unknown>;
    }
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
  return { properties, required };
};

/** The object one entry of an attribute array carries, per the schema. */
const itemProperties = (prop: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> => {
  const items = prop?.items as Record<string, unknown> | undefined;
  const props = items?.properties;
  if (!props || typeof props !== "object") return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (v && typeof v === "object") out[k] = v as Record<string, unknown>;
  }
  return out;
};

/**
 * The attributes this provider will offer an operator.
 *
 * Only the ones it can actually FILL. Amazon's schemas describe attributes far
 * more varied than one bound value — nested objects, per-sub-attribute
 * schedules — and an attribute offered in the mapping form that the publish
 * could not express would be worse than an omission: it would read as
 * configured and change nothing. So an attribute is offered when one entry of
 * its array carries a plain `value`, and skipped otherwise. The ones this file
 * fills from declared columns are skipped too, so the same fact is not asked
 * for twice in two places that could disagree.
 */
const schemaAttributes = (schema: ProductTypeSchema): ListingAttribute[] => {
  const required = new Set(schema.required);
  const out: ListingAttribute[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (COLUMN_ATTRIBUTES.has(name)) continue;
    const props = itemProperties(prop);
    const value = props.value;
    if (!value) continue;

    const rawEnum = Array.isArray(value.enum) ? value.enum : [];
    const names = Array.isArray((value as { enumNames?: unknown }).enumNames)
      ? ((value as { enumNames?: unknown }).enumNames as unknown[])
      : [];
    const values = rawEnum
      .map((v, i) => ({ id: String(v), name: text(names[i]) ?? String(v) }))
      .filter((v) => v.id !== "");

    const maxItems = typeof prop.maxItems === "number" ? prop.maxItems : null;
    out.push({
      id: name,
      name: text(prop.title) ?? name,
      required: required.has(name),
      // A closed set refuses anything outside it; everything else is free text.
      allowCustom: values.length === 0,
      // Amazon expresses a variation with a parent SKU and a `variation_theme`
      // rather than by marking an attribute, so there is nothing here to
      // report. See the note on variations below.
      variant: false,
      multiple: maxItems === null ? false : maxItems > 1,
      values,
    });
  }
  // Required first: a form with two hundred optional attributes below the eight
  // that decide whether the listing is accepted is a form nobody finishes.
  return out.sort((a, b) => (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1));
};

/**
 * Attributes this provider fills itself, from its declared columns.
 *
 * Kept out of the mapping form so one fact never has two sources.
 */
const COLUMN_ATTRIBUTES = new Set([
  "item_name",
  "product_description",
  "brand",
  "bullet_point",
  "main_product_image_locator",
  "other_product_image_locator_1",
  "other_product_image_locator_2",
  "other_product_image_locator_3",
  "other_product_image_locator_4",
  "other_product_image_locator_5",
  "condition_type",
  "purchasable_offer",
  "fulfillment_availability",
  "merchant_suggested_asin",
]);

/**
 * Wrap one value the way the schema says this attribute is carried.
 *
 * Every Amazon attribute is an ARRAY of objects, and which selectors those
 * objects take differs per attribute — `marketplace_id` on nearly all of them,
 * `language_tag` on the localisable ones. Reading that off the schema rather
 * than sending a fixed envelope is what makes this work across product types
 * without a table of special cases.
 */
const wrapValue = (
  prop: Record<string, unknown> | undefined,
  value: unknown,
  conn: Connection,
  languageTag: string | null,
): unknown[] => {
  const props = itemProperties(prop);
  const entry: Record<string, unknown> = { value };
  if (props.marketplace_id) entry.marketplace_id = conn.marketplaceId;
  if (props.language_tag && languageTag) entry.language_tag = languageTag;
  return [entry];
};

/**
 * The offer — price — in the one shape Amazon documents for it.
 *
 * `our_price` is an array of schedules and the price sits on `value_with_tax`;
 * `currency` and `marketplace_id` are selectors that say which offer this is,
 * not data. Verified against Amazon's own sub-attribute reference rather than
 * inferred, because a price written into the wrong field is the failure that
 * looks like success.
 */
const buildOffer = (conn: Connection, currency: string, price: number): unknown[] => [
  {
    marketplace_id: conn.marketplaceId,
    currency,
    our_price: [{ schedule: [{ value_with_tax: price }] }],
  },
];

/**
 * Stock, with the fulfilment channel read off the schema.
 *
 * The selector's name is the same everywhere but its accepted values are the
 * seller's own channels, so the schema is asked rather than assumed; `DEFAULT`
 * — merchant-fulfilled — is the fallback when it enumerates nothing.
 */
const buildAvailability = (prop: Record<string, unknown> | undefined, quantity: number): unknown[] => {
  const channel = itemProperties(prop).fulfillment_channel_code;
  const options = Array.isArray(channel?.enum) ? (channel.enum as unknown[]) : [];
  const code = text(options[0]) ?? "DEFAULT";
  return [{ fulfillment_channel_code: code, quantity }];
};

/** Build the whole `attributes` object for one unit. */
const buildAttributes = (args: {
  schema: ProductTypeSchema;
  product: { fields: Record<string, unknown> };
  variant: { fields: Record<string, unknown>; attributes: readonly ListingAttributeBinding[] };
  conn: Connection;
  currency: string;
  conditionType: string;
  languageTag: string | null;
}): Record<string, unknown> => {
  const { schema, product, variant, conn, currency, conditionType, languageTag } = args;
  const has = (name: string) => name in schema.properties;
  const out: Record<string, unknown> = {};
  const put = (name: string, value: unknown) => {
    if (!has(name) || value === null || value === undefined || value === "") return;
    out[name] = wrapValue(schema.properties[name], value, conn, languageTag);
  };

  put("item_name", text(product.fields.title));
  put("product_description", text(product.fields.description));
  put("brand", text(product.fields.brand));
  put("condition_type", conditionType);

  // One bullet per line, capped at the five Amazon shows. A single wrapped
  // entry per bullet, because the attribute is a repeated one.
  const bullets = (text(product.fields.bulletPoints) ?? "")
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (bullets.length > 0 && has("bullet_point")) {
    out.bullet_point = bullets.flatMap((b) => wrapValue(schema.properties.bullet_point, b, conn, languageTag));
  }

  const images = splitList(product.fields.images);
  if (images[0]) put("main_product_image_locator", images[0]);
  for (let i = 1; i < images.length && i <= 5; i += 1) {
    put(`other_product_image_locator_${i}`, images[i]);
  }

  const price = num(variant.fields.price);
  if (price !== null && has("purchasable_offer")) out.purchasable_offer = buildOffer(conn, currency, price);
  const quantity = num(variant.fields.quantity);
  if (quantity !== null && has("fulfillment_availability")) {
    out.fulfillment_availability = buildAvailability(schema.properties.fulfillment_availability, quantity);
  }

  // The operator's own answers last, so a mapped attribute wins over nothing
  // and never silently overwrites a column above (those names are excluded
  // from the mapping form).
  for (const binding of variant.attributes) {
    const prop = schema.properties[binding.attributeId];
    if (!prop) continue;
    const value = binding.valueId ?? binding.custom;
    if (value === undefined || value === "") continue;
    const existing = out[binding.attributeId];
    const wrapped = wrapValue(prop, value, conn, languageTag);
    out[binding.attributeId] = Array.isArray(existing) ? [...existing, ...wrapped] : wrapped;
  }

  return out;
};

/** Image URLs, however the mapped column spells a list. */
const splitList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((v) => text(v) ?? "").filter(Boolean);
  const s = text(raw);
  if (!s) return [];
  return s
    .split(/[\n,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
};

/**
 * What one searched listing says about itself.
 *
 * `BUYABLE` is the only unambiguous "it worked" Amazon offers — an item can
 * exist, be free of errors and still not be for sale. An ERROR-severity issue
 * closes the unit the other way. Anything else is left pending, which is the
 * honest answer while Amazon is still deciding.
 */
const readItemVerdict = (item: Record<string, unknown>): ListingVerdict | null => {
  const sku = text(item.sku);
  if (!sku) return null;
  const issues = Array.isArray(item.issues) ? (item.issues as Record<string, unknown>[]) : [];
  const errors = issues
    .filter((i) => text(i.severity) === "ERROR")
    .map((i) => text(i.message) ?? "")
    .filter(Boolean);
  if (errors.length > 0) return { reference: sku, status: "rejected", errors };

  const summaries = Array.isArray(item.summaries) ? (item.summaries as Record<string, unknown>[]) : [];
  const live = summaries.some((s) => {
    const status = Array.isArray(s.status) ? (s.status as unknown[]) : [];
    return status.some((v) => text(v) === "BUYABLE");
  });
  if (live) return { reference: sku, status: "accepted", externalId: sku };
  return { reference: sku, status: "pending" };
};

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  host: string;
  marketplaceId: string;
  sellerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Read the credentials, and check the two values that reach a URL.
 *
 * `marketplaceId` and `sellerId` are Amazon's own opaque identifiers; both are
 * checked against the shape Amazon issues before either is interpolated.
 */
const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const region = ctx.str("region");
  const host = HOSTS[(region ?? "") as Region] ?? HOSTS.eu;

  const marketplaceId = ctx.str("marketplaceId");
  if (!marketplaceId) throw new Error(`Amazon ${what} has no marketplace`);
  if (!(MARKETPLACES as readonly { value: string }[]).some((m) => m.value === marketplaceId)) {
    throw new Error(`Amazon has no marketplace "${marketplaceId}"`);
  }

  const sellerId = ctx.str("sellerId");
  if (!sellerId) throw new Error(`Amazon ${what} has no seller id`);
  if (!/^[A-Z0-9]{1,32}$/.test(sellerId)) {
    throw new Error("Amazon seller id must be the merchant token from Seller Central → Account Info");
  }

  const clientId = ctx.str("clientId");
  const clientSecret = ctx.str("clientSecret");
  const refreshToken = ctx.str("refreshToken");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Amazon ${what} has no LWA client id, secret and refresh token`);
  }

  return { host, marketplaceId, sellerId, clientId, clientSecret, refreshToken };
};

const headersFor = (token: string): Record<string, string> => ({
  "x-amz-access-token": token,
  // Amazon asks for a name, a version and a language, and caps it at 500
  // characters. It is not decoration: it is what appears in a seller's own
  // usage reports when they go looking for which integration made a call.
  "User-Agent": "backlex/1.0 (Language=TypeScript)",
  Accept: "application/json",
});

/**
 * Mint an access token from the refresh token.
 *
 * One per invocation, reused for every request inside it. There is deliberately
 * no cross-invocation cache: it would have to be a module-level map keyed by
 * somebody's refresh token, which is a worse thing to own than one extra
 * request per page — and the endpoint that costs the most here is limited to a
 * request a minute regardless.
 */
const accessToken = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
): Promise<string> => {
  const res = await ctx.fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
      client_id: conn.clientId,
      client_secret: conn.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    // Deliberately does NOT quote the response. A failed token exchange echoes
    // the request back in some of its error shapes, and this is the one call in
    // the file whose body holds the client secret.
    throw new Error(
      "Amazon refused the refresh token — check the LWA client id, secret and refresh token, and that the app is still authorized for this seller",
    );
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const token = text(body.access_token);
  if (!token) throw new Error("Amazon returned no access token");
  return token;
};

/**
 * Mint a Restricted Data Token for the order path, or fall back to the plain
 * one.
 *
 * The buyer's name and the shipping address are restricted, and an order
 * without an address is nearly useless to the carrier integration this engine
 * exists to feed — so it is asked for by default. A seller whose application
 * has not been approved for the PII role is refused, and that refusal is a
 * degradation rather than a failure: the sync runs and the address columns stay
 * empty, which is exactly what would have happened had they turned the setting
 * off.
 */
const restrictedToken = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  token: string,
): Promise<string> => {
  const res = await ctx.fetch(`${conn.host}/tokens/2021-03-01/restrictedDataToken`, {
    method: "POST",
    headers: { ...headersFor(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      restrictedResources: [
        {
          method: "GET",
          path: "/orders/v0/orders",
          dataElements: ["buyerInfo", "shippingAddress"],
        },
      ],
    }),
  });
  if (!res.ok) return token;
  const body = (await res.json().catch(() => ({}))) as { restrictedDataToken?: unknown };
  return text(body.restrictedDataToken) ?? token;
};

// ── Orders ───────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_WINDOW_DAYS ? Math.floor(n) : DEFAULT_LOOKBACK_DAYS;
};

const readEpoch = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * One order, flattened for mapping.
 *
 * Addresses are spread into their parts rather than handed over as objects: a
 * mapping targets one column. Amazon's own field names are kept where there is
 * one, so what the picker offers matches what Seller Central and the reference
 * call it.
 *
 * `District` is carried alongside `City` and `StateOrRegion` because a Turkish
 * address is il / ilçe / mahalle and a courier needs all three — the same
 * address that is state/city elsewhere.
 */
const orderData = (o: Record<string, unknown>): Record<string, unknown> => {
  const ship = obj(o.ShippingAddress);
  const buyer = obj(o.BuyerInfo);
  return {
    amazonOrderId: o.AmazonOrderId ?? null,
    sellerOrderId: o.SellerOrderId ?? null,
    purchaseDate: o.PurchaseDate ?? null,
    lastUpdateDate: o.LastUpdateDate ?? null,
    status: o.OrderStatus ?? null,
    orderType: o.OrderType ?? null,
    fulfillmentChannel: o.FulfillmentChannel ?? null,
    salesChannel: o.SalesChannel ?? null,
    shipServiceLevel: o.ShipServiceLevel ?? null,
    shipmentServiceLevelCategory: o.ShipmentServiceLevelCategory ?? null,
    marketplaceId: o.MarketplaceId ?? null,

    totalPrice: money(o.OrderTotal),
    currency: moneyCurrency(o.OrderTotal),
    itemsShipped: o.NumberOfItemsShipped ?? null,
    itemsUnshipped: o.NumberOfItemsUnshipped ?? null,
    paymentMethod: o.PaymentMethod ?? null,

    earliestShipDate: o.EarliestShipDate ?? null,
    latestShipDate: o.LatestShipDate ?? null,
    earliestDeliveryDate: o.EarliestDeliveryDate ?? null,
    latestDeliveryDate: o.LatestDeliveryDate ?? null,

    isPrime: o.IsPrime ?? null,
    isBusinessOrder: o.IsBusinessOrder ?? null,
    isReplacementOrder: o.IsReplacementOrder ?? null,
    replacedOrderId: o.ReplacedOrderId ?? null,
    hasRegulatedItems: o.HasRegulatedItems ?? null,

    // Present only when the connection could mint a restricted token; empty
    // otherwise, which is what "leave it redacted" looks like on the row.
    buyerEmail: buyer.BuyerEmail ?? null,
    buyerName: buyer.BuyerName ?? null,

    shipmentName: ship.Name ?? null,
    shipmentCompanyName: ship.CompanyName ?? null,
    shipmentAddress1: ship.AddressLine1 ?? null,
    shipmentAddress2: ship.AddressLine2 ?? null,
    shipmentAddress3: ship.AddressLine3 ?? null,
    shipmentDistrict: ship.District ?? null,
    shipmentCity: ship.City ?? null,
    shipmentCounty: ship.County ?? null,
    shipmentStateOrRegion: ship.StateOrRegion ?? null,
    shipmentPostalCode: ship.PostalCode ?? null,
    shipmentCountryCode: ship.CountryCode ?? null,
    shipmentPhone: ship.Phone ?? null,
  };
};

/**
 * An order's lines, as child records.
 *
 * A second request per order — Amazon does not return items with the order —
 * which is the N+1 that caps {@link ORDERS_PAGE}. It pages on its own
 * `NextToken`, because an order with more lines than one page holds is rare but
 * not impossible, and half its lines is worse than none.
 */
const orderItems = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  token: string,
  orderId: string,
): Promise<{ externalId: string; data: Record<string, unknown> }[]> => {
  const out: { externalId: string; data: Record<string, unknown> }[] = [];
  let next: string | null = null;

  do {
    const url = new URL(`${conn.host}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`);
    if (next) url.searchParams.set("NextToken", next);

    await takeToken(`amazon:items:${conn.sellerId}`, ITEMS_PACE);
    const res = await ctx.fetch(url.toString(), { headers: headersFor(token) });
    if (!res.ok) throw await readError(res, `read the lines of order ${orderId}`);

    const body = (await res.json()) as {
      payload?: { OrderItems?: Record<string, unknown>[]; NextToken?: unknown };
    };
    for (const raw of body.payload?.OrderItems ?? []) {
      const id = text(raw.OrderItemId);
      if (!id) continue;
      out.push({ externalId: id, data: lineData(raw) });
    }
    next = text(body.payload?.NextToken);
  } while (next);

  return out;
};

const lineData = (l: Record<string, unknown>): Record<string, unknown> => ({
  orderItemId: l.OrderItemId ?? null,
  asin: l.ASIN ?? null,
  sellerSku: l.SellerSKU ?? null,
  title: l.Title ?? null,
  quantityOrdered: l.QuantityOrdered ?? null,
  quantityShipped: l.QuantityShipped ?? null,
  itemPrice: money(l.ItemPrice),
  currency: moneyCurrency(l.ItemPrice) ?? moneyCurrency(l.ShippingPrice),
  itemTax: money(l.ItemTax),
  shippingPrice: money(l.ShippingPrice),
  shippingTax: money(l.ShippingTax),
  shippingDiscount: money(l.ShippingDiscount),
  promotionDiscount: money(l.PromotionDiscount),
  conditionId: l.ConditionId ?? null,
  conditionNote: l.ConditionNote ?? null,
  isGift: l.IsGift ?? null,
  isTransparency: l.IsTransparency ?? null,
  serialNumberRequired: l.SerialNumberRequired ?? null,
  scheduledDeliveryStartDate: l.ScheduledDeliveryStartDate ?? null,
  scheduledDeliveryEndDate: l.ScheduledDeliveryEndDate ?? null,
});

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * The order id this task acts on, read off the row.
 *
 * Amazon issues them in a 3-7-7 digit format, and the value is interpolated
 * into a URL path. Checking the shape names the mis-pointed setting instead of
 * producing a 404 from a URL nobody meant to build.
 */
const readOrderId = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("orderIdField");
  if (!field) throw new Error("Amazon task needs the row field holding the order id");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no Amazon order id`);
  if (!/^\d{3}-\d{7}-\d{7}$/.test(value)) {
    throw new Error(`"${field}" does not hold an Amazon order id — they look like 123-1234567-1234567`);
  }
  return value;
};

/**
 * A package reference Amazon will accept, derived from the engine's idempotency
 * key.
 *
 * Stable across retries — which is the whole point — and reduced to the
 * characters Amazon takes, with a length it will not refuse.
 */
const packageReference = (idempotencyKey: string): string =>
  idempotencyKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "backlex";

const requiredRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
  what: string,
): string => {
  const field = ctx.setting(settingKey);
  if (!field) throw new Error(`Amazon task needs the row field holding the ${what}`);
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no ${what} to send to Amazon`);
  return value;
};

const optionalRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): string | null => {
  const field = ctx.setting(settingKey);
  return field ? text(ctx.row[field]) : null;
};

// ── Shared ───────────────────────────────────────────────────────────────────

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Amazon sends every amount as `{ CurrencyCode, Amount }`, and `Amount` is a
 * STRING. Unpacked into two columns and converted, for the same reason
 * addresses are spread: a mapping targets one column, and a price stored as
 * text cannot be summed.
 */
const money = (v: unknown): number | null => num(obj(v).Amount);
const moneyCurrency = (v: unknown): string | null => text(obj(v).CurrencyCode);

/**
 * Turn a failed call into something an operator can act on.
 *
 * 429 is deliberately absent: the engine's fetch wrapper classifies it before a
 * provider sees the response, so a branch here would be unreachable and would
 * read as though it still decided something.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 160);
  try {
    const body = JSON.parse(raw) as { errors?: { message?: string; code?: string }[] };
    detail = (body.errors?.[0]?.message ?? detail).slice(0, 160);
  } catch {
    // Not JSON — the gateway answers XML or plain text on some failures, and
    // the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `Amazon refused the request and could not ${what} — check that the application is authorized for this seller and has the roles this data needs${detail ? `: ${detail}` : ""}`,
    );
  }
  return new Error(`Amazon responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};
