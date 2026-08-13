import {
  defineProvider,
  type DestinationRow,
  type ListingAttribute,
  type ListingCategory,
  type ListingProduct,
  type ListingVariant,
  type ListingVerdict,
} from "../provider";

/**
 * n11 — a seller's shipment packages in, stock and price out, and the one
 * status the marketplace currently accepts back.
 *
 * The third marketplace, and the one that settles the question: yes, a
 * marketplace is one file. Nothing here needed an engine change, and the shape
 * is Trendyol's almost line for line — a package is the record, its lines are
 * children, the date window is a modification window, and the price push lands
 * in a queue that has to be asked about afterwards.
 *
 * Four facts shape the code, and the first is the important one.
 *
 * **The date filter can be made a MODIFICATION filter, and must be.** By
 * default `startDate`/`endDate` bound the order's creation, which would freeze
 * every package at the status it was created with — the trap Hepsiburada has no
 * way out of. n11 does: `orderByField=true` re-points the same two parameters
 * at `lastModifiedDate`. It is therefore sent on every request, not offered as
 * a setting, because a sync that mirrors is the only thing this source is for.
 *
 * **The credential is a header pair, not an Authorization scheme.** `appkey`
 * and `appsecret`, with authorization explicitly set to none. There is nothing
 * to base64 and no bearer token.
 *
 * **Only `Picking` can be sent back today.** n11 documents `UpdateOrder` as
 * supporting exactly one transition for now and says the rest will follow. So
 * there is one task rather than a status setting that would accept values the
 * API refuses — and when the others arrive they arrive as more tasks, for the
 * same reason Trendyol's two are two.
 *
 * **A package can have no package number.** Location-specific delivery orders
 * come back with `id: null`, because their shipping is managed in the seller
 * panel rather than through this API. They are not dropped — see
 * {@link recordIdFor}.
 */

/** Where the API lives. A constant: never built from config. */
const BASE = "https://api.n11.com";

/** n11's cap on one page of packages, and on one price-and-stock request. */
const PAGE = 100;
const MAX_SKUS = 1000;

/**
 * Who n11 is told is calling.
 *
 * n11 asks for the integrator's name on every write and asks that the SAME
 * value be sent every time — it is how they attribute traffic — so it is one
 * constant rather than a string at each call site.
 */
const INTEGRATOR = "backlex";

/**
 * The widest window the packages feed honours, and the one a first run reads.
 *
 * n11 states it three ways — a start alone reads 15 days forward, an end alone
 * reads 15 days back, and a range wider than that is silently narrowed to the
 * last 15 days before the end. That last one is why the window is clamped here
 * rather than left to the API: a backfill asking for two years would be
 * answered with a fortnight and would never learn it had been ignored.
 */
const MAX_WINDOW_DAYS = 15;
const DAY_MS = 86_400_000;

/**
 * Mid-run cursor: `c:<windowStart>:<windowEnd>:<page>`. Continues THIS run.
 *
 * All three travel together because all three are needed and none can be
 * recomputed. The end is what the run hands back when it finishes — a cursor
 * carrying only a page would leave a multi-page run with no resume marker at
 * all. The start is what page two must send unchanged: n11 pages a result set
 * that its own date filter defines, and the first request's start came from the
 * operator's `lookbackDays`, which nothing downstream can rediscover.
 */
const CURSOR_PREFIX = "c:";
/** A finished window's end, in epoch ms. Starts the NEXT run. */
const RESUME_PREFIX = "t:";

/** How long to wait before asking what became of a submitted task. */
const TASK_SETTLE_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Who n11 says despatches the parcel. A closed set: it reaches a query. */
const SENDERS = ["SELLER", "N11", "ALL"] as const;

export const n11 = defineProvider({
  id: "n11",
  label: "n11",
  category: "marketplace",
  capabilities: ["source", "destination", "task", "listing"],
  /**
   * A thousand requests a minute is what the packages feed publishes. Paced
   * under it: the bucket is per-isolate and best-effort, so two isolates
   * running two syncs for one seller each believe they have the whole
   * allowance. The 429 path is the real guarantee either way.
   */
  limits: { rps: 10, burst: 20 },
  configFields: [
    { key: "appKey", label: "App key", secret: true },
    { key: "appSecret", label: "App secret", secret: true },
  ],
  source: {
    childGroups: [{ key: "lines", label: "Order lines" }],
    settingFields: [
      {
        key: "sender",
        label: "Whose parcels",
        options: [
          { value: "SELLER", label: "Sent by the seller" },
          { value: "N11", label: "Sent from an n11 warehouse" },
          { value: "ALL", label: "Both" },
        ],
      },
      {
        key: "lookbackDays",
        label: "First run reads",
        options: [
          { value: "1", label: "Last 24 hours" },
          { value: "7", label: "Last 7 days" },
          { value: "15", label: "Last 15 days (max)" },
        ],
      },
    ],
    /**
     * One page of packages modified inside the current window.
     *
     * There is deliberately no status filter, and n11 makes that decision
     * cheap: `status` takes ONE value per request, so mirroring every status
     * through a filter would mean seven walks instead of one. Omitting it reads
     * them all. Narrowing belongs to a view over the collection, where it costs
     * nothing to change your mind.
     */
    async pull(ctx) {
      const headers = readConnection(ctx, "sync");
      const cursor = ctx.cursor ?? "";

      // BOTH ends of the window travel with the page, not just the end. n11
      // pages a result set that its own date filter defines, so widening the
      // range on page two would page a different set — and the first run's
      // range is the operator's `lookbackDays`, which page two has no other way
      // of knowing.
      const open = readCursor(cursor);
      if (open) return await walk(ctx, headers, open.start, open.end, open.page);

      const now = Date.now();
      const resumeFrom = cursor.startsWith(RESUME_PREFIX) ? readEpoch(cursor.slice(RESUME_PREFIX.length)) : null;
      const start = resumeFrom ?? now - readLookbackDays(ctx.setting("lookbackDays")) * DAY_MS;
      // Clamped both ways: never wider than n11 will actually honour, and never
      // past now — an end in the future is a window that can never be finished,
      // and a resume token that skips whatever lands after it.
      const end = Math.min(start + MAX_WINDOW_DAYS * DAY_MS, now);
      return await walk(ctx, headers, start, end, 0);
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
     * Same argument as the other two marketplaces: most sellers mirror one of
     * the two and manage the other in the panel, and a column that is silently
     * dropped is worse than one that was never offered.
     *
     * `listPrice` and `salePrice` are both offered on a price sync because n11
     * refuses one without the other — see {@link itemFor}, which fills the gap
     * rather than letting the request be rejected for a column nobody mapped.
     */
    columns: [
      { value: "stockCode", label: "Seller stock code" },
      { value: "quantity", label: "Stock quantity", when: { updates: ["stock", "both"] } },
      { value: "salePrice", label: "Sale price", when: { updates: ["price", "both"] } },
      { value: "listPrice", label: "List price", when: { updates: ["price", "both"] } },
      { value: "currencyType", label: "Currency", when: { updates: ["price", "both"] } },
    ],
    async push(ctx) {
      const headers = readConnection(ctx, "write-back");
      const mode = ctx.setting("updates") ?? "both";

      const skus: Record<string, unknown>[] = [];
      for (const row of ctx.rows) {
        const item = itemFor(row, mode);
        // A row with no stock code addresses no listing. Skipped rather than
        // sent: n11 keys every update on it.
        if (item) skus.push(item);
      }
      if (skus.length === 0) {
        throw new Error(
          "No row in the batch had a stock code and something to update — check the column mapping",
        );
      }

      const res = await ctx.fetch(`${BASE}/ms/product/tasks/price-stock-update`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { integrator: INTEGRATOR, skus: skus.slice(0, MAX_SKUS) } }),
      });
      if (!res.ok) throw await readError(res, "update stock and price");

      const body = (await res.json().catch(() => ({}))) as { id?: unknown; status?: unknown; reasons?: unknown };
      // REJECT is n11 refusing the whole data set up front, and it comes with
      // its own reason. That is not a queue to poll, it is an answer.
      if (body.status === "REJECT") {
        const reason = Array.isArray(body.reasons) ? text(body.reasons[0]) : null;
        throw new Error(`n11 refused the price and stock update${reason ? `: ${reason.slice(0, 160)}` : ""}`);
      }
      const taskId = text(body.id);
      if (taskId) await verifyTask(ctx, headers, taskId);
    },
  },
  /**
   * Putting a product ON SALE — a different job from keeping one priced.
   *
   * The destination above addresses a listing that already exists, by stock
   * code. This one creates it, which is why it needs a category and that
   * category's own attributes.
   *
   * **There is no brand field, and that is the fact worth keeping.** n11 sends
   * the brand as attribute id 1 ("Marka"), like any other category attribute —
   * so this provider declares NO `lookups` and needs no brand picker. The
   * existing attribute mapper already covers it, because `isCustomValue` is
   * true on that attribute: an operator may pick one of n11's own brand values
   * or type a name.
   *
   * The second fact worth keeping is what a verdict echoes. n11 answers with
   * **`itemCode`**, and its documentation says outright that `itemCode` holds
   * the STOCK CODE — not the barcode, which is optional here and routinely
   * null. That is what makes `stockCode` the reference column.
   */
  listing: {
    settingFields: [
      {
        key: "shipmentTemplate",
        // Required by n11 per product, and it is a NAME rather than an id — the
        // one the seller created under Hesabım > Teslimat Bilgilerim.
        label: "Shipment template name",
        placeholder: "the template name from Hesabım > Teslimat Bilgilerim",
      },
      {
        key: "preparingDay",
        label: "Handling time (days)",
        options: [
          { value: "1", label: "1 day" },
          { value: "2", label: "2 days" },
          { value: "3", label: "3 days" },
          { value: "5", label: "5 days" },
          { value: "7", label: "7 days" },
        ],
      },
      {
        key: "vatRate",
        label: "VAT rate",
        // n11 publishes the closed set; anything else is refused for the task.
        options: [
          { value: "0", label: "0%" },
          { value: "1", label: "1%" },
          { value: "10", label: "10%" },
          { value: "20", label: "20%" },
        ],
      },
      {
        key: "currencyType",
        label: "Currency",
        options: [
          { value: "TL", label: "Turkish lira" },
          { value: "USD", label: "US dollar (tracked to the central bank rate)" },
          { value: "EUR", label: "Euro (tracked to the central bank rate)" },
        ],
      },
      {
        key: "maxPurchaseQuantity",
        label: "Maximum per buyer (optional)",
        placeholder: "5",
      },
    ],
    /** Product-level fields, repeated onto every one of its units — n11's items
     *  are flat, the same shape Trendyol's v2 create has. */
    columns: [
      { value: "title", label: "Title" },
      { value: "description", label: "Description (HTML)" },
      { value: "images", label: "Image URLs (https only)" },
    ],
    /**
     * Per-unit fields.
     *
     * `barcode` is offered but never required: n11 documents it as optional and
     * uses it only to match its own catalog, and its own variant example sends
     * `null`. Requiring it would refuse perfectly listable products.
     */
    variantColumns: [
      { value: "stockCode", label: "Stock code" },
      { value: "barcode", label: "Barcode (optional, matches n11's catalog)" },
      { value: "quantity", label: "Stock quantity" },
      { value: "salePrice", label: "Sale price" },
      { value: "listPrice", label: "List price" },
    ],
    referenceColumn: "stockCode",
    outputs: [
      { key: "listingId", label: "n11 stock code (listing id)" },
      { key: "listingStatus", label: "Listing status" },
      { key: "listingError", label: "Rejection reason" },
      { key: "listedAt", label: "Listed at" },
    ],

    /**
     * The whole tree in one request, flattened.
     *
     * Unlike Trendyol's, this one needs the credential — probed live, it
     * answers 403 "Authentication parameters missing" without the header pair —
     * so the picker only works once the keys are pasted.
     */
    async categories(ctx) {
      const headers = readConnection(ctx, "listing");
      const res = await ctx.fetch(`${BASE}/cdn/categories`, { headers });
      if (!res.ok) throw await readError(res, "read the categories");
      const body = (await res.json()) as unknown;
      // n11 has answered both as a bare array and under `categories`; both are
      // accepted rather than one being guessed at.
      const roots = Array.isArray(body) ? body : asArray(obj(body).categories);

      const out: ListingCategory[] = [];
      // Iterative, not recursive: the tree's depth is nobody's promise, and a
      // cycle in someone else's data should not be able to blow our stack.
      const stack: { node: unknown; parentId: string | null }[] = [];
      for (const node of roots) stack.push({ node, parentId: null });
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
          // n11 says "leaf" by returning `null` where Trendyol returns `[]`.
          // Deriving it here is what keeps that difference out of every reader.
          leaf: kids.length === 0,
          parentId,
        });
        for (const kid of kids) stack.push({ node: kid, parentId: id });
      }
      return out;
    },

    /** What one leaf category demands, including its brand list. */
    async attributes(ctx) {
      const headers = readConnection(ctx, "listing");
      const categoryId = numericId(ctx.categoryId, "category id");
      const res = await ctx.fetch(`${BASE}/cdn/category/${categoryId}/attribute`, { headers });
      if (!res.ok) throw await readError(res, "read the category attributes");
      const body = (await res.json()) as { categoryAttributes?: unknown };

      const out: ListingAttribute[] = [];
      for (const raw of asArray(body.categoryAttributes)) {
        const row = obj(raw);
        const id = text(row.attributeId);
        if (!id) continue;
        out.push({
          id,
          name: text(row.attributeName) ?? id,
          required: row.isMandatory === true,
          allowCustom: row.isCustomValue === true,
          // `isVariant` is what splits a product into variants; `isSlicer`
          // groups the variants onto one page and n11 documents BOTH as
          // wanting a shared productMainId, so either one means "this tells two
          // units apart".
          variant: row.isVariant === true || row.isSlicer === true,
          // n11 publishes no multi-value flag — one value per attribute.
          multiple: false,
          values: asArray(row.attributeValues)
            .map((v) => {
              const val = obj(v);
              const vid = text(val.id);
              // n11 spells the label `value` where Trendyol spells it `name`.
              return vid ? { id: vid, name: text(val.value) ?? vid } : null;
            })
            .filter((v): v is { id: string; name: string } => v !== null),
        });
      }
      return out;
    },

    async publish(ctx) {
      const headers = readConnection(ctx, "listing");
      const opts = readListingSettings(ctx);

      const skus: Record<string, unknown>[] = [];
      const settled: ListingVerdict[] = [];
      for (const product of ctx.products) {
        for (const variant of product.variants) {
          const built = buildSku(product, variant, opts);
          if (typeof built === "string") {
            // Refused HERE rather than by n11, which REJECTs the whole task and
            // explains itself in one `reasons` list for the batch. A verdict per
            // unit is what an operator can act on.
            settled.push({ reference: variant.reference, status: "rejected", errors: [built] });
            continue;
          }
          skus.push(built);
        }
      }

      if (skus.length === 0) {
        // Nothing queued, so nothing to poll. A batch id here would leave the
        // engine asking n11 about work it never accepted.
        return { batchId: "", settled };
      }
      if (skus.length > MAX_SKUS) {
        throw new Error(`n11 accepts ${MAX_SKUS} SKUs per request, and this batch has ${skus.length}`);
      }

      const res = await ctx.fetch(`${BASE}/ms/product/tasks/product-create`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { integrator: INTEGRATOR, skus } }),
      });
      if (!res.ok) throw await readError(res, "create the products");

      const body = (await res.json().catch(() => ({}))) as {
        id?: unknown;
        status?: unknown;
        reasons?: unknown;
      };
      const reasons = asArray(body.reasons)
        .map((r) => text(r))
        .filter((r): r is string => r !== null);

      // REJECT is n11 refusing the whole data set before queueing anything —
      // an answer, not a ticket. Every unit sent gets that answer, so the batch
      // closes here rather than being polled for a task that will never run.
      if (text(body.status)?.toUpperCase() === "REJECT") {
        const why = reasons.length > 0 ? reasons : ["n11 refused the task without giving a reason"];
        return {
          batchId: "",
          settled: [
            ...settled,
            ...skus.map((s) => ({
              reference: String(s.stockCode ?? ""),
              status: "rejected" as const,
              errors: why,
            })),
          ],
        };
      }

      const batchId = text(body.id);
      if (!batchId) {
        // A 200 with no task id is not a success we can follow up. Treating it
        // as one would strand every unit at `pending` forever.
        throw new Error("n11 accepted the products but returned no task id");
      }
      return { batchId, ...(settled.length > 0 ? { settled } : {}) };
    },

    /**
     * What became of a task.
     *
     * Two statuses, at two levels, and conflating them is the mistake to avoid.
     * The TASK is `IN_QUEUE` while it runs and `PROCESSED` when it is finished;
     * each SKU inside is `SUCCESS` or `Fail`. A task that is finished with a SKU
     * carrying neither has nothing further to say about it, so that unit is
     * closed rather than polled for ever.
     */
    async poll(ctx) {
      const headers = readConnection(ctx, "listing");
      // The ticket round-trips through our database, so it is re-derived as the
      // number n11 types it rather than echoed.
      const taskId = Number(ctx.batchId);
      if (!Number.isInteger(taskId) || taskId <= 0) throw new Error("n11 task id is not a task id");

      const res = await ctx.fetch(`${BASE}/ms/product/task-details/page-query`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, pageable: { page: 0, size: MAX_SKUS } }),
      });
      if (!res.ok) throw await readError(res, "read the listing task");

      const body = (await res.json()) as { skus?: unknown; status?: unknown };
      const taskStatus = text(body.status)?.toUpperCase();
      const done = taskStatus === "PROCESSED" || taskStatus === "REJECT";

      const out: ListingVerdict[] = [];
      for (const raw of asArray(obj(body.skus).content)) {
        const row = obj(raw);
        // n11's own words: the response's `itemCode` holds the stock code. It
        // is the only place our reference survives — there is no request id in
        // the answer.
        const reference = text(row.itemCode);
        if (!reference) continue;
        const status = text(row.status)?.toUpperCase();
        // `reasons` appears both on the row and inside `sku`, and which one is
        // filled varies; both are read so a reason is never dropped.
        const errors = [...asArray(row.reasons), ...asArray(obj(row.sku).reasons)]
          .map((r) => text(r))
          .filter((r): r is string => r !== null);

        if (status === "SUCCESS") {
          // n11 addresses a listing by the seller's own stock code — it mints no
          // separate product id — so the stock code IS the listing's id.
          out.push({ reference, status: "accepted", externalId: reference });
        } else if (status === "FAIL" || status === "FAILED") {
          out.push({
            reference,
            status: "rejected",
            errors: errors.length > 0 ? errors : ["n11 refused it without giving a reason"],
          });
        } else {
          out.push(
            done
              ? { reference, status: "rejected", errors: ["n11 finished the task without a verdict"] }
              : { reference, status: "pending" },
          );
        }
      }
      return out;
    },
  },
  /**
   * One task, because n11 accepts one transition.
   *
   * `UpdateOrder` documents `Picking` and says the other statuses will follow.
   * A single "set status" task with a value setting would therefore offer an
   * operator four values the API refuses — and when the rest do arrive they
   * arrive as more tasks, for the same reason Trendyol's two are two: the
   * once-only guard is keyed by (integration, task, row), so one task per
   * transition is what lets a package legitimately move twice.
   */
  tasks: [
    {
      id: "approve_package",
      label: "Approve package (picking)",
      settingFields: [
        {
          key: "packageIdField",
          label: "Package ID field",
          placeholder: "the row field holding the n11 package id, e.g. shipment_package_id",
        },
      ],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "approvedLines", label: "Lines approved" },
        { key: "notifiedAt", label: "Notified at" },
      ],
      /**
       * The row is a package; n11 approves LINES. So the package is read back
       * first and its line ids collected, rather than asking an operator to
       * keep a list of line ids in a column — they live in the child
       * collection, and a task acts on one row.
       *
       * Only lines still `Created` are sent. n11 refuses the rest and answers
       * per line, so filtering here is the difference between "approved four
       * lines" and a partial-success body nobody reads.
       */
      async run(ctx) {
        const headers = readConnection(ctx, "task");
        const packageId = readPackageId(ctx);

        const url = new URL(`${BASE}/rest/delivery/v1/shipmentPackages`);
        url.searchParams.set("packageIds", packageId);
        url.searchParams.set("page", "0");
        url.searchParams.set("size", "1");
        const found = await ctx.fetch(url.toString(), { headers });
        if (!found.ok) throw await readError(found, "read the package");

        const body = (await found.json()) as { content?: Record<string, unknown>[] };
        const pkg = body.content?.[0];
        if (!pkg) throw new Error(`n11 has no package ${packageId} for this seller`);

        const lineIds = (Array.isArray(pkg.lines) ? pkg.lines : [])
          .map((l) => obj(l))
          .filter((l) => text(l.orderItemLineItemStatusName) === "Created")
          .map((l) => num(l.orderLineId))
          .filter((id): id is number => id !== null);
        if (lineIds.length === 0) {
          throw new Error(`No line on package ${packageId} is waiting to be approved`);
        }

        const res = await ctx.fetch(`${BASE}/rest/order/v1/update`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ lines: lineIds.map((lineId) => ({ lineId })), status: "Picking" }),
        });
        if (!res.ok) throw await readError(res, "approve the package");

        const result = (await res.json().catch(() => ({}))) as { content?: { status?: unknown; reasons?: unknown }[] };
        const answered = result.content ?? [];
        const ok = answered.filter((l) => text(l.status) === "SUCCESS").length;
        // Every line refused is not a partial success to report as done: the
        // package has not moved, and saying it has would leave an order sitting
        // in `Created` with a row that claims otherwise.
        if (answered.length > 0 && ok === 0) {
          const reason = text(answered[0]?.reasons);
          throw new Error(`n11 approved no line on package ${packageId}${reason ? `: ${reason.slice(0, 160)}` : ""}`);
        }

        return {
          outputs: { status: "Picking", approvedLines: ok || lineIds.length, notifiedAt: Date.now() },
        };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

/**
 * The credential, as the two headers every call carries.
 *
 * n11 documents authorization as "none" and reads the pair from headers
 * instead. They reach a header verbatim, so a value with a control character
 * in it is refused here rather than being allowed to shape one.
 */
const readConnection = (ctx: { str(k: string): string | null }, what: string): Record<string, string> => {
  const appKey = ctx.str("appKey");
  const appSecret = ctx.str("appSecret");
  if (!appKey || !appSecret) throw new Error(`n11 ${what} has no app key and secret`);
  if (/[^\x20-\x7E]/.test(`${appKey}${appSecret}`)) {
    throw new Error("n11 app key and secret must be plain ASCII — check for a bad paste");
  }
  return { appkey: appKey, appsecret: appSecret, Accept: "application/json" };
};

// ── Packages ─────────────────────────────────────────────────────────────────

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_WINDOW_DAYS ? Math.floor(n) : MAX_WINDOW_DAYS;
};

const readEpoch = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A mid-run cursor, or `null` for anything else.
 *
 * The cursor round-trips through the database, so every part of it is re-parsed
 * rather than trusted. A malformed one is not an error: returning `null` starts
 * a fresh window, which re-reads rows that are upserted anyway.
 */
const readCursor = (cursor: string): { start: number; end: number; page: number } | null => {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const parts = cursor.slice(CURSOR_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const start = readEpoch(parts[0] ?? "");
  const end = readEpoch(parts[1] ?? "");
  const page = Number(parts[2]);
  if (start === null || end === null || !Number.isFinite(page) || page < 0) return null;
  return { start, end, page: Math.floor(page) };
};

const readSender = (raw: string | null): string =>
  (SENDERS as readonly string[]).includes(raw ?? "") ? (raw as string) : "SELLER";

/** Fetch one page of the window and decide what the run does next. */
const walk = async (
  ctx: {
    fetch: (u: string, i?: RequestInit) => Promise<Response>;
    limit: number;
    setting(k: string): string | null;
  },
  headers: Record<string, string>,
  start: number,
  windowEnd: number,
  page: number,
) => {
  const url = new URL(`${BASE}/rest/delivery/v1/shipmentPackages`);
  url.searchParams.set("startDate", String(start));
  url.searchParams.set("endDate", String(windowEnd));
  // The whole reason this source can mirror rather than snapshot: it re-points
  // the two dates above at `lastModifiedDate`. Without it the window bounds
  // creation, and a package would be seen once, in the status it was born with.
  url.searchParams.set("orderByField", "true");
  url.searchParams.set("orderByDirection", "ASC");
  url.searchParams.set("sender", readSender(ctx.setting("sender")));
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(Math.min(ctx.limit, PAGE)));

  const res = await ctx.fetch(url.toString(), { headers });
  if (!res.ok) throw await readError(res, "read the packages");
  const body = (await res.json()) as { content?: Record<string, unknown>[]; totalPages?: unknown };

  const raw = body.content ?? [];
  const records = raw
    .map((p) => {
      const id = recordIdFor(p);
      return id ? { externalId: id, data: packageData(p), children: { lines: linesOf(p.lines) } } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const totalPages = num(body.totalPages);
  // n11's own advice: page from 0 and treat the first empty `content` as the
  // end. `totalPages` is honoured too where it is present, so a walk stops one
  // request earlier than it otherwise would.
  const more = raw.length > 0 && (totalPages === null || page + 1 < totalPages);
  if (more) return { records, cursor: `${CURSOR_PREFIX}${start}:${windowEnd}:${page + 1}` };

  // The window is finished. Its END becomes the next run's start — the same
  // instant on both sides rather than one millisecond later, because a package
  // modified exactly on the boundary being read twice is free (rows are
  // upserted) and being skipped is not.
  return { records, cursor: null, resumeToken: `${RESUME_PREFIX}${windowEnd}` };
};

/**
 * The id this package lands under.
 *
 * Normally the package number. Location-specific delivery orders (`KTN`,
 * `EASYPOINT`, `PUP`) come back with `id: null` because n11 manages their
 * shipping in the seller panel rather than through this API — dropping them
 * would mean a seller's collection quietly missing a whole delivery type, so
 * they land under their order number instead.
 *
 * The fallback is PREFIXED. Package numbers and order numbers are both long
 * digit strings, and two different things sharing an id namespace is exactly
 * how one row silently overwrites another.
 */
const recordIdFor = (p: Record<string, unknown>): string | null => {
  const id = text(p.id);
  if (id) return id;
  const orderNumber = text(p.orderNumber);
  return orderNumber ? `order-${orderNumber}` : null;
};

/**
 * One package, flattened for mapping.
 *
 * Addresses are spread into their parts rather than handed over as objects: a
 * mapping targets one column, and an operator wanting the city in a `city`
 * column cannot get there from a nested blob.
 *
 * `neighborhood` is carried alongside `city` and `district` because a Turkish
 * address is il / ilçe / mahalle and a courier needs all three. Dropping it
 * here would mean the carrier integration has to go and re-fetch the order.
 */
const packageData = (p: Record<string, unknown>): Record<string, unknown> => {
  const ship = obj(p.shippingAddress);
  const bill = obj(p.billingAddress);
  return {
    shipmentPackageId: p.id ?? null,
    orderNumber: p.orderNumber ?? null,
    status: p.shipmentPackageStatus ?? null,
    lastModifiedDate: p.lastModifiedDate ?? null,
    agreedDeliveryDate: p.agreedDeliveryDate ?? null,
    totalAmount: p.totalAmount ?? null,
    totalDiscountAmount: p.totalDiscountAmount ?? null,
    installmentCharge: p.installmentChargeWithVATprice ?? null,

    customerId: p.customerId ?? null,
    // n11's own spelling. Kept rather than corrected: the picker should show
    // what their documentation shows.
    customerFullName: p.customerfullName ?? null,
    customerEmail: p.customerEmail ?? null,
    tcIdentityNumber: p.tcIdentityNumber ?? null,
    taxId: p.taxId ?? null,
    taxOffice: p.taxOffice ?? null,

    cargoProviderName: p.cargoProviderName ?? null,
    shipmentCompanyId: p.shipmentCompanyId ?? null,
    cargoTrackingNumber: p.cargoTrackingNumber ?? null,
    cargoSenderNumber: p.cargoSenderNumber ?? null,
    cargoTrackingLink: p.cargoTrackingLink ?? null,
    shipmentMethod: p.shipmentMethod ?? null,
    // `null` for a domestic order and `true` for an e-export one, which is what
    // decides whether the invoice has to be an export invoice.
    micro: p.micro ?? null,
    deliveryAddressType: p.deliveryAddressType ?? null,
    invoiceLink: p.invoiceLink ?? null,
    etgbNo: p.etgbNo ?? null,

    shipmentFullName: ship.fullName ?? null,
    shipmentAddress: ship.address ?? null,
    shipmentNeighbourhood: ship.neighborhood ?? null,
    shipmentDistrict: ship.district ?? null,
    shipmentCity: ship.city ?? null,
    shipmentPostalCode: ship.postalCode ?? null,
    shipmentPhone: ship.gsm ?? null,

    invoiceFullName: bill.fullName ?? null,
    invoiceAddress: bill.address ?? null,
    invoiceDistrict: bill.district ?? null,
    invoiceCity: bill.city ?? null,
    invoicePostalCode: bill.postalCode ?? null,
    invoiceCountryCode: bill.countryCode ?? null,
    // 1 is an individual and 2 a company, and on a company invoice n11 puts the
    // trading name in the customer's full-name field.
    invoiceType: bill.invoiceType ?? null,
    invoiceTaxId: bill.taxId ?? null,
    invoiceTaxOffice: bill.taxHouse ?? null,
  };
};

/**
 * The package's lines, as child records.
 *
 * `orderLineId` is only unique within its package, which is exactly the case
 * the engine qualifies a child key for — and it is also the id the approve task
 * sends back, so it is mapped rather than left in the blob.
 */
const linesOf = (raw: unknown): { externalId: string; data: Record<string, unknown> }[] => {
  if (!Array.isArray(raw)) return [];
  const out: { externalId: string; data: Record<string, unknown> }[] = [];
  for (const line of raw) {
    const l = obj(line);
    const id = text(l.orderLineId);
    if (!id) continue;
    out.push({
      externalId: id,
      data: {
        orderLineId: l.orderLineId ?? null,
        productId: l.productId ?? null,
        productName: l.productName ?? null,
        stockCode: l.stockCode ?? null,
        barcode: l.barcode ?? null,
        quantity: l.quantity ?? null,
        status: l.orderItemLineItemStatusName ?? null,
        unitPrice: l.price ?? null,
        dueAmount: l.dueAmount ?? null,
        sellerInvoiceAmount: l.sellerInvoiceAmount ?? null,
        sellerDiscount: l.sellerDiscount ?? null,
        sellerCouponDiscount: l.sellerCouponDiscount ?? null,
        totalSellerDiscount: l.totalSellerDiscountPrice ?? null,
        mallDiscount: l.mallDiscount ?? null,
        totalMallDiscount: l.totalMallDiscountPrice ?? null,
        vatRate: l.vatRate ?? null,
        commissionRate: l.commissionRate ?? null,
        sellerCampaignCommissionRate: l.sellerCampaignCommissionRate ?? null,
        deliveryFeeType: l.deliveryFeeType ?? null,
        sender: l.sender ?? null,
        productOrigin: l.productOrigin ?? null,
        hsCode: l.hsCode ?? null,
        // A list of `{name, value}` pairs, joined into the one string a column
        // can hold. "Numara: 45, Renk: Bordo" is what a picking list wants.
        variants: variants(l.variantAttributes),
      },
    });
  }
  return out;
};

const variants = (raw: unknown): string | null => {
  if (!Array.isArray(raw)) return null;
  const parts = raw
    .map((v) => obj(v))
    .map((v) => {
      const name = text(v.name);
      const value = text(v.value);
      return name && value ? `${name}: ${value}` : (value ?? null);
    })
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(", ") : null;
};

// ── Stock and price ──────────────────────────────────────────────────────────

/**
 * One mapped row as a SKU update, or `null` when it addresses nothing.
 *
 * Only the fields this sync is FOR are sent: n11 leaves an omitted field alone,
 * so a stock-only sync that also sent a price would overwrite whatever the
 * seller set in their panel — the exact surprise the `updates` setting exists
 * to prevent.
 *
 * Prices are rounded to two decimals and a list price is never allowed below
 * the sale price, because n11 REJECTS the whole task for either — and a task
 * rejected for a rounding artefact is a batch of rows that silently did not
 * update.
 */
const itemFor = (row: DestinationRow, mode: string): Record<string, unknown> | null => {
  const stockCode = text(row.stockCode);
  if (!stockCode) return null;
  const item: Record<string, unknown> = { stockCode };

  if (mode !== "price") {
    const quantity = num(row.quantity);
    // Whole units, and a negative stock is a mapping error rather than an
    // oversell to publish.
    if (quantity !== null) item.quantity = Math.max(0, Math.floor(quantity));
  }
  if (mode !== "stock") {
    const salePrice = money(row.salePrice);
    const listPrice = money(row.listPrice);
    // n11 refuses one without the other, so the pair is sent or neither is.
    // Defaulting the list price to the sale price is the reading that matches
    // an unmapped column: no crossed-out price, rather than a rejected task.
    if (salePrice !== null || listPrice !== null) {
      const sale = salePrice ?? listPrice ?? 0;
      item.salePrice = sale;
      item.listPrice = Math.max(listPrice ?? 0, sale);
      const currency = text(row.currencyType);
      if (currency) item.currencyType = currency;
    }
  }
  // A stock code alone updates nothing. Sending it would report a clean run for
  // a batch that changed nothing at all.
  return Object.keys(item).length > 1 ? item : null;
};

/** Two decimals, because anything else is rejected for the whole task. */
const money = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
};

/**
 * Ask what became of a submitted task, and fail only on the answer that is this
 * side's fault.
 *
 * Every SKU failed means the stock codes do not exist for this seller — a
 * mapping pointed at the wrong column, or a catalog that was never listed.
 * Throwing holds the watermark so those rows are re-sent once it is fixed.
 *
 * A partial failure does NOT throw, and that asymmetry is deliberate: one
 * delisted SKU among two hundred would otherwise hold the watermark on its row
 * for ever and the sync would never reach the rows behind it. Same rule as the
 * other marketplaces, for the same reason.
 *
 * A task still in the queue is not an answer, and is left alone.
 */
const verifyTask = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  headers: Record<string, string>,
  taskId: string,
): Promise<void> => {
  await sleep(TASK_SETTLE_MS);
  const res = await ctx.fetch(`${BASE}/ms/product/task-details/page-query`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: Number(taskId), pageable: { page: 0, size: MAX_SKUS } }),
  });
  // The task was accepted; not being able to read its result afterwards is not
  // grounds to re-send it.
  if (!res.ok) return;

  const body = (await res.json().catch(() => ({}))) as {
    skus?: { content?: { status?: unknown; reasons?: unknown }[] };
  };
  const rows = body.skus?.content ?? [];
  if (rows.length === 0) return;

  const failed = rows.filter((r) => text(r.status) !== "SUCCESS");
  if (failed.length < rows.length) return;

  const reason = Array.isArray(failed[0]?.reasons) ? text(failed[0]?.reasons?.[0]) : text(failed[0]?.reasons);
  throw new Error(
    `n11 refused every SKU in the batch — check the stock code mapping${reason ? `: ${reason.slice(0, 160)}` : ""}`,
  );
};

// ── Listings ─────────────────────────────────────────────────────────────────

/** n11's published cap on images per product. */
const MAX_IMAGES = 8;

/** The per-sync answers a SKU needs, read once per publish. */
type ListingOpts = {
  shipmentTemplate: string;
  preparingDay: number;
  vatRate: number;
  currencyType: string;
  maxPurchaseQuantity: number | null;
};

const readListingSettings = (ctx: { setting(k: string): string | null }): ListingOpts => {
  const shipmentTemplate = ctx.setting("shipmentTemplate")?.trim();
  if (!shipmentTemplate) {
    // Required by n11 on every product, and it is a name the seller chose — no
    // default could be right, and an omitted one REJECTs the whole task.
    throw new Error("n11 listing needs a shipment template name — the one from Hesabım > Teslimat Bilgilerim");
  }
  const vat = Number(ctx.setting("vatRate"));
  // n11 publishes the closed set and refuses the task for anything else.
  const vatRate = [0, 1, 10, 20].includes(vat) ? vat : 10;
  const prep = Number(ctx.setting("preparingDay"));
  const preparingDay = Number.isInteger(prep) && prep > 0 ? prep : 3;
  const currency = ctx.setting("currencyType");
  const currencyType = ["TL", "USD", "EUR"].includes(currency ?? "") ? (currency as string) : "TL";
  const max = Number(ctx.setting("maxPurchaseQuantity"));
  return {
    shipmentTemplate,
    preparingDay,
    vatRate,
    currencyType,
    maxPurchaseQuantity: Number.isInteger(max) && max > 0 ? max : null,
  };
};

/**
 * The image list, as n11's `{url, order}` pairs.
 *
 * https only — n11 states the requirement, and an http URL is silently dropped
 * at their end rather than refused, which reads as a product that listed
 * without pictures.
 */
const imageList = (v: unknown): { url: string; order: number }[] => {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,;|]/) : [];
  const out: { url: string; order: number }[] = [];
  for (const entry of raw) {
    // An array of `{url}` objects is what a media relation expands to.
    const s = typeof entry === "string" ? entry : text(obj(entry).url);
    const url = s?.trim();
    if (url && url.startsWith("https://") && !out.some((o) => o.url === url)) {
      out.push({ url, order: out.length });
    }
    if (out.length === MAX_IMAGES) break;
  }
  return out;
};

/**
 * One `skus[]` entry, or the reason this unit cannot become one.
 *
 * Returning the reason rather than throwing is the whole point: n11 REJECTs a
 * whole task for a bad data set and explains itself once for the batch, so one
 * product with no stock code would take its 199 healthy siblings down with it.
 * A refusal here is one verdict on one row, which is what an operator can fix.
 */
function buildSku(
  product: ListingProduct,
  variant: ListingVariant,
  opts: ListingOpts,
): Record<string, unknown> | string {
  const p = product.fields;
  const v = variant.fields;

  const stockCode = text(v.stockCode);
  if (!stockCode) return "No stock code — n11 addresses a listing by stock code, so it cannot be created without one";
  if (stockCode.length > 255) return `Stock code is ${stockCode.length} characters and n11 allows 255`;

  const title = text(p.title);
  if (!title) return "No title";
  const description = text(p.description);
  if (!description) return "No description";

  const quantity = num(v.quantity);
  if (quantity === null || quantity < 0) return "Stock quantity is missing or not a number";

  const salePrice = money(v.salePrice);
  const listPrice = money(v.listPrice);
  // n11 REJECTS the task for either — a missing pair or a list price below the
  // sale price — so both are checked here where the reason names the row.
  if (salePrice === null || listPrice === null) return "List price and sale price are both required";
  if (listPrice < salePrice) return "List price is below the sale price, which n11 refuses";

  const images = imageList(v.images ?? p.images);
  if (images.length === 0) return "No https image URL — n11 requires at least one, and refuses http";

  // n11 types both ids as numbers. A binding that is not one would serialise as
  // `null` and be refused with a reason naming the task rather than the
  // attribute, so it is caught here.
  const attributes: Record<string, unknown>[] = [];
  for (const a of variant.attributes) {
    const id = Number(a.attributeId);
    if (!Number.isInteger(id)) return `Attribute "${a.attributeId}" is not an n11 attribute id`;
    const valueId = a.valueId === undefined ? null : Number(a.valueId);
    if (valueId !== null && !Number.isInteger(valueId)) {
      return `Attribute "${a.attributeId}" has a value that is not an n11 value id`;
    }
    // n11's own examples send BOTH keys on every attribute, using nulls for the
    // half that does not apply — so the shape is matched rather than trimmed.
    attributes.push({
      id,
      valueId,
      customValue: a.custom ?? null,
    });
  }

  const barcode = text(v.barcode);

  return {
    // Truncated where an over-long stock code above was REFUSED, and the
    // difference is the point: a title is a label, so losing its tail still
    // lists the right product, while a stock code is an identifier and a
    // truncated one addresses a different listing.
    title: title.slice(0, 200),
    description,
    categoryId: Number(product.categoryId),
    currencyType: opts.currencyType,
    // The engine derives this from the product row's key, which is what makes
    // several stock codes one product page — and what makes a re-run land on
    // the same page rather than opening a second one.
    productMainId: product.groupId,
    preparingDay: opts.preparingDay,
    shipmentTemplate: opts.shipmentTemplate,
    stockCode,
    // Optional at n11, and used only to match their own catalog. Sent as null
    // rather than omitted, which is what their own variant example does.
    barcode: barcode ?? null,
    catalogId: null,
    quantity: Math.floor(quantity),
    images,
    attributes,
    salePrice,
    listPrice,
    vatRate: opts.vatRate,
    ...(opts.maxPurchaseQuantity === null ? {} : { maxPurchaseQuantity: opts.maxPurchaseQuantity }),
  };
}

/** A category or value id on its way into a URL path. Digits only, because it
 *  round-trips through our database first. */
const numericId = (raw: string, what: string): string => {
  const v = raw.trim();
  if (!/^\d{1,20}$/.test(v)) throw new Error(`n11 ${what} must be numeric`);
  return v;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * The package id this task acts on, read off the row.
 *
 * Digits-only, because it reaches a query parameter and then a second request
 * built from what came back. A row that carries something else is a mis-pointed
 * setting, and saying so beats an empty answer from a query nobody meant.
 */
const readPackageId = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("packageIdField");
  if (!field) throw new Error("n11 task needs the row field holding the package id");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no n11 package id`);
  if (!/^\d{1,25}$/.test(value)) {
    throw new Error(`"${field}" does not hold an n11 package id — it must be numeric`);
  }
  return value;
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
    const body = JSON.parse(raw) as { errors?: { message?: string }[]; message?: string; reasons?: unknown };
    const reasons = Array.isArray(body.reasons) ? text(body.reasons[0]) : null;
    detail = (body.errors?.[0]?.message ?? body.message ?? reasons ?? detail).slice(0, 160);
  } catch {
    // Not JSON — n11's gateway answers HTML on some failures, and the truncated
    // body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      "n11 rejected the credentials — check the app key and secret from your seller panel's API settings",
    );
  }
  return new Error(`n11 responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};
