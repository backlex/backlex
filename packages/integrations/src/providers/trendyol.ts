import { defineProvider, type DestinationRow } from "../provider";
import { takeToken } from "../throttle";

/**
 * Trendyol — a seller's marketplace orders in, stock and price out, and the two
 * status notifications the marketplace expects back.
 *
 * The first provider that uses three capabilities at once, and the reason the
 * engine grew `childMappings` and `task`: an order is a header plus its lines,
 * and "tell Trendyol this package is being picked" is an act on ONE row that
 * must not happen twice.
 *
 * Four things about this API are worth knowing before reading further, because
 * each one shapes a decision below.
 *
 * **The credential is a pair, and the seller id is not secret.** Basic auth over
 * `apiKey:apiSecret`, plus a `User-Agent` Trendyol matches against the seller —
 * a request without it is refused even when the credentials are right.
 *
 * **Orders are read from the cursor endpoint, not the paged one.** `/orders`
 * pages by number and caps at 10,000 records, and its `startDate` is documented
 * only as "orders from this date" — whether that is the order date or the last
 * modification is not stated, and the difference decides whether a sync ever
 * sees a status change on an older order. `/orders/stream` answers both: its
 * filter is `lastModifiedStartDate` by name, and its cursor is opaque. Trendyol
 * recommends it for exactly this job.
 *
 * **That endpoint asks for five seconds between requests** — far slower than the
 * 1,000/minute the rest of the API allows. A provider-wide limit that strict
 * would put five seconds in front of an operator clicking "mark as picking", so
 * the pace is taken per-endpoint from the same token bucket the engine uses,
 * keyed by seller. See {@link STREAM_PACE}.
 *
 * **Stock and price land in a queue, not in the response.** The push gets a
 * `batchRequestId` and nothing else; whether Trendyol accepted the barcodes is a
 * second call. This provider makes that call, and only for the one answer it can
 * act on — every item refused, which is a mapping error rather than data.
 */

/** Where the API lives, per environment. A closed set: never built from input. */
const BASES = {
  production: "https://apigw.trendyol.com",
  stage: "https://stageapigw.trendyol.com",
} as const;

/**
 * The markets a connection can address.
 *
 * Trendyol wants the target country as a header on every request. The value
 * reaches `fetch` as a header, so it is checked against this set rather than
 * forwarded — a header built from unchecked config is how a newline ends up in
 * one.
 */
const STORE_FRONTS = ["TR", "DE", "AZ", "GR", "RO", "BG", "CZ", "SK", "SA", "AE", "KW"] as const;

/** Trendyol's page cap on the order stream. */
const PAGE = 200;

/**
 * The pace the order stream asks for: one request per five seconds.
 *
 * Taken from the engine's own bucket rather than declared as the provider's
 * `limits`, because the two are genuinely different quotas. Everything else here
 * — a price push, a status notification — is allowed 1,000 requests a minute,
 * and a task is something an operator triggers and waits for. Pacing those at
 * the stream's rate would mean a five-second stall on a button.
 *
 * Keyed by seller for the same reason the engine's bucket is keyed by
 * connection: two workspaces holding two sellers' credentials have two
 * independent quotas at Trendyol.
 */
const STREAM_PACE = { rps: 0.2, burst: 1 } as const;

/**
 * The widest window the stream accepts, and the one a first run reads.
 *
 * A backfill therefore advances a window at a time: each run finishes its window
 * and hands back the window's end, and the next run starts there. That is what
 * keeps a seller with two years of history from asking for all of it at once.
 */
const MAX_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Mid-run stream cursor: `c:<windowEnd>:<opaque>`. Continues THIS run.
 *
 * The window's end travels WITH the cursor rather than being recomputed,
 * because it is what the run hands back when it finishes. A cursor that carried
 * only Trendyol's opaque token would leave the last page of a multi-page run
 * with no resume marker at all, and a backfill walking its way forward a
 * fortnight at a time would silently jump back to the most recent one and never
 * finish the middle.
 */
const CURSOR_PREFIX = "c:";
/** A finished window's end, in epoch ms. Starts the NEXT run. */
const RESUME_PREFIX = "t:";

/** Trendyol's cap on one price-and-inventory call. The engine's batch is 200,
 *  so this is never the binding constraint — it is here to say so. */
const MAX_ITEMS = 1000;

/**
 * How long to wait before asking what became of a submitted batch.
 *
 * The queue usually settles in well under a second. A batch still `PROCESSING`
 * after this is not treated as a failure — see {@link verifyBatch}.
 */
const BATCH_SETTLE_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const trendyol = defineProvider({
  id: "trendyol",
  label: "Trendyol",
  category: "marketplace",
  capabilities: ["source", "destination", "task"],
  /**
   * 1,000 requests a minute is what the order API publishes. Paced under it
   * rather than at it: the bucket is per-isolate and best-effort, so two
   * isolates running two syncs for one seller each believe they have the whole
   * allowance. The 429 path is the real guarantee either way.
   */
  limits: { rps: 10, burst: 20 },
  configFields: [
    {
      key: "sellerId",
      label: "Seller ID",
      placeholder: "the supplier id from Account → Integration Details",
    },
    { key: "apiKey", label: "API key", secret: true },
    { key: "apiSecret", label: "API secret", secret: true },
    {
      key: "storeFrontCode",
      label: "Market",
      options: [
        { value: "TR", label: "Türkiye" },
        { value: "DE", label: "Germany" },
        { value: "AZ", label: "Azerbaijan" },
        { value: "GR", label: "Greece" },
        { value: "RO", label: "Romania" },
        { value: "BG", label: "Bulgaria" },
        { value: "CZ", label: "Czechia" },
        { value: "SK", label: "Slovakia" },
        { value: "SA", label: "Saudi Arabia" },
        { value: "AE", label: "United Arab Emirates" },
        { value: "KW", label: "Kuwait" },
      ],
    },
    {
      key: "environment",
      label: "Environment",
      options: [
        { value: "production", label: "Production" },
        { value: "stage", label: "Stage (test seller)" },
      ],
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
          { value: "14", label: "Last 14 days (max)" },
        ],
      },
    ],
    /**
     * One page of packages modified inside the current window.
     *
     * There is deliberately no status filter. A sync mirrors what the
     * marketplace holds, and filtering on status here would freeze a row at the
     * status it had when it was first seen — an order pulled as `Created` and
     * later shipped would simply stop being returned, and the collection would
     * disagree with Trendyol forever. Narrowing belongs to a view over the
     * collection, where it costs nothing to change your mind.
     */
    async pull(ctx) {
      const { sellerId, headers, base } = readConnection(ctx, "sync");
      const cursor = ctx.cursor ?? "";

      const url = new URL(`${base}/integration/order/sellers/${sellerId}/orders/stream`);
      url.searchParams.set("size", String(Math.min(ctx.limit, PAGE)));

      // A cursor already encodes the window it was opened with, and Trendyol
      // refuses a stream whose filters change mid-walk — so the dates are sent
      // on the first request of a window and never again.
      let windowEnd: number | null = null;
      if (cursor.startsWith(CURSOR_PREFIX)) {
        const rest = cursor.slice(CURSOR_PREFIX.length);
        const split = rest.indexOf(":");
        windowEnd = split < 0 ? null : readEpoch(rest.slice(0, split));
        // Trendyol's token is opaque and may hold anything, so only the FIRST
        // separator is structure — the remainder is echoed back untouched.
        url.searchParams.set("cursor", split < 0 ? rest : rest.slice(split + 1));
      } else {
        const now = Date.now();
        const lookback = readLookbackDays(ctx.setting("lookbackDays"));
        const resumeFrom = cursor.startsWith(RESUME_PREFIX)
          ? readEpoch(cursor.slice(RESUME_PREFIX.length))
          : null;
        const start = resumeFrom ?? now - lookback * DAY_MS;
        // Clamped both ways: never wider than the API allows, and never past
        // now — an end in the future would be a window that can never complete.
        windowEnd = Math.min(start + MAX_WINDOW_DAYS * DAY_MS, now);
        url.searchParams.set("lastModifiedStartDate", String(start));
        url.searchParams.set("lastModifiedEndDate", String(windowEnd));
      }

      await takeToken(`trendyol:orders-stream:${sellerId}`, STREAM_PACE);
      const res = await ctx.fetch(url.toString(), { headers });
      if (!res.ok) throw await readError(res, "read the orders");
      const body = (await res.json()) as {
        content?: Record<string, unknown>[];
        hasMore?: unknown;
        nextCursor?: unknown;
      };

      const records = (body.content ?? [])
        .map((pkg) => {
          const id = idOf(pkg.shipmentPackageId);
          return id ? { externalId: id, data: packageData(pkg), children: { lines: linesOf(pkg.lines) } } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const next = typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
      if (body.hasMore === true && next) {
        return { records, cursor: `${CURSOR_PREFIX}${windowEnd ?? ""}:${next}` };
      }

      // The window is finished. Its END becomes the next run's start — the same
      // instant on both sides rather than one millisecond later, because a
      // package modified exactly on the boundary being read twice is free
      // (rows are upserted) and being skipped is not.
      return {
        records,
        cursor: null,
        ...(windowEnd === null ? {} : { resumeToken: `${RESUME_PREFIX}${windowEnd}` }),
      };
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
     * Trendyol takes stock and price independently, and most sellers want only
     * one of them mirrored — the other is managed in their panel and would be
     * overwritten on every run. Declaring the dependency here is what keeps a
     * price column from being offered on a stock-only sync and then silently
     * dropped.
     */
    columns: [
      { value: "barcode", label: "Barcode" },
      { value: "quantity", label: "Stock quantity", when: { updates: ["stock", "both"] } },
      { value: "salePrice", label: "Sale price", when: { updates: ["price", "both"] } },
      { value: "listPrice", label: "List price", when: { updates: ["price", "both"] } },
    ],
    async push(ctx) {
      const { sellerId, headers, base } = readConnection(ctx, "write-back");
      const mode = ctx.setting("updates") ?? "both";

      const items: Record<string, unknown>[] = [];
      for (const row of ctx.rows) {
        const item = itemFor(row, mode);
        // A row with no barcode addresses no listing. Skipped rather than sent:
        // Trendyol would refuse the whole batch for it.
        if (item) items.push(item);
      }
      if (items.length === 0) {
        // Every row refused is not data, it is a mis-mapped column: reporting a
        // clean run would advance the watermark over rows nothing received.
        throw new Error(
          "No row in the batch had a barcode and something to update — check the column mapping",
        );
      }

      const res = await ctx.fetch(
        `${base}/integration/inventory/sellers/${sellerId}/products/price-and-inventory`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ items: items.slice(0, MAX_ITEMS) }),
        },
      );
      if (!res.ok) throw await readError(res, "update stock and price");

      const body = (await res.json().catch(() => ({}))) as { batchRequestId?: unknown };
      if (typeof body.batchRequestId === "string" && body.batchRequestId) {
        await verifyBatch(ctx, base, sellerId, headers, body.batchRequestId);
      }
    },
  },
  /**
   * The two notifications a seller owes the marketplace, as two tasks rather
   * than one with a status setting.
   *
   * That split is forced by the once-only guard, and it is the right shape
   * anyway: the guard is keyed by (integration, task, row), so a single
   * `set_status` task would mark a package `Picking` and then refuse to mark it
   * `Invoiced`, reporting the first run's answer instead. Two tasks means each
   * notification happens exactly once, which is what "exactly once" has to mean
   * for a package that legitimately moves twice.
   *
   * Neither sends `lines`: omitting them notifies the whole package, which is
   * what a seller shipping a package in one piece means. Partial fulfilment
   * splits the package at Trendyol and the split arrives as its own row.
   */
  tasks: [
    {
      id: "mark_picking",
      label: "Mark as picking",
      settingFields: [packageIdSetting()],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "notifiedAt", label: "Notified at" },
      ],
      async run(ctx) {
        const { sellerId, headers, base } = readConnection(ctx, "task");
        const packageId = readPackageId(ctx);
        await putStatus(ctx, base, sellerId, headers, packageId, { status: "Picking" });
        return { outputs: { status: "Picking", notifiedAt: Date.now() } };
      },
    },
    {
      id: "mark_invoiced",
      label: "Mark as invoiced",
      settingFields: [
        packageIdSetting(),
        {
          key: "invoiceNumberField",
          label: "Invoice number field",
          placeholder: "the row field holding the invoice number, e.g. invoice_number",
        },
      ],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "invoiceNumber", label: "Invoice number sent" },
        { key: "notifiedAt", label: "Notified at" },
      ],
      /**
       * Trendyol expects `Picking` before `Invoiced`. The order is not enforced
       * here: a package already picked through the seller panel would then be
       * un-invoiceable through the API, and the marketplace's own 400 says what
       * is wrong far more accurately than a guess from this side could.
       */
      async run(ctx) {
        const { sellerId, headers, base } = readConnection(ctx, "task");
        const packageId = readPackageId(ctx);

        const field = ctx.setting("invoiceNumberField");
        if (!field) throw new Error('Trendyol "mark as invoiced" needs an invoice number field');
        const invoiceNumber = text(ctx.row[field]);
        if (!invoiceNumber) {
          throw new Error(`Row field "${field}" holds no invoice number to send to Trendyol`);
        }

        await putStatus(ctx, base, sellerId, headers, packageId, {
          status: "Invoiced",
          params: { invoiceNumber },
        });
        return { outputs: { status: "Invoiced", invoiceNumber, notifiedAt: Date.now() } };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

/**
 * Which row field carries the Trendyol package id.
 *
 * A function rather than a shared constant so the two tasks cannot end up
 * holding the same object — the descriptor is spread into the catalog, and one
 * frozen instance shared between tasks would be an unpleasant surprise the day
 * anything mutates it.
 *
 * Free text, unlike every other choice in this file, because the value set is
 * the COLLECTION's fields — which the provider cannot know. The engine's own
 * check is the one that matters: a mapping onto a field the collection does not
 * have is refused when the task is invoked.
 */
function packageIdSetting() {
  return {
    key: "packageIdField",
    label: "Package ID field",
    placeholder: "the row field holding the Trendyol package id, e.g. shipment_package_id",
  };
}

interface Connection {
  sellerId: string;
  headers: Record<string, string>;
  base: string;
}

/**
 * Read the credentials and turn them into the headers every call needs.
 *
 * `sellerId` goes into a URL path, so it is checked to be digits before it is
 * interpolated. `storeFrontCode` goes into a header and is checked against the
 * published set for the same reason — neither is a value a caller should be
 * able to shape.
 */
const readConnection = (
  ctx: { str(k: string): string | null },
  what: string,
): Connection => {
  const sellerId = ctx.str("sellerId");
  if (!sellerId) throw new Error(`Trendyol ${what} has no seller id`);
  if (!/^\d{1,15}$/.test(sellerId)) throw new Error("Trendyol seller id must be numeric");

  const apiKey = ctx.str("apiKey");
  const apiSecret = ctx.str("apiSecret");
  if (!apiKey || !apiSecret) throw new Error(`Trendyol ${what} has no API key and secret`);
  // `btoa` throws on anything outside Latin-1, and its own message names a DOM
  // API rather than the pasted credential that caused it. A key with a stray
  // non-ASCII character is a paste that went wrong, and saying so is the whole
  // difference between fixing it and filing a bug.
  if (/[^\x20-\x7E]/.test(`${apiKey}${apiSecret}`)) {
    throw new Error("Trendyol API key and secret must be plain ASCII — check for a bad paste");
  }

  const storeFront = ctx.str("storeFrontCode") ?? "TR";
  if (!(STORE_FRONTS as readonly string[]).includes(storeFront)) {
    throw new Error(`Trendyol has no market "${storeFront}"`);
  }

  const environment = ctx.str("environment");
  const base = environment === "stage" ? BASES.stage : BASES.production;

  return {
    sellerId,
    base,
    headers: {
      Authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}`,
      // Trendyol matches this against the seller and refuses the request
      // without it, credentials notwithstanding. "SelfIntegration" is the
      // documented form for an integration a seller runs themselves — which is
      // what a backlex workspace is.
      "User-Agent": `${sellerId} - SelfIntegration`,
      storeFrontCode: storeFront,
      Accept: "application/json",
    },
  };
};

// ── Orders ───────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_WINDOW_DAYS ? Math.floor(n) : MAX_WINDOW_DAYS;
};

/** A resume marker, or `null` if it is not a plausible epoch. */
const readEpoch = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Trendyol ids arrive as JSON numbers; a string id is a primary key. */
const idOf = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * One package, flattened for mapping.
 *
 * Addresses are spread into their parts rather than handed over as objects: a
 * mapping targets one column, and an operator wanting the city in a `city`
 * column cannot get there from a nested blob. The names keep Trendyol's own
 * where there is one, so what the picker offers matches what their panel and
 * their docs call it.
 *
 * `district` and `neighbourhood` are carried alongside `city` and `countryCode`
 * because a Turkish address is il / ilçe / mahalle and a courier needs all
 * three — the same address that is state/city elsewhere. Dropping them here
 * would mean the carrier integration has to go and re-fetch the order.
 */
const packageData = (p: Record<string, unknown>): Record<string, unknown> => {
  const ship = obj(p.shipmentAddress);
  const invoice = obj(p.invoiceAddress);
  return {
    shipmentPackageId: p.shipmentPackageId ?? null,
    orderNumber: p.orderNumber ?? null,
    orderDate: p.orderDate ?? null,
    createdDate: p.createdDate ?? null,
    lastModifiedDate: p.lastModifiedDate ?? null,
    status: p.status ?? p.shipmentPackageStatus ?? null,
    deliveryType: p.deliveryType ?? null,
    fastDelivery: p.fastDelivery ?? null,
    commercial: p.commercial ?? null,
    micro: p.micro ?? null,

    customerId: p.customerId ?? null,
    customerFirstName: p.customerFirstName ?? null,
    customerLastName: p.customerLastName ?? null,
    customerEmail: p.customerEmail ?? null,

    grossAmount: p.packageGrossAmount ?? null,
    totalDiscount: p.packageTotalDiscount ?? null,
    sellerDiscount: p.packageSellerDiscount ?? null,
    totalPrice: p.packageTotalPrice ?? null,
    currencyCode: p.currencyCode ?? null,

    cargoProviderName: p.cargoProviderName ?? null,
    cargoTrackingNumber: p.cargoTrackingNumber ?? null,
    cargoTrackingLink: p.cargoTrackingLink ?? null,
    cargoSenderNumber: p.cargoSenderNumber ?? null,
    estimatedDeliveryStartDate: p.estimatedDeliveryStartDate ?? null,
    estimatedDeliveryEndDate: p.estimatedDeliveryEndDate ?? null,
    agreedDeliveryDate: p.agreedDeliveryDate ?? null,
    invoiceLink: p.invoiceLink ?? null,

    shipmentFullName: fullName(ship),
    shipmentAddress1: ship.address1 ?? null,
    shipmentAddress2: ship.address2 ?? null,
    shipmentFullAddress: ship.fullAddress ?? null,
    shipmentNeighbourhood: ship.neighborhood ?? null,
    shipmentDistrict: ship.district ?? null,
    shipmentCity: ship.city ?? null,
    shipmentPostalCode: ship.postalCode ?? null,
    shipmentCountryCode: ship.countryCode ?? null,
    shipmentPhone: ship.phone ?? null,

    invoiceFullName: fullName(invoice),
    invoiceFullAddress: invoice.fullAddress ?? null,
    invoiceCity: invoice.city ?? null,
    invoiceCountryCode: invoice.countryCode ?? null,
    invoiceTaxNumber: invoice.taxNumber ?? null,
    invoiceTaxOffice: invoice.taxOffice ?? null,
  };
};

const fullName = (a: Record<string, unknown>): string | null => {
  const parts = [text(a.firstName), text(a.lastName)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : text(a.fullName);
};

/**
 * The package's lines, as child records.
 *
 * `lineId` is only unique within its package — Trendyol numbers lines per
 * order — which is exactly the case the engine qualifies a child key for.
 *
 * The amount fields are read under their v2 names with the v1 ones as a
 * fallback. The stream endpoint documents its envelope but not its line schema,
 * and the difference between the two generations is a null price rather than an
 * error: a fallback costs a few characters, and finding out the other way costs
 * an order import whose totals are all empty.
 */
const linesOf = (raw: unknown): { externalId: string; data: Record<string, unknown> }[] => {
  if (!Array.isArray(raw)) return [];
  const out: { externalId: string; data: Record<string, unknown> }[] = [];
  for (const line of raw) {
    const l = obj(line);
    const id = idOf(l.lineId);
    if (!id) continue;
    out.push({
      externalId: id,
      data: {
        lineId: l.lineId ?? null,
        barcode: l.barcode ?? null,
        stockCode: l.stockCode ?? l.merchantSku ?? null,
        productName: l.productName ?? null,
        productSize: l.productSize ?? null,
        productColor: l.productColor ?? null,
        productCategoryId: l.productCategoryId ?? null,
        contentId: l.contentId ?? null,
        quantity: l.quantity ?? null,
        unitPrice: l.lineUnitPrice ?? l.price ?? null,
        grossAmount: l.lineGrossAmount ?? l.amount ?? null,
        totalDiscount: l.lineTotalDiscount ?? l.discount ?? null,
        sellerDiscount: l.lineSellerDiscount ?? null,
        vatRate: l.vatRate ?? null,
        currencyCode: l.currencyCode ?? null,
        status: l.orderLineItemStatusName ?? null,
        cancelReason: l.cancelReason ?? null,
      },
    });
  }
  return out;
};

// ── Stock and price ──────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * One mapped row as a price-and-inventory item, or `null` when it addresses
 * nothing.
 *
 * Only the fields this sync is FOR are sent. Trendyol treats an omitted field as
 * "leave it alone", so a stock-only sync that also sent a price would overwrite
 * whatever the seller set in their panel — which is the exact surprise the
 * `updates` setting exists to prevent.
 */
const itemFor = (row: DestinationRow, mode: string): Record<string, unknown> | null => {
  const barcode = text(row.barcode);
  if (!barcode) return null;
  const item: Record<string, unknown> = { barcode };

  if (mode !== "price") {
    const quantity = num(row.quantity);
    // Trendyol takes whole units, and a negative stock is a mapping error
    // rather than an oversell to publish.
    if (quantity !== null) item.quantity = Math.max(0, Math.floor(quantity));
  }
  if (mode !== "stock") {
    const salePrice = num(row.salePrice);
    const listPrice = num(row.listPrice);
    if (salePrice !== null) item.salePrice = salePrice;
    // Trendyol refuses a list price below the sale price. Defaulting it to the
    // sale price is the reading that matches an unmapped column: no crossed-out
    // price, rather than a batch rejected for a field nobody filled in.
    if (salePrice !== null || listPrice !== null) {
      item.listPrice = Math.max(listPrice ?? 0, salePrice ?? 0);
    }
  }
  // Barcode alone updates nothing. Sending it would report a clean run for a
  // batch that changed nothing at all.
  return Object.keys(item).length > 1 ? item : null;
};

/**
 * Ask what became of a submitted batch, and fail only on the one answer that is
 * this side's fault.
 *
 * Every item refused means the barcodes do not exist for this seller — a
 * mapping pointed at the wrong column, or a catalog that was never listed.
 * Throwing holds the watermark so those rows are re-sent once it is fixed.
 *
 * A partial failure does NOT throw, and that asymmetry is deliberate: one
 * archived listing among two hundred would otherwise hold the watermark on its
 * row forever and the sync would never reach the rows behind it. Same rule as
 * the marketing providers, for the same reason.
 *
 * A batch still processing is not an answer, and is left alone.
 */
const verifyBatch = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  base: string,
  sellerId: string,
  headers: Record<string, string>,
  batchRequestId: string,
): Promise<void> => {
  await sleep(BATCH_SETTLE_MS);
  const res = await ctx.fetch(
    `${base}/integration/product/sellers/${sellerId}/products/batch-requests/${encodeURIComponent(batchRequestId)}`,
    { headers },
  );
  // The batch was accepted; not being able to read its result afterwards is not
  // grounds to re-send it.
  if (!res.ok) return;

  const body = (await res.json().catch(() => ({}))) as {
    status?: unknown;
    itemCount?: unknown;
    failedItemCount?: unknown;
    items?: { status?: unknown; failureReasons?: unknown }[];
  };
  if (body.status !== "COMPLETED") return;

  const total = num(body.itemCount) ?? 0;
  const failed = num(body.failedItemCount) ?? 0;
  if (total === 0 || failed < total) return;

  const reason = body.items?.find((i) => Array.isArray(i.failureReasons) && i.failureReasons.length > 0)
    ?.failureReasons as string[] | undefined;
  throw new Error(
    `Trendyol refused every item in the batch — check the barcode mapping${reason?.[0] ? `: ${String(reason[0]).slice(0, 160)}` : ""}`,
  );
};

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * The package id this task acts on, read off the row.
 *
 * Digits-only, because it is interpolated into a URL path. A row that carries
 * something else there is a mis-pointed setting, and saying so beats a 404 from
 * a URL nobody meant to build.
 */
const readPackageId = (ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null }): string => {
  const field = ctx.setting("packageIdField");
  if (!field) throw new Error("Trendyol task needs the row field holding the package id");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no Trendyol package id`);
  if (!/^\d{1,20}$/.test(value)) {
    throw new Error(`"${field}" does not hold a Trendyol package id — it must be numeric`);
  }
  return value;
};

const putStatus = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  base: string,
  sellerId: string,
  headers: Record<string, string>,
  packageId: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const res = await ctx.fetch(
    `${base}/integration/order/sellers/${sellerId}/shipment-packages/${packageId}`,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await readError(res, `notify status "${String(body.status)}"`);
};

// ── Shared ───────────────────────────────────────────────────────────────────

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
    const body = JSON.parse(raw) as { errors?: { message?: string }[]; message?: string };
    detail = (body.errors?.[0]?.message ?? body.message ?? detail).slice(0, 160);
  } catch {
    // Not JSON — Trendyol answers HTML from its gateway on some failures, and
    // the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      "Trendyol rejected the credentials — check the API key, secret and seller id on the Integration Details page",
    );
  }
  if (res.status === 404) {
    return new Error(`Trendyol has no such resource and could not ${what} — check the seller id`);
  }
  return new Error(`Trendyol responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};
