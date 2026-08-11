import { defineProvider, type DestinationRow } from "../provider";
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
  capabilities: ["source", "destination", "task"],
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
