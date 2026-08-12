import {
  defineProvider,
  type DestinationRow,
  type ListingAttribute,
  type ListingCategory,
  type ListingProduct,
  type ListingVariant,
  type ListingVerdict,
} from "../provider";
import { takeToken } from "../throttle";

/**
 * Çiçeksepeti — a seller's orders in, stock and price out, and the fulfilment
 * statuses the marketplace drives its customer notifications from.
 *
 * The fourth marketplace. Like the two before it, no engine change was needed;
 * unlike them, the thing worth reading before touching this file is the pacing.
 *
 * **The rate limits are per request BODY, and they are severe.** Çiçeksepeti
 * publishes them per endpoint rather than per account:
 *
 * | endpoint | same body | different body |
 * |---|---|---|
 * | `Order/GetOrders` | 1 / minute | 1 / 5 seconds |
 * | `Order/statusupdate…` | — | 1 / 5 seconds |
 * | `Products/price-and-stock` | 1 / 30 minutes | 1 / second |
 * | `Products/batch-status` | 1 / minute | 5 / second |
 *
 * A page walk changes the body every page, so it is the five-second rule that
 * binds — the same shape as Trendyol's order stream, and paced the same way:
 * from the engine's own bucket, keyed per endpoint and per seller, rather than
 * as a provider-wide `limits` that would put five seconds in front of an
 * operator clicking a button. See {@link ORDERS_PACE}.
 *
 * **The date filter's meaning is not documented.** `startDate` is described as
 * "orders after this date" without saying whether that is the order date or the
 * last modification — and the response carries `orderModifyDate`, so both are
 * plausible. That is not a coin worth flipping: this source re-walks a rolling
 * window every run rather than advancing a watermark past it, which is correct
 * under either reading. Rows are upserted, so re-reading costs a request, and
 * getting it wrong the other way would freeze every order at the status it was
 * created with.
 *
 * **A main order splits into sub-orders, and every operation is per sub-order.**
 * `GetOrders` returns one entry per `orderItemId`, and status, cargo barcode and
 * delivery all address that id. They are grouped here into one record per
 * `orderId` with the sub-orders as lines, matching the other three marketplaces
 * — and the tasks find their own sub-order ids, exactly as n11's does.
 */

/** Where the API lives, per environment. A closed set: never built from input. */
const BASES = {
  production: "https://apis.ciceksepeti.com/api/v1",
  sandbox: "https://sandbox-apis.ciceksepeti.com/api/v1",
} as const;

/** Çiçeksepeti's cap on one page of orders, and on one price-and-stock call. */
const PAGE = 100;
const MAX_ITEMS = 200;

/**
 * The pace `GetOrders` asks for: one request per five seconds.
 *
 * Taken from the engine's own bucket rather than declared as the provider's
 * `limits`, because the quotas genuinely differ per endpoint — a status update
 * is something an operator triggers and waits for, and pacing it at the order
 * walk's rate would mean a five-second stall on a button. Keyed by seller for
 * the same reason the engine's bucket is: two workspaces holding two sellers'
 * keys have two independent quotas.
 */
const ORDERS_PACE = { rps: 0.2, burst: 1 } as const;

/** The widest window the orders feed accepts, and the one a run re-reads. */
const MAX_WINDOW_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;

/** How long to wait before asking what became of a submitted batch. */
const BATCH_SETTLE_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The statuses a sub-order moves through, verbatim from the documentation.
 *
 * They are the vocabulary of BOTH directions — the `statusId` a pull may filter
 * on and the `orderItemStatusId` a task sends back — so there is one list rather
 * than two that could drift.
 */
const STATUSES = [
  { id: 1, key: "new", label: "New" },
  { id: 2, key: "preparing", label: "Preparing" },
  { id: 3, key: "in_vehicle", label: "Loaded on a vehicle" },
  { id: 5, key: "shipped", label: "Handed to the carrier" },
  { id: 7, key: "delivered", label: "Delivered" },
  { id: 11, key: "ready_to_ship", label: "Ready for the carrier" },
  { id: 18, key: "returned", label: "Returned to the seller" },
] as const;

/**
 * The couriers Çiçeksepeti knows, by the id it wants on a status update.
 *
 * A closed set with the ids the documentation publishes, so an operator picks a
 * courier rather than typing a number nobody can check. A courier missing from
 * this list has to be registered by Çiçeksepeti for the seller first, which is
 * not something a free-text field could have helped with.
 */
const CARGO_COMPANIES = [
  { value: "1", label: "MNG Kargo" },
  { value: "2", label: "Yurtiçi Kargo" },
  { value: "25", label: "Sürat Kargo" },
  { value: "43", label: "Aras Kargo" },
  { value: "44", label: "PTT Kargo" },
  { value: "45", label: "UPS Kargo" },
  { value: "46", label: "Horoz Lojistik" },
  { value: "55", label: "Ceva Lojistik" },
  { value: "59", label: "Sendeo" },
  { value: "116", label: "kargomSENDE" },
  { value: "117", label: "Kolay Gelsin" },
  { value: "118", label: "Arvato Lojistik" },
] as const;

export const ciceksepeti = defineProvider({
  id: "ciceksepeti",
  label: "Çiçeksepeti",
  category: "marketplace",
  capabilities: ["source", "destination", "task", "listing"],
  /**
   * A modest provider-wide pace, under the loosest published rule (one request
   * a second on the price upload). The endpoint that is genuinely slower takes
   * its own token — see {@link ORDERS_PACE}.
   */
  limits: { rps: 1, burst: 2 },
  configFields: [
    { key: "apiKey", label: "API key", secret: true },
    {
      key: "sellerId",
      label: "Seller ID",
      placeholder: "the seller id from Hesap Yönetimi → Entegrasyon Bilgilerim",
    },
    {
      key: "integrator",
      label: "Integrator name (optional)",
      placeholder: "only if you work through an integrator — leave empty otherwise",
    },
    {
      key: "environment",
      label: "Environment",
      options: [
        { value: "production", label: "Production" },
        { value: "sandbox", label: "Sandbox" },
      ],
    },
  ],
  source: {
    childGroups: [{ key: "lines", label: "Sub-orders" }],
    settingFields: [
      {
        key: "lookbackDays",
        label: "Each run re-reads",
        options: [
          { value: "1", label: "Last 24 hours" },
          { value: "7", label: "Last 7 days" },
          { value: "14", label: "Last 14 days (max)" },
        ],
      },
    ],
    /**
     * One page of orders inside a rolling window.
     *
     * The window does not advance between runs. Çiçeksepeti does not say
     * whether its date filter bounds the order date or the modification date,
     * and a watermark that marched forward is only correct under one of those
     * readings — under the other it would see each order exactly once, in the
     * status it was created with. Re-reading is correct under both.
     *
     * There is deliberately no status filter, for the same reason the other
     * marketplaces have none: a sync mirrors what the marketplace holds, and
     * filtering here would freeze a row at the status it had when it was first
     * seen. Narrowing belongs to a view over the collection.
     */
    async pull(ctx) {
      const conn = readConnection(ctx, "sync");
      const page = readPage(ctx.cursor);

      const now = Date.now();
      const lookback = readLookbackDays(ctx.setting("lookbackDays"));

      const body = {
        startDate: new Date(now - lookback * DAY_MS).toISOString(),
        endDate: new Date(now).toISOString(),
        pageSize: Math.min(ctx.limit, PAGE),
        page,
      };

      await takeToken(`ciceksepeti:orders:${conn.sellerId}`, ORDERS_PACE);
      const res = await ctx.fetch(`${conn.base}/Order/GetOrders`, {
        method: "POST",
        headers: { ...conn.headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await readError(res, "read the orders");

      const answer = (await res.json()) as {
        orderListCount?: unknown;
        supplierOrderListWithBranch?: Record<string, unknown>[];
      };
      const raw = answer.supplierOrderListWithBranch ?? [];
      const records = groupByOrder(raw);

      // `orderListCount` is the total across the window, so the walk ends when
      // this page did not fill — and always on an empty page, whatever the
      // count claims.
      const more = raw.length >= body.pageSize;
      return { records, cursor: more ? String(page + 1) : null };
    },
  },
  destination: {
    settingFields: [
      {
        key: "updates",
        label: "What to send",
        options: [
          { value: "stock", label: "Stock only" },
          { value: "price", label: "Price only" },
          { value: "both", label: "Stock and price" },
        ],
      },
    ],
    /**
     * Çiçeksepeti's cap on one call. The engine's default batch is larger, so
     * declaring it here is what stops a push being refused wholesale for a
     * batch nobody chose the size of.
     */
    batchSize: MAX_ITEMS,
    columns: [
      { value: "stockCode", label: "Seller variant code" },
      { value: "stockQuantity", label: "Stock quantity", when: { updates: ["stock", "both"] } },
      { value: "salesPrice", label: "Sale price", when: { updates: ["price", "both"] } },
      { value: "listPrice", label: "Struck-through price", when: { updates: ["price", "both"] } },
    ],
    async push(ctx) {
      const conn = readConnection(ctx, "write-back");
      const mode = ctx.setting("updates") ?? "both";

      const items: Record<string, unknown>[] = [];
      for (const row of ctx.rows) {
        const item = itemFor(row, mode);
        // A row with no variant code addresses no listing. Skipped rather than
        // sent: Çiçeksepeti keys every update on it.
        if (item) items.push(item);
      }
      if (items.length === 0) {
        throw new Error(
          "No row in the batch had a variant code and something to update — check the column mapping",
        );
      }

      const res = await ctx.fetch(`${conn.base}/Products/price-and-stock`, {
        method: "PUT",
        headers: { ...conn.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ items: items.slice(0, MAX_ITEMS) }),
      });
      if (!res.ok) throw await readError(res, "update stock and price");

      const body = (await res.json().catch(() => ({}))) as { batchId?: unknown };
      const batchId = text(body.batchId);
      if (batchId) await verifyBatch(ctx, conn, batchId);
    },
  },
  /**
   * One task per transition, because the once-only guard is keyed by
   * (integration, task, row) — a single set-status task would move an order to
   * "preparing" and then refuse to ship it, handing back the first run's answer
   * instead of telling the marketplace anything.
   *
   * `mark_shipped` is the one with a real payload: Çiçeksepeti drives the
   * customer's email and SMS from it, so the courier and the tracking number
   * are required rather than optional. `mark_in_vehicle` exists because an
   * order delivered by Çiçeksepeti's own service vehicle is REFUSED the
   * "handed to the carrier" status — a different word for a different thing,
   * and one an operator would otherwise discover from an error message.
   */
  /**
   * Putting a product ON SALE, which the destination above cannot do — it
   * addresses a listing that already exists, by variant code.
   *
   * **Read this before changing a field name.** Çiçeksepeti's own product
   * documentation contradicts itself: its parameter TABLE names the price and
   * stock fields `StockQuantity` / `TotalPrice` / `FirstPrice`, while its own
   * request EXAMPLE sends `stockQuantity` / `salesPrice` / `listPrice`. The
   * example wins, and not as a guess — the batch-status endpoint ECHOES the
   * stored record back as `stockQuantity` / `salesPrice` / `listPrice`, so
   * those are the names the service actually stores. The table is stale
   * internal vocabulary.
   *
   * Casing is a non-issue either way: their own example mixes `"id"` and
   * `"Id"` inside one attribute array, which only a case-insensitive binder
   * tolerates.
   */
  listing: {
    settingFields: [
      {
        key: "deliveryType",
        label: "How it is delivered",
        options: [
          { value: "1", label: "By Çiçeksepeti's service vehicle" },
          { value: "2", label: "By carrier" },
          { value: "3", label: "By carrier or service vehicle" },
        ],
      },
      {
        key: "deliveryMessageType",
        label: "Delivery promise",
        options: [
          { value: "5", label: "Gift delivery, 1-5 working days" },
          { value: "6", label: "Gift delivery, 1-10 working days" },
          { value: "7", label: "Gift delivery, 1-7 working days" },
          { value: "13", label: "Gift delivery, 3-5 working days" },
        ],
      },
    ],
    columns: [
      { value: "productName", label: "Product name" },
      { value: "description", label: "Description (min 30 characters)" },
      { value: "images", label: "Image URLs (500x500 to 2000x2000)" },
      { value: "supplierDescription", label: "Supplier note (optional)" },
    ],
    /**
     * Per-unit fields.
     *
     * `stockCode` is Çiçeksepeti's "tedarikçi VARYANT kodu" — the per-unit one —
     * where `mainProductCode` is the product's. The engine supplies the latter
     * from the product row's key as `groupId`, which is why it is not a column:
     * two places naming one product page is how a variant set gets orphaned.
     */
    variantColumns: [
      { value: "stockCode", label: "Variant code" },
      { value: "barcode", label: "Barcode (optional, 3-50 characters)" },
      { value: "stockQuantity", label: "Stock quantity" },
      { value: "salesPrice", label: "Sale price" },
      { value: "listPrice", label: "Struck-through price (optional)" },
    ],
    // Çiçeksepeti echoes the stored record on `items[].data`, and `stockCode`
    // is the field of ours that survives the round trip.
    referenceColumn: "stockCode",
    outputs: [
      { key: "listingId", label: "Çiçeksepeti variant code (listing id)" },
      { key: "listingStatus", label: "Listing status" },
      { key: "listingError", label: "Rejection reason" },
      { key: "listedAt", label: "Listed at" },
    ],

    /** The whole tree, flattened. */
    async categories(ctx) {
      const conn = readConnection(ctx, "listing");
      const res = await ctx.fetch(`${conn.base}/Categories`, { headers: conn.headers });
      if (!res.ok) throw await readError(res, "read the categories");
      const body = (await res.json()) as { categories?: unknown };

      const out: ListingCategory[] = [];
      // Iterative, and BOTH ways of expressing the tree are read: Çiçeksepeti
      // returns `parentCategoryId` on every node AND nests them under
      // `subCategories`, so a walk that trusted only one would either miss the
      // depth or mis-parent the roots.
      const stack: { node: unknown; parentId: string | null }[] = [];
      for (const node of asArray(body.categories)) stack.push({ node, parentId: null });
      let guard = 0;
      while (stack.length > 0 && guard++ < 50_000) {
        const { node, parentId } = stack.pop()!;
        const row = obj(node);
        const id = text(row.id);
        if (!id) continue;
        const kids = asArray(row.subCategories);
        out.push({
          id,
          name: text(row.name) ?? id,
          parentId: text(row.parentCategoryId) ?? parentId,
          leaf: kids.length === 0,
        });
        for (const kid of kids) stack.push({ node: kid, parentId: id });
      }
      return out;
    },

    /**
     * What one category demands.
     *
     * The one marketplace here that encodes a THIRD state in a Turkish string
     * rather than a boolean: `type` is "Ürün Özelliği" (an ordinary attribute),
     * "Variant Özelliği" (one that tells two units apart), or
     * "Kişiselleştirilebilir Özellik" (one that asks the BUYER for text at
     * checkout). The third is not a value a seller supplies at all, so it is
     * dropped rather than offered — putting it in the mapping form would invite
     * an operator to answer a question meant for a customer, and Çiçeksepeti
     * refuses it on an ordinary product.
     */
    async attributes(ctx) {
      const conn = readConnection(ctx, "listing");
      const categoryId = numericId(ctx.categoryId, "category id");
      const res = await ctx.fetch(`${conn.base}/Categories/${categoryId}/attributes`, {
        headers: conn.headers,
      });
      if (!res.ok) throw await readError(res, "read the category attributes");
      const body = (await res.json()) as { categoryAttributes?: unknown };

      const out: ListingAttribute[] = [];
      for (const raw of asArray(body.categoryAttributes)) {
        const row = obj(raw);
        const id = text(row.attributeId);
        if (!id) continue;
        const kind = text(row.type) ?? "";
        if (kind.startsWith("Kişiselleştirilebilir")) continue;
        out.push({
          id,
          name: text(row.attributeName) ?? id,
          required: row.required === true,
          // Çiçeksepeti spells it `varianter`, and its `type` string says the
          // same thing a second way; either is enough.
          variant: row.varianter === true || kind.startsWith("Variant"),
          // Every offered attribute is picked from the category's own list —
          // there is no free-text flag, and an unknown value is refused.
          allowCustom: false,
          multiple: false,
          values: asArray(row.attributeValues)
            .map((v) => {
              const val = obj(v);
              const vid = text(val.id);
              return vid ? { id: vid, name: text(val.name) ?? vid } : null;
            })
            .filter((v): v is { id: string; name: string } => v !== null),
        });
      }
      return out;
    },

    async publish(ctx) {
      const conn = readConnection(ctx, "listing");
      const deliveryType = readChoice(ctx.setting("deliveryType"), ["1", "2", "3"], "2");
      const deliveryMessageType = readChoice(ctx.setting("deliveryMessageType"), ["5", "6", "7", "13"], "5");

      const products: Record<string, unknown>[] = [];
      const rejected: ListingVerdict[] = [];
      for (const product of ctx.products) {
        for (const variant of product.variants) {
          const built = buildProduct(product, variant, { deliveryType, deliveryMessageType });
          if (typeof built === "string") {
            rejected.push({ reference: variant.reference, status: "rejected", errors: [built] });
            continue;
          }
          products.push(built);
        }
      }

      if (products.length === 0) return { batchId: "", rejected };
      if (products.length > MAX_LISTING_ITEMS) {
        throw new Error(
          `Çiçeksepeti accepts ${MAX_LISTING_ITEMS} items per request, and this batch has ${products.length}`,
        );
      }

      // One request per five seconds, and this bucket is the CREATE's own:
      // Çiçeksepeti meters it per distinct request body, and a publish must not
      // queue behind an order walk that is paced for a different reason.
      await takeToken(`ciceksepeti:listing:${conn.sellerId}`, LISTING_PACE);

      const res = await ctx.fetch(`${conn.base}/Products`, {
        method: "POST",
        headers: { ...conn.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ products }),
      });
      if (!res.ok) throw await readError(res, "create the products");

      const body = (await res.json().catch(() => ({}))) as { batchId?: unknown };
      const batchId = text(body.batchId);
      if (!batchId) {
        // A 200 with no ticket is not a success we can follow up. Treating it
        // as one would strand every unit at `pending` forever.
        throw new Error("Çiçeksepeti accepted the products but returned no batchId");
      }
      return { batchId, ...(rejected.length > 0 ? { rejected } : {}) };
    },

    /**
     * What became of a batch. Creation takes up to 24 hours, so `Pending` and
     * `Processing` are the normal answer for most of a batch's life.
     *
     * **`Warning` is a SUCCESS.** Çiçeksepeti's own table reads "İşlem başarılı
     * ancak gönderilen istek kontrol edilmeli" — the product listed, and the
     * note is usually about pricing law. Treating it as a failure would report
     * a live listing as refused, and the reason is still carried through so the
     * operator can read it.
     */
    async poll(ctx) {
      const conn = readConnection(ctx, "listing");
      const batchId = ctx.batchId.trim();
      // The ticket is Çiçeksepeti's own GUID and goes into a URL PATH, so it is
      // checked rather than trusted: it round-trips through our database first.
      if (!/^[A-Za-z0-9-]{1,64}$/.test(batchId)) throw new Error("Çiçeksepeti batch id is not a batch id");

      const res = await ctx.fetch(`${conn.base}/Products/batch-status/${batchId}`, {
        headers: conn.headers,
      });
      if (!res.ok) throw await readError(res, "read the listing batch");
      const body = (await res.json()) as { items?: unknown };

      const out: ListingVerdict[] = [];
      for (const raw of asArray(body.items)) {
        const row = obj(raw);
        // The stored record comes back under `data`, and its `stockCode` is the
        // only place our reference survives.
        const reference = text(obj(row.data).stockCode);
        if (!reference) continue;
        const status = text(row.status);
        const errors = asArray(row.failureReasons)
          .map((r) => text(obj(r).message))
          .filter((r): r is string => r !== null);

        if (status === "Success" || status === "Warning") {
          // Çiçeksepeti addresses a listing by the seller's own variant code —
          // it mints no separate id — so the variant code IS the listing's id.
          out.push({ reference, status: "accepted", externalId: reference });
        } else if (status === "Failed") {
          out.push({
            reference,
            status: "rejected",
            errors: errors.length > 0 ? errors : ["Çiçeksepeti refused it without giving a reason"],
          });
        } else {
          out.push({ reference, status: "pending" });
        }
      }
      return out;
    },
  },
  tasks: [
    statusTask("mark_preparing", "Mark as preparing", 2),
    statusTask("mark_ready_to_ship", "Mark as ready for the carrier", 11),
    statusTask("mark_shipped", "Mark as handed to the carrier", 5),
    statusTask("mark_in_vehicle", "Mark as loaded on a service vehicle", 3),
    statusTask("mark_delivered", "Mark as delivered", 7),
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  sellerId: string;
  base: string;
  headers: Record<string, string>;
}

/**
 * Read the credentials and turn them into the headers every call needs.
 *
 * Both values reach a header verbatim, so both are checked rather than
 * forwarded — a header built from unchecked config is how a newline ends up in
 * one.
 */
const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const apiKey = ctx.str("apiKey");
  if (!apiKey) throw new Error(`Çiçeksepeti ${what} has no API key`);
  const sellerId = ctx.str("sellerId");
  if (!sellerId) throw new Error(`Çiçeksepeti ${what} has no seller id`);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(sellerId)) {
    throw new Error("Çiçeksepeti seller id must be the plain id from your integration details");
  }
  if (/[^\x20-\x7E]/.test(apiKey)) {
    throw new Error("Çiçeksepeti API key must be plain ASCII — check for a bad paste");
  }

  const integrator = ctx.str("integrator");
  if (integrator && !/^[A-Za-z0-9 ._-]{1,60}$/.test(integrator)) {
    throw new Error("Çiçeksepeti integrator name may only hold letters, digits, spaces, dots and dashes");
  }

  const environment = ctx.str("environment");
  const base = environment === "sandbox" ? BASES.sandbox : BASES.production;

  return {
    sellerId,
    base,
    headers: {
      "x-api-key": apiKey,
      // Documented as the seller id alone when the seller integrates directly,
      // and "sellerId-integrator" when they work through one. Çiçeksepeti uses
      // it to tell which integrator a request came from.
      "user-agent": integrator ? `${sellerId}-${integrator}` : sellerId,
      Accept: "application/json",
    },
  };
};

// ── Orders ───────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_WINDOW_DAYS ? Math.floor(n) : DEFAULT_LOOKBACK_DAYS;
};

/**
 * Which page this request asks for.
 *
 * The cursor round-trips through the database, so it is re-derived as a number
 * rather than echoed. Anything else restarts the walk, which is the harmless
 * answer when every row is upserted.
 */
const readPage = (cursor: string | null): number => {
  const n = cursor === null ? 0 : Number(cursor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * A flat list of sub-orders, grouped into one record per main order.
 *
 * Çiçeksepeti returns one entry per `orderItemId` and states plainly that two
 * of them can share an `orderId`. The header values — customer, addresses,
 * dates — are repeated on every entry, so the first one carries them.
 *
 * An order split across two pages is not a problem: children are upserted, so
 * the second page adds the sub-orders the first did not carry.
 */
const groupByOrder = (
  raw: Record<string, unknown>[],
): { externalId: string; data: Record<string, unknown>; children: Record<string, Child[]> }[] => {
  const byOrder = new Map<string, { data: Record<string, unknown>; lines: Child[] }>();
  for (const item of raw) {
    const orderId = text(item.orderId);
    if (!orderId) continue;
    const orderItemId = text(item.orderItemId);
    if (!orderItemId) continue;

    let entry = byOrder.get(orderId);
    if (!entry) {
      entry = { data: orderData(item), lines: [] };
      byOrder.set(orderId, entry);
    }
    entry.lines.push({ externalId: orderItemId, data: subOrderData(item) });
  }
  return [...byOrder.entries()].map(([externalId, e]) => ({
    externalId,
    data: e.data,
    children: { lines: e.lines },
  }));
};

interface Child {
  externalId: string;
  data: Record<string, unknown>;
}

/**
 * One order, taken from any of its sub-orders.
 *
 * Addresses are spread into their parts rather than handed over as objects: a
 * mapping targets one column. Çiçeksepeti names them il / ilçe / mahalle as
 * `receiverCity` / `receiverDistrict` / `receiverRegion` — and note that its
 * `Region` is the mahalle and its `District` the ilçe, which is worth writing
 * down once rather than rediscovering from a mis-addressed parcel.
 */
const orderData = (o: Record<string, unknown>): Record<string, unknown> => ({
  orderId: o.orderId ?? null,
  branchId: o.branchId ?? null,
  customerId: o.customerId ?? null,
  accountCode: o.accountCode ?? null,
  orderCreateDate: joinDateTime(o.orderCreateDate, o.orderCreateTime),
  orderModifyDate: joinDateTime(o.orderModifyDate, o.orderModifyTime),
  status: o.orderProductStatus ?? null,
  statusId: o.orderItemStatusId ?? null,
  isOrderStatusActive: o.isOrderStatusActive ?? null,
  paymentType: o.orderPaymentType ?? null,

  totalPrice: o.totalPrice ?? null,
  discount: o.discount ?? null,
  tax: o.tax ?? null,
  cargoPrice: o.cargoPrice ?? null,
  deliveryCharge: o.deliveryCharge ?? null,
  invoicePrice: o.invoicePrice ?? null,
  isInvoiceSent: o.isInvoiceSent ?? null,
  invoiceEmail: o.invoiceEmail ?? null,

  deliveryType: o.deliveryType ?? null,
  deliveryDate: o.deliveryDate ?? null,
  requestedDeliveryDate: o.requestedDeliveryDate ?? null,
  cargoCompany: o.cargoCompany ?? null,
  cargoNumber: o.cargoNumber ?? null,
  shipmentTrackingUrl: o.shipmentTrackingUrl ?? null,
  partialNumber: o.partialNumber ?? null,
  cargoModelType: o.cargoModelType ?? null,

  receiverName: o.receiverName ?? null,
  receiverPhone: o.receiverPhone ?? null,
  receiverAddress: o.receiverAddress ?? null,
  receiverNeighbourhood: o.receiverRegion ?? null,
  receiverDistrict: o.receiverDistrict ?? null,
  receiverCity: o.receiverCity ?? null,

  senderName: o.senderName ?? null,
  senderAddress: o.senderAddress ?? null,
  senderDistrict: o.senderRegion ?? null,
  senderCity: o.senderCity ?? null,
  senderCompanyName: o.senderCompanyName ?? null,
  senderTaxNumber: o.senderTaxNumber ?? null,
  senderTaxOffice: o.senderTaxOfficeName ?? null,

  // The customer's card note and the video message they recorded for it. This
  // is a flower marketplace: the note is not decoration, it is the product.
  cardMessage: o.cardMessage ?? null,
  qrCodeMessage: o.qrCodeMessage ?? null,
  cancellationResult: o.cancellationResult ?? null,
});

const subOrderData = (o: Record<string, unknown>): Record<string, unknown> => ({
  orderItemId: o.orderItemId ?? null,
  productId: o.productId ?? null,
  productCode: o.productCode ?? null,
  stockCode: o.code ?? null,
  name: o.name ?? null,
  barcode: o.barcode ?? null,
  quantity: o.quantity ?? null,
  quantityUnit: o.quantityUnit ?? null,
  status: o.orderProductStatus ?? null,
  statusId: o.orderItemStatusId ?? null,
  itemPrice: o.itemPrice ?? null,
  totalPrice: o.totalPrice ?? null,
  discount: o.discount ?? null,
  tax: o.tax ?? null,
  allowanceRate: o.allowanceRate ?? null,
  cargoNumber: o.cargoNumber ?? null,
  shipmentTrackingUrl: o.shipmentTrackingUrl ?? null,
  cardMessage: o.cardMessage ?? null,
});

/**
 * Çiçeksepeti splits a timestamp across two fields — `02/01/2020` and `17:54`.
 * Joined into one value so a mapping onto a single column reads as a moment
 * rather than as a date with the time lost.
 */
const joinDateTime = (date: unknown, time: unknown): string | null => {
  const d = text(date);
  if (!d) return null;
  const t = text(time);
  return t ? `${d} ${t}` : d;
};

// ── Stock and price ──────────────────────────────────────────────────────────

/**
 * One mapped row as a price-and-stock item, or `null` when it addresses
 * nothing.
 *
 * Only the fields this sync is FOR are sent: an omitted field is left alone, so
 * a stock-only sync that also sent a price would overwrite whatever the seller
 * set in their panel.
 *
 * A struck-through price is never sent alone — Çiçeksepeti requires the sale
 * price alongside it and refuses the item otherwise.
 */
const itemFor = (row: DestinationRow, mode: string): Record<string, unknown> | null => {
  const stockCode = text(row.stockCode);
  if (!stockCode) return null;
  const item: Record<string, unknown> = { stockCode };

  if (mode !== "price") {
    const quantity = num(row.stockQuantity);
    // Whole units, and a negative stock is a mapping error rather than an
    // oversell to publish.
    if (quantity !== null) item.stockQuantity = Math.max(0, Math.floor(quantity));
  }
  if (mode !== "stock") {
    const salesPrice = num(row.salesPrice);
    const listPrice = num(row.listPrice);
    if (salesPrice !== null) {
      item.salesPrice = salesPrice;
      // Only when a struck-through price was actually mapped. Defaulting it to
      // the sale price would publish a nil discount that the seller's own panel
      // never asked for — and Çiçeksepeti checks it against the last 30 days'
      // lowest price, which this side cannot know.
      if (listPrice !== null) item.listPrice = listPrice;
    }
  }
  // A variant code alone updates nothing. Sending it would report a clean run
  // for a batch that changed nothing at all.
  return Object.keys(item).length > 1 ? item : null;
};

/**
 * Ask what became of a submitted batch, and fail only on the answer that is
 * this side's fault.
 *
 * Every item failed means the variant codes do not exist for this seller — a
 * mapping pointed at the wrong column, or a catalog that was never listed.
 * Throwing holds the watermark so those rows are re-sent once it is fixed.
 *
 * A partial failure does NOT throw, for the same reason as the other
 * marketplaces: one delisted variant among two hundred would otherwise hold the
 * watermark on its row for ever.
 *
 * `Warning` is explicitly a success. Çiçeksepeti returns it for a struck-through
 * price above the last 30 days' lowest — the update lands, and the warning is
 * about pricing law rather than about the request.
 */
const verifyBatch = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  batchId: string,
): Promise<void> => {
  await sleep(BATCH_SETTLE_MS);
  const res = await ctx.fetch(`${conn.base}/Products/batch-status/${encodeURIComponent(batchId)}`, {
    headers: conn.headers,
  });
  // The batch was accepted; not being able to read its result afterwards is not
  // grounds to re-send it.
  if (!res.ok) return;

  const body = (await res.json().catch(() => ({}))) as {
    items?: { status?: unknown; failureReasons?: { message?: unknown }[] }[];
  };
  const items = body.items ?? [];
  if (items.length === 0) return;

  // Anything still queued is not an answer, and a batch that has not finished
  // is not a batch that failed.
  const settled = items.filter((i) => text(i.status) !== "Pending" && text(i.status) !== "Processing");
  if (settled.length < items.length) return;

  const failed = settled.filter((i) => text(i.status) === "Failed");
  if (failed.length < settled.length) return;

  const reason = text(failed[0]?.failureReasons?.[0]?.message);
  throw new Error(
    `Çiçeksepeti refused every item in the batch — check the variant code mapping${
      reason ? `: ${reason.slice(0, 160)}` : ""
    }`,
  );
};

// ── Listings ─────────────────────────────────────────────────────────────────

/** Çiçeksepeti's cap on one product-create request. */
const MAX_LISTING_ITEMS = 1000;

/**
 * The pace the create asks for: one request per five seconds.
 *
 * Its own bucket rather than the orders one — Çiçeksepeti meters the two
 * endpoints separately, and a publish an operator is waiting on must not queue
 * behind a page walk.
 */
const LISTING_PACE = { rps: 0.2, burst: 1 } as const;

/** Çiçeksepeti's published bounds on a description and a barcode. */
const MIN_DESCRIPTION = 30;
const MAX_DESCRIPTION = 20_000;

/** One of a closed set, or the documented default. */
const readChoice = (raw: string | null, allowed: readonly string[], fallback: string): number =>
  Number(allowed.includes(raw ?? "") ? (raw as string) : fallback);

/**
 * One `products[]` entry, or the reason this unit cannot become one.
 *
 * Returning the reason rather than throwing is the point: a refusal here is one
 * verdict on one row, where a rejected request is 200 rows an operator has to
 * re-send to fix one.
 */
function buildProduct(
  product: ListingProduct,
  variant: ListingVariant,
  opts: { deliveryType: number; deliveryMessageType: number },
): Record<string, unknown> | string {
  const p = product.fields;
  const v = variant.fields;

  const stockCode = text(v.stockCode);
  if (!stockCode) {
    return "No variant code — Çiçeksepeti addresses a listing by it, so it cannot be created without one";
  }

  const productName = text(p.productName);
  if (!productName) return "No product name";

  const description = text(p.description);
  if (!description) return "No description";
  // Çiçeksepeti measures the minimum on the PLAIN text, so markup does not
  // count towards it — a 30-character `<p>` wrapper would otherwise look like a
  // long enough description and be refused hours later.
  const plain = description.replace(/<[^>]*>/g, "").trim();
  if (plain.length < MIN_DESCRIPTION) {
    return `Description is ${plain.length} characters of text and Çiçeksepeti wants at least ${MIN_DESCRIPTION}`;
  }
  if (description.length > MAX_DESCRIPTION) {
    return `Description is ${description.length} characters and Çiçeksepeti allows ${MAX_DESCRIPTION}`;
  }

  const stockQuantity = num(v.stockQuantity);
  if (stockQuantity === null || stockQuantity < 0) return "Stock quantity is missing or not a number";

  const salesPrice = money(v.salesPrice);
  if (salesPrice === null) return "Sale price is missing or not a number";
  const listPrice = money(v.listPrice);

  const images = imageUrls(v.images ?? p.images);
  if (images.length === 0) return "No image URL — Çiçeksepeti requires at least one";

  const barcode = text(v.barcode);
  if (barcode && (barcode.length < 3 || barcode.length > 50)) {
    return `Barcode is ${barcode.length} characters and Çiçeksepeti allows 3 to 50`;
  }

  // Çiçeksepeti types both ids as integers. A binding that is not one would
  // serialise as `null` and be refused with a reason naming the batch rather
  // than the attribute, so it is caught here.
  const attributes: Record<string, unknown>[] = [];
  for (const a of variant.attributes) {
    const id = Number(a.attributeId);
    if (!Number.isInteger(id)) return `Attribute "${a.attributeId}" is not a Çiçeksepeti attribute id`;
    // Every offered attribute is a closed set here, so a free-text answer has
    // nowhere to go — saying so beats sending an id-shaped `NaN`.
    const valueId = Number(a.valueId);
    if (!Number.isInteger(valueId)) {
      return `Attribute "${a.attributeId}" needs one of Çiçeksepeti's own values, not free text`;
    }
    attributes.push({ id, valueId, textLength: 0 });
  }

  return {
    productName: productName.slice(0, 200),
    // The engine derives this from the product row's key — what makes several
    // variant codes one product page, and what makes a re-run land on the same
    // page rather than opening a second one.
    mainProductCode: product.groupId,
    stockCode,
    categoryId: Number(product.categoryId),
    description,
    ...(text(p.supplierDescription) ? { supplierDescription: text(p.supplierDescription) } : {}),
    deliveryType: opts.deliveryType,
    deliveryMessageType: opts.deliveryMessageType,
    stockQuantity: Math.floor(stockQuantity),
    salesPrice,
    // Omitted rather than sent as null when unmapped: Çiçeksepeti reads a
    // struck-through price as a legal claim about the last 30 days, so an empty
    // one is a claim not to make.
    ...(listPrice === null ? {} : { listPrice }),
    ...(barcode ? { barcode } : {}),
    images,
    attributes,
  };
}

/**
 * The image list.
 *
 * Plain URL strings, which is the shape Çiçeksepeti's own example sends —
 * unlike n11's `{url, order}` pairs and Trendyol's `{url}` objects. Three
 * marketplaces, three shapes for the same list.
 */
const imageUrls = (v: unknown): string[] => {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,;|]/) : [];
  const out: string[] = [];
  for (const entry of raw) {
    const s = typeof entry === "string" ? entry : text(obj(entry).url);
    const url = s?.trim();
    if (url && /^https?:\/\//.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
};

/** Two decimals — a price with more is refused for the whole batch. */
const money = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
};

/** A category id on its way into a URL path. Digits only, because it
 *  round-trips through our database first. */
const numericId = (raw: string, what: string): string => {
  const value = raw.trim();
  if (!/^\d{1,20}$/.test(value)) throw new Error(`Çiçeksepeti ${what} must be numeric`);
  return value;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * One status transition, as a task.
 *
 * Built by a factory rather than written out five times, because the five
 * differ in exactly two things — the id they send and whether they carry cargo
 * details. Each call produces its own settings objects, so no two tasks share
 * one: the descriptor is spread into the catalog, and a frozen instance shared
 * between tasks is an unpleasant surprise the day anything mutates it.
 */
function statusTask(id: string, label: string, statusId: number) {
  const shipping = statusId === 5;
  const delivering = statusId === 7;
  return {
    id,
    label,
    settingFields: [
      {
        key: "orderIdField",
        label: "Order ID field",
        placeholder: "the row field holding the Çiçeksepeti order id, e.g. marketplace_order_id",
      },
      ...(shipping
        ? [
            { key: "cargoCompany", label: "Carrier", options: CARGO_COMPANIES },
            {
              key: "trackingNumberField",
              label: "Tracking number field",
              placeholder: "the row field holding the carrier's tracking number",
            },
            {
              key: "trackingUrlField",
              label: "Tracking URL field",
              placeholder: "the row field holding the carrier's tracking link",
            },
          ]
        : []),
      ...(delivering
        ? [
            {
              key: "receiverNameField",
              label: "Received by field (optional)",
              placeholder: "the row field naming who took delivery",
            },
          ]
        : []),
    ],
    outputs: [
      { key: "status", label: "Order status" },
      { key: "statusId", label: "Status id" },
      { key: "updatedItems", label: "Sub-orders updated" },
      { key: "notifiedAt", label: "Notified at" },
    ],
    /**
     * The row is an order; Çiçeksepeti moves SUB-orders. So the order is read
     * back first and its sub-order ids collected, rather than asking an
     * operator to keep a list of them in a column — they live in the child
     * collection, and a task acts on one row.
     *
     * That read is a `GetOrders` call, so it takes the five-second token like
     * any other. It is the price of addressing an order the way an operator
     * thinks about one.
     */
    async run(ctx: {
      config: Record<string, unknown>;
      row: Readonly<Record<string, unknown>>;
      fetch: (u: string, i?: RequestInit) => Promise<Response>;
      str(k: string): string | null;
      setting(k: string): string | null;
    }) {
      const conn = readConnection(ctx, "task");
      const orderId = readOrderId(ctx);

      // Everything that can be decided from the step and the row is decided
      // BEFORE the lookup. That read costs a five-second token, and spending
      // one to discover the courier was never picked would make a
      // misconfigured step slow as well as broken.
      const shared: Record<string, unknown> = { orderItemStatusId: statusId };
      if (shipping) {
        const cargoBusinessId = Number(ctx.setting("cargoCompany") ?? "");
        if (!Number.isFinite(cargoBusinessId) || cargoBusinessId <= 0) {
          throw new Error("Çiçeksepeti needs the carrier this order was handed to — set it on the step");
        }
        shared.cargoBusinessId = cargoBusinessId;
        // Çiçeksepeti emails and texts the customer from this, so a shipment
        // notified without a number is a message nobody can act on.
        shared.shipmentNumber = requiredRowValue(ctx, "trackingNumberField", "tracking number");
        shared.shipmentTrackingUrl = requiredRowValue(ctx, "trackingUrlField", "tracking URL");
      }
      if (delivering) {
        const receiverName = optionalRowValue(ctx, "receiverNameField");
        if (receiverName) shared.receiverName = receiverName;
        shared.deliveryTime = new Date().toISOString();
      }

      await takeToken(`ciceksepeti:orders:${conn.sellerId}`, ORDERS_PACE);
      const found = await ctx.fetch(`${conn.base}/Order/GetOrders`, {
        method: "POST",
        headers: { ...conn.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ orderNo: Number(orderId), pageSize: PAGE, page: 0 }),
      });
      if (!found.ok) throw await readError(found, "read the order");

      const answer = (await found.json()) as { supplierOrderListWithBranch?: Record<string, unknown>[] };
      const subOrders = (answer.supplierOrderListWithBranch ?? [])
        .map((o) => num(o.orderItemId))
        .filter((n): n is number => n !== null);
      if (subOrders.length === 0) throw new Error(`Çiçeksepeti has no order ${orderId} for this seller`);

      const res = await ctx.fetch(`${conn.base}/Order/statusupdatewithsupplierintegration`, {
        method: "PUT",
        headers: { ...conn.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ orderItems: subOrders.map((orderItemId) => ({ orderItemId, ...shared })) }),
      });
      if (!res.ok) throw await readError(res, `move the order to "${label}"`);

      const outcomes = (await res.json().catch(() => [])) as
        | { isSuccess?: unknown; message?: unknown }[]
        | { orderItems?: { isSuccess?: unknown; message?: unknown }[] };
      const rows = Array.isArray(outcomes) ? outcomes : (outcomes.orderItems ?? []);
      const ok = rows.filter((r) => r.isSuccess === true || text(r.isSuccess) === "true").length;
      // Every sub-order refused is not a partial success to report as done: the
      // order has not moved, and saying it has leaves a row claiming otherwise.
      if (rows.length > 0 && ok === 0) {
        const message = text(rows[0]?.message);
        throw new Error(
          `Çiçeksepeti moved no part of order ${orderId}${message ? `: ${message.slice(0, 160)}` : ""}`,
        );
      }

      return {
        outputs: {
          status: label,
          statusId,
          updatedItems: ok || subOrders.length,
          notifiedAt: Date.now(),
        },
      };
    },
  };
}

/**
 * The order id this task acts on, read off the row.
 *
 * Digits-only, because it becomes a numeric filter and then a second request
 * built from what came back. A row carrying anything else is a mis-pointed
 * setting, and saying so beats an empty answer from a query nobody meant.
 */
const readOrderId = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("orderIdField");
  if (!field) throw new Error("Çiçeksepeti task needs the row field holding the order id");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no Çiçeksepeti order id`);
  if (!/^\d{1,18}$/.test(value)) {
    throw new Error(`"${field}" does not hold a Çiçeksepeti order id — it must be numeric`);
  }
  return value;
};

const requiredRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
  what: string,
): string => {
  const field = ctx.setting(settingKey);
  if (!field) throw new Error(`Çiçeksepeti task needs the row field holding the ${what}`);
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no ${what} to send to Çiçeksepeti`);
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
    const body = JSON.parse(raw) as { message?: string; Message?: string; errors?: unknown };
    detail = (body.message ?? body.Message ?? detail).slice(0, 160);
  } catch {
    // Not JSON — the gateway answers plain text on some failures, and the
    // truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      "Çiçeksepeti rejected the credentials — check the API key and seller id under Hesap Yönetimi → Entegrasyon Bilgilerim, and that they match the environment",
    );
  }
  return new Error(`Çiçeksepeti responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

/** The status list is exported for the docs and the tests to read one source. */
export const CICEKSEPETI_STATUSES = STATUSES;
