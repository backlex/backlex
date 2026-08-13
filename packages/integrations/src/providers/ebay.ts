import {
  defineProvider,
  type ListingAttribute,
  type ListingCategory,
  type ListingVerdict,
} from "../provider";

/**
 * eBay — orders in, a shipment confirmed back, and products put on sale.
 *
 * The sixth marketplace, the first reached over OAuth, and the first that is
 * neither Turkish nor Amazon. Its whole surface here comes from eBay's own
 * OpenAPI contracts, which are served from a portal that answers 403 to every
 * automated fetch — they were read through a real browser instead.
 *
 * Six facts shape this file, and each one is something no other marketplace
 * here does:
 *
 * **The redirect is not a URL.** eBay's authorization-code flow takes an
 * "RuName", an opaque handle eBay mints for the application, in the
 * `redirect_uri` parameter; the real callback is registered against that handle
 * in eBay's portal. That is why this provider declares `redirectUriFrom` and
 * asks the seller to paste theirs — the engine cannot derive it.
 *
 * **Listing is three calls, not one.** An inventory item is created, an offer
 * is made against it, and the offer is published. The first two are idempotent
 * PUT/POST on the seller's own SKU; only the third makes a listing.
 *
 * **The publish answers with the verdict.** `publishOffer` returns a listing id
 * or an error, so there is nothing to poll and no batch id — the engine's
 * `settled` carries every unit, accepted ones included. eBay is the reason that
 * field is no longer called `rejected`.
 *
 * **Aspects mark their own variants.** `aspectEnabledForVariations` says which
 * aspect two units may differ on — the first marketplace here that answers the
 * question directly rather than by a flag under another name. Amazon cannot.
 *
 * **`Content-Language` is required**, on both write calls, and it is not the
 * marketplace: a German seller listing on eBay.de sends `de-DE`, and getting it
 * wrong is a rejected request rather than a translated one.
 *
 * **Business policies are prerequisites.** An offer names a fulfilment, a
 * payment and a return policy by id, plus a merchant location key, all created
 * by the seller beforehand. They are settings rather than columns because they
 * belong to the seller's account, not to a product.
 *
 * ⚠️ Its own OpenAPI types `Product.aspects` as a `string`. It is not one — it
 * is a map of aspect name to an array of values. A published spec is evidence,
 * not proof.
 */

/** Where the APIs live. Sandbox differs only by host, and it is self-serve. */
const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
} as const;

type Environment = keyof typeof HOSTS;

/**
 * The marketplaces a connection can address.
 *
 * A closed set, and it carries the default `Content-Language` for each: eBay
 * requires that header on both write calls and refuses a value the marketplace
 * does not serve. An operator may still override it.
 */
const MARKETPLACES = [
  { value: "EBAY_US", label: "United States (ebay.com)", language: "en-US" },
  { value: "EBAY_GB", label: "United Kingdom (ebay.co.uk)", language: "en-GB" },
  { value: "EBAY_DE", label: "Germany (ebay.de)", language: "de-DE" },
  { value: "EBAY_FR", label: "France (ebay.fr)", language: "fr-FR" },
  { value: "EBAY_IT", label: "Italy (ebay.it)", language: "it-IT" },
  { value: "EBAY_ES", label: "Spain (ebay.es)", language: "es-ES" },
  { value: "EBAY_AU", label: "Australia (ebay.com.au)", language: "en-AU" },
  { value: "EBAY_CA", label: "Canada (ebay.ca)", language: "en-CA" },
  { value: "EBAY_NL", label: "Netherlands (ebay.nl)", language: "nl-NL" },
  { value: "EBAY_PL", label: "Poland (ebay.pl)", language: "pl-PL" },
  { value: "EBAY_IE", label: "Ireland (ebay.ie)", language: "en-IE" },
  { value: "EBAY_AT", label: "Austria (ebay.at)", language: "de-AT" },
  { value: "EBAY_CH", label: "Switzerland (ebay.ch)", language: "de-CH" },
] as const;

/** Orders per page. eBay returns the lines WITH the order, so no N+1 here. */
const ORDERS_PAGE = 50;

/** Categories one subtree walk will flatten. Bounds a pathological tree. */
const MAX_CATEGORY_NODES = 20_000;

/**
 * eBay's quotas are per application and daily rather than per second, so there
 * is no published rate to pace against — the engine still classifies a 429.
 * A modest ceiling keeps a publish of a hundred units from arriving as a burst.
 */
const PACE = { rps: 5, burst: 10 } as const;

export const ebay = defineProvider({
  id: "ebay",
  label: "eBay",
  category: "marketplace",
  capabilities: ["source", "task", "listing"],
  limits: PACE,
  oauth: {
    authorizeUrl: "https://auth.ebay.com/oauth2/authorize",
    tokenUrl: "https://api.ebay.com/identity/v1/oauth2/token",
    scopes: [
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
    ],
    // eBay presents the client credentials as HTTP Basic on the token endpoint
    // and does not support PKCE on this flow.
    tokenAuth: "basic",
    redirectUriFrom: "ruName",
  },
  configFields: [
    {
      key: "environment",
      label: "Environment",
      options: [
        { value: "production", label: "Production (api.ebay.com)" },
        { value: "sandbox", label: "Sandbox (api.sandbox.ebay.com)" },
      ],
    },
    { key: "marketplaceId", label: "Marketplace", options: MARKETPLACES.map((m) => ({ value: m.value, label: m.label })) },
    { key: "clientId", label: "App ID (client ID)" },
    { key: "clientSecret", label: "Cert ID (client secret)", secret: true },
    {
      key: "ruName",
      label: "RuName (redirect URI name)",
      placeholder: "Your_Name-YourApp-abcdef-xyz",
    },
    { key: "contentLanguage", label: "Content language (optional)", placeholder: "de-DE" },
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
    ],
    async pull(ctx) {
      const conn = readConnection(ctx, "sync");
      // A real mirror: the filter bounds LAST MODIFIED, so a status change
      // brings the order back rather than freezing it at what it was when it
      // was created. Hepsiburada's filter bounds creation and needs a rolling
      // re-walk to make up for it.
      const since = readSince(ctx.cursor, readLookbackDays(ctx.setting("lookbackDays")));
      const offset = readOffset(ctx.cursor);

      const url = new URL(`${conn.host}/sell/fulfillment/v1/order`);
      url.searchParams.set("filter", `lastmodifieddate:[${new Date(since).toISOString()}..]`);
      url.searchParams.set("limit", String(ORDERS_PAGE));
      url.searchParams.set("offset", String(offset));

      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, "read the orders");
      const body = (await res.json()) as { orders?: Record<string, unknown>[]; total?: unknown; next?: unknown };
      const orders = body.orders ?? [];

      const records = orders.map((o) => {
        const orderId = text(o.orderId) ?? "";
        const lines = Array.isArray(o.lineItems) ? (o.lineItems as Record<string, unknown>[]) : [];
        return {
          externalId: orderId,
          data: orderData(o),
          children: {
            lines: lines.map((l, i) => ({
              // `lineItemId` is eBay's and stable; the index is only a fallback
              // for a malformed payload, and it is qualified by the order.
              externalId: text(l.lineItemId) ?? String(i + 1),
              data: lineData(l),
            })),
          },
        };
      });

      // `next` is a full href when more pages exist. The offset is carried in
      // OUR cursor rather than the href kept verbatim, so the window start
      // travels with it and a resumed walk cannot silently restart.
      const more = typeof body.next === "string" && body.next.length > 0;
      return {
        records,
        cursor: more ? `${since}:${offset + orders.length}` : null,
        complete: !more,
        // Only advance the watermark when the walk finished, or a later page's
        // orders would be skipped on the next run.
        ...(more ? {} : { resumeAt: Date.now() }),
      };
    },
  },

  tasks: [
    {
      id: "ship_order",
      label: "Confirm shipment",
      settingFields: [
        { key: "orderIdField", label: "Order ID column", placeholder: "marketplace_order_id" },
        { key: "carrierField", label: "Carrier code column", placeholder: "carrier_code" },
        { key: "trackingField", label: "Tracking number column", placeholder: "tracking_number" },
      ],
      outputs: [
        { key: "fulfillmentId", label: "eBay fulfillment ID" },
        { key: "confirmedLines", label: "Lines confirmed" },
        { key: "shippedAt", label: "Shipped at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const orderId = required(ctx, "orderIdField", "order id");
        const carrier = required(ctx, "carrierField", "carrier code");
        const tracking = required(ctx, "trackingField", "tracking number");

        // eBay wants the LINES, by their own ids, and a row does not carry
        // them — so they are looked up from the order. The fourth provider to
        // need this (after n11, Çiçeksepeti and Amazon), which is the count the
        // roadmap said would move it into the engine.
        const res = await ctx.fetch(
          `${conn.host}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
          { headers: headersFor(conn) },
        );
        if (!res.ok) throw await readError(res, `read order ${orderId}`);
        const order = (await res.json()) as { lineItems?: Record<string, unknown>[] };
        const lineItems = (order.lineItems ?? [])
          .map((l) => ({ lineItemId: text(l.lineItemId), quantity: num(l.quantity) ?? 1 }))
          .filter((l): l is { lineItemId: string; quantity: number } => Boolean(l.lineItemId));
        if (lineItems.length === 0) throw new Error(`eBay order ${orderId} has no lines to confirm`);

        const shipDate = new Date().toISOString();
        const post = await ctx.fetch(
          `${conn.host}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
          {
            method: "POST",
            headers: { ...headersFor(conn), "Content-Type": "application/json" },
            body: JSON.stringify({
              lineItems,
              shippedDate: shipDate,
              shippingCarrierCode: carrier,
              trackingNumber: tracking,
            }),
          },
        );
        if (!post.ok) throw await readError(post, "confirm the shipment");

        // The id is in the Location header — the body is empty on success.
        const location = post.headers.get("location") ?? "";
        const fulfillmentId = location.split("/").filter(Boolean).pop() ?? "";
        return {
          outputs: {
            fulfillmentId,
            confirmedLines: lineItems.length,
            shippedAt: Date.parse(shipDate),
          },
        };
      },
    },
  ],

  listing: {
    settingFields: [
      { key: "currency", label: "Currency (ISO 4217)", placeholder: "EUR" },
      {
        key: "condition",
        label: "Condition",
        options: [
          { value: "NEW", label: "New" },
          { value: "LIKE_NEW", label: "Like new" },
          { value: "USED_EXCELLENT", label: "Used — excellent" },
          { value: "USED_VERY_GOOD", label: "Used — very good" },
          { value: "USED_GOOD", label: "Used — good" },
          { value: "USED_ACCEPTABLE", label: "Used — acceptable" },
        ],
      },
      { key: "merchantLocationKey", label: "Merchant location key" },
      { key: "fulfillmentPolicyId", label: "Fulfilment policy ID" },
      { key: "paymentPolicyId", label: "Payment policy ID" },
      { key: "returnPolicyId", label: "Return policy ID" },
    ],
    columns: [
      { value: "title", label: "Title" },
      { value: "description", label: "Description (HTML)" },
      { value: "brand", label: "Brand (optional)" },
      { value: "mpn", label: "Manufacturer part number (optional)" },
      { value: "images", label: "Image URLs" },
    ],
    variantColumns: [
      { value: "sku", label: "Seller SKU" },
      { value: "quantity", label: "Stock quantity" },
      { value: "price", label: "Price" },
      { value: "ean", label: "EAN (optional)" },
      { value: "upc", label: "UPC (optional)" },
    ],
    /** The SKU addresses the inventory item and names the offer. */
    referenceColumn: "sku",
    outputs: [
      { key: "listingId", label: "eBay listing ID" },
      { key: "listingStatus", label: "Listing status" },
      { key: "listingError", label: "Rejection reason" },
      { key: "listedAt", label: "Listed at" },
    ],

    async categories(ctx) {
      const conn = readConnection(ctx, "listing");
      const treeId = await categoryTreeId(ctx, conn);
      const res = await ctx.fetch(
        `${conn.host}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}`,
        { headers: headersFor(conn) },
      );
      if (!res.ok) throw await readError(res, "read the category tree");
      const body = (await res.json()) as { rootCategoryNode?: Record<string, unknown> };
      const out: ListingCategory[] = [];
      // Nested, unlike the four that answer flat — so it is flattened HERE,
      // because a flat list with a parent pointer is what the engine's picker
      // wants and what the other providers already hand it. The walk starts at
      // the root's CHILDREN: the root is category 0, which is not a thing
      // anybody lists against, and offering it would put an unusable entry at
      // the top of every picker.
      const root = body.rootCategoryNode;
      const top = Array.isArray(root?.childCategoryTreeNodes)
        ? (root.childCategoryTreeNodes as Record<string, unknown>[])
        : [];
      for (const node of top) flatten(node, null, out);
      return out;
    },

    async attributes(ctx) {
      const conn = readConnection(ctx, "listing");
      const treeId = await categoryTreeId(ctx, conn);
      const url = new URL(`${conn.host}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category`);
      url.searchParams.set("category_id", ctx.categoryId);
      const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
      if (!res.ok) throw await readError(res, `read the aspects of category ${ctx.categoryId}`);
      const body = (await res.json()) as { aspects?: Record<string, unknown>[] };
      const out: ListingAttribute[] = [];
      for (const raw of body.aspects ?? []) {
        const name = text(raw.localizedAspectName);
        if (!name) continue;
        const c = (raw.aspectConstraint ?? {}) as Record<string, unknown>;
        const values = (Array.isArray(raw.aspectValues) ? raw.aspectValues : [])
          .map((v) => text((v as Record<string, unknown>).localizedValue))
          .filter((v): v is string => Boolean(v))
          .map((v) => ({ id: v, name: v }));
        out.push({
          // Keyed by NAME, like Hepsiburada — eBay has no aspect ids.
          id: name,
          name,
          required: c.aspectRequired === true,
          // SELECTION_ONLY is the only mode that refuses free text; the others
          // (FREE_TEXT) accept a value outside the list.
          allowCustom: text(c.aspectMode) !== "SELECTION_ONLY",
          // The one thing no other marketplace here reports.
          variant: c.aspectEnabledForVariations === true,
          multiple: text(c.itemToAspectCardinality) === "MULTI",
          values,
        });
      }
      return out.sort((a, b) => (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1));
    },

    async publish(ctx) {
      const conn = readConnection(ctx, "listing");
      const currency = (ctx.setting("currency") ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error("Set the listing's currency to an ISO 4217 code before publishing");
      }
      const policies = {
        fulfillmentPolicyId: ctx.setting("fulfillmentPolicyId") ?? "",
        paymentPolicyId: ctx.setting("paymentPolicyId") ?? "",
        returnPolicyId: ctx.setting("returnPolicyId") ?? "",
      };
      const merchantLocationKey = ctx.setting("merchantLocationKey") ?? "";
      if (!policies.fulfillmentPolicyId || !policies.paymentPolicyId || !policies.returnPolicyId || !merchantLocationKey) {
        // Refused here rather than per unit: these belong to the seller's
        // account, so if one is missing every unit in the batch fails the same
        // way and reporting it a hundred times helps nobody.
        throw new Error(
          "eBay needs the three business policy ids and a merchant location key on the sync before it will publish — create them in Seller Hub first",
        );
      }
      const condition = ctx.setting("condition") ?? "NEW";

      const settled: ListingVerdict[] = [];
      for (const product of ctx.products) {
        for (const variant of product.variants) {
          const sku = text(variant.fields.sku) ?? variant.reference;
          if (!sku) {
            settled.push({ reference: variant.reference, status: "rejected", errors: ["no seller SKU"] });
            continue;
          }
          try {
            const listingId = await listOne(ctx, conn, {
              sku,
              condition,
              currency,
              policies,
              merchantLocationKey,
              product,
              variant,
            });
            settled.push({ reference: variant.reference, status: "accepted", externalId: listingId });
          } catch (e) {
            // One unit's refusal is not the batch's. eBay answers per call, so
            // the next SKU is still worth trying — the alternative is a single
            // bad row stopping a catalogue.
            settled.push({
              reference: variant.reference,
              status: "rejected",
              errors: [e instanceof Error ? e.message : String(e)],
            });
          }
        }
      }
      // No ticket: eBay has answered. An empty batch id is what tells the engine
      // there is nothing to poll.
      return { batchId: "", settled };
    },

    // Required by the shape, and unreachable in practice: `publish` never
    // returns a batch id, so the sweep has nothing to ask about. Answering with
    // an empty list is the honest implementation of "nothing is outstanding".
    async poll() {
      return [];
    },
  },
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  host: string;
  marketplaceId: string;
  language: string;
  token: string;
}

const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const environment = ctx.str("environment");
  const host = HOSTS[(environment ?? "") as Environment] ?? HOSTS.production;

  const marketplaceId = ctx.str("marketplaceId");
  const market = MARKETPLACES.find((m) => m.value === marketplaceId);
  if (!market) throw new Error(`eBay ${what} has no marketplace — pick one before connecting`);

  const token = ctx.str("_oauthAccessToken");
  if (!token) throw new Error(`eBay ${what} is not connected — finish the OAuth consent first`);

  return {
    host,
    marketplaceId: market.value,
    // The override first: a seller may list in a language the marketplace's
    // default is not, and eBay refuses a value the marketplace does not serve
    // rather than translating it.
    language: (ctx.str("contentLanguage") ?? "").trim() || market.language,
    token,
  };
};

const headersFor = (conn: Connection): Record<string, string> => ({
  Authorization: `Bearer ${conn.token}`,
  Accept: "application/json",
  "X-EBAY-C-MARKETPLACE-ID": conn.marketplaceId,
  "Content-Language": conn.language,
});

/**
 * eBay's errors are `{errors:[{errorId, message, longMessage, parameters}]}`.
 *
 * `longMessage` is the one written for a person; `message` is the summary. The
 * first is quoted when present because a seller reading "Invalid value" learns
 * nothing about which of forty aspects it was.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { errors?: { message?: string; longMessage?: string }[] };
    const first = body.errors?.[0];
    detail = (first?.longMessage ?? first?.message ?? detail).slice(0, 200);
  } catch {
    // Not JSON — a gateway or an HTML error page. The truncated body is still
    // the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `eBay refused the request and could not ${what} — the connection may need re-authorizing, or the application is missing a scope${detail ? `: ${detail}` : ""}`,
    );
  }
  return new Error(`eBay responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

// ── Orders ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : 7;
};

/** Cursor is `<sinceMs>:<offset>`; a bare number is a finished window's end. */
const readSince = (cursor: string | null, lookbackDays: number): number => {
  if (cursor) {
    const [since] = cursor.split(":");
    const n = Number(since);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now() - lookbackDays * DAY_MS;
};

const readOffset = (cursor: string | null): number => {
  if (!cursor) return 0;
  const parts = cursor.split(":");
  const n = Number(parts[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const orderData = (o: Record<string, unknown>): Record<string, unknown> => {
  const ship = Array.isArray(o.fulfillmentStartInstructions)
    ? ((o.fulfillmentStartInstructions[0] ?? {}) as Record<string, unknown>)
    : {};
  const dest = ((ship.shippingStep ?? {}) as Record<string, unknown>).shipTo as Record<string, unknown> | undefined;
  const address = (dest?.contactAddress ?? {}) as Record<string, unknown>;
  const pricing = (o.pricingSummary ?? {}) as Record<string, unknown>;
  const total = (pricing.total ?? {}) as Record<string, unknown>;
  return {
    orderId: text(o.orderId),
    creationDate: text(o.creationDate),
    lastModifiedDate: text(o.lastModifiedDate),
    orderFulfillmentStatus: text(o.orderFulfillmentStatus),
    orderPaymentStatus: text(o.orderPaymentStatus),
    buyerUsername: text(((o.buyer ?? {}) as Record<string, unknown>).username),
    salesRecordReference: text(o.salesRecordReference),
    total: num(total.value),
    currency: text(total.currency),
    recipientName: text(dest?.fullName),
    addressLine1: text(address.addressLine1),
    addressLine2: text(address.addressLine2),
    city: text(address.city),
    stateOrProvince: text(address.stateOrProvince),
    postalCode: text(address.postalCode),
    countryCode: text(address.countryCode),
    phone: text((dest?.primaryPhone as Record<string, unknown> | undefined)?.phoneNumber),
  };
};

const lineData = (l: Record<string, unknown>): Record<string, unknown> => {
  const cost = (l.lineItemCost ?? {}) as Record<string, unknown>;
  return {
    lineItemId: text(l.lineItemId),
    sku: text(l.sku),
    legacyItemId: text(l.legacyItemId),
    title: text(l.title),
    quantity: num(l.quantity),
    unitPrice: num(cost.value),
    currency: text(cost.currency),
    fulfillmentStatus: text(l.lineItemFulfillmentStatus),
  };
};

// ── Listing ──────────────────────────────────────────────────────────────────

/** The tree id for this marketplace. One call, and it changes about never. */
const categoryTreeId = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
): Promise<string> => {
  const url = new URL(`${conn.host}/commerce/taxonomy/v1/get_default_category_tree_id`);
  url.searchParams.set("marketplace_id", conn.marketplaceId);
  const res = await ctx.fetch(url.toString(), { headers: headersFor(conn) });
  if (!res.ok) throw await readError(res, "read the category tree id");
  const body = (await res.json()) as { categoryTreeId?: unknown };
  const id = text(body.categoryTreeId);
  if (!id) throw new Error(`eBay named no category tree for ${conn.marketplaceId}`);
  return id;
};

/** Walk eBay's nested tree into the flat list with parent pointers. */
const flatten = (node: Record<string, unknown> | undefined, parentId: string | null, out: ListingCategory[]): void => {
  if (!node || out.length >= MAX_CATEGORY_NODES) return;
  const category = (node.category ?? {}) as Record<string, unknown>;
  const id = text(category.categoryId);
  const children = Array.isArray(node.childCategoryTreeNodes)
    ? (node.childCategoryTreeNodes as Record<string, unknown>[])
    : [];
  if (id) {
    out.push({
      id,
      name: text(category.categoryName) ?? id,
      parentId,
      // eBay says so itself rather than leaving it to be inferred from an
      // empty child list.
      leaf: node.leafCategoryTreeNode === true,
    });
  }
  for (const child of children) flatten(child, id ?? parentId, out);
};

/** Create the item, make the offer, publish it. Returns the listing id. */
const listOne = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  args: {
    sku: string;
    condition: string;
    currency: string;
    policies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string };
    merchantLocationKey: string;
    product: { categoryId: string; fields: Record<string, unknown> };
    variant: { fields: Record<string, unknown>; attributes: readonly { attributeId: string; valueId?: string; custom?: string }[] };
  },
): Promise<string> => {
  const { sku, product, variant } = args;
  const quantity = num(variant.fields.quantity) ?? 0;

  // eBay's own spec types this `string`; it is a map of aspect name to an
  // ARRAY of values, and every marketplace-facing value is a string.
  const aspects: Record<string, string[]> = {};
  for (const binding of variant.attributes) {
    const value = binding.valueId ?? binding.custom;
    if (!binding.attributeId || value === undefined || value === "") continue;
    (aspects[binding.attributeId] ??= []).push(String(value));
  }

  const images = splitList(product.fields.images);
  const ean = text(variant.fields.ean);
  const upc = text(variant.fields.upc);

  const itemRes = await ctx.fetch(`${conn.host}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    headers: { ...headersFor(conn), "Content-Type": "application/json" },
    body: JSON.stringify({
      availability: { shipToLocationAvailability: { quantity } },
      condition: args.condition,
      product: {
        title: text(product.fields.title) ?? "",
        description: text(product.fields.description) ?? "",
        ...(text(product.fields.brand) ? { brand: text(product.fields.brand) } : {}),
        ...(text(product.fields.mpn) ? { mpn: text(product.fields.mpn) } : {}),
        ...(images.length > 0 ? { imageUrls: images } : {}),
        ...(ean ? { ean: [ean] } : {}),
        ...(upc ? { upc: [upc] } : {}),
        ...(Object.keys(aspects).length > 0 ? { aspects } : {}),
      },
    }),
  });
  // 204 on success, and no body — an inventory item is a record, not a listing.
  if (!itemRes.ok) throw await readError(itemRes, `describe ${sku}`);

  const offerRes = await ctx.fetch(`${conn.host}/sell/inventory/v1/offer`, {
    method: "POST",
    headers: { ...headersFor(conn), "Content-Type": "application/json" },
    body: JSON.stringify({
      sku,
      marketplaceId: conn.marketplaceId,
      format: "FIXED_PRICE",
      categoryId: product.categoryId,
      listingDescription: text(product.fields.description) ?? "",
      availableQuantity: quantity,
      pricingSummary: { price: { value: String(num(variant.fields.price) ?? 0), currency: args.currency } },
      listingPolicies: args.policies,
      merchantLocationKey: args.merchantLocationKey,
    }),
  });
  if (!offerRes.ok) throw await readError(offerRes, `offer ${sku}`);
  const offer = (await offerRes.json().catch(() => ({}))) as { offerId?: unknown };
  const offerId = text(offer.offerId);
  if (!offerId) throw new Error(`eBay returned no offer id for ${sku}`);

  const pubRes = await ctx.fetch(
    `${conn.host}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    { method: "POST", headers: { ...headersFor(conn), "Content-Type": "application/json" } },
  );
  if (!pubRes.ok) throw await readError(pubRes, `publish ${sku}`);
  const published = (await pubRes.json().catch(() => ({}))) as { listingId?: unknown };
  const listingId = text(published.listingId);
  // A publish with no listing id did not list. Reporting it as accepted would
  // put a green tick on a product nobody can buy.
  if (!listingId) throw new Error(`eBay published ${sku} without returning a listing id`);
  return listingId;
};

// ── Shared ───────────────────────────────────────────────────────────────────

/**
 * Read a value the task's settings pointed at.
 *
 * Every `*Field` setting names a COLUMN on the row rather than a value, which
 * is the convention every task in this package follows.
 */
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
