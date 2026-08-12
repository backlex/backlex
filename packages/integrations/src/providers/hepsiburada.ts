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
 * Hepsiburada — a seller's orders and packages in, stock and price out, and the
 * fulfilment notifications the marketplace expects back.
 *
 * The second marketplace, and the one that answers the question phase 3 left
 * open: is a marketplace one file now? Almost. Everything below is built out of
 * shapes the engine already had — `childGroups` for an order's lines, `task` for
 * a notification that must not happen twice, an async batch verified afterwards
 * exactly as Trendyol's is. No engine change was needed for any of it.
 *
 * The one thing that did NOT fit is called out under "no webhook block" below,
 * and it is a genuine difference rather than an omission.
 *
 * Five facts about this API shape the code, and each one is load-bearing.
 *
 * **It is two hosts, one credential.** Orders live on `oms-external`, listings
 * on `listing-external`. Both take the same HTTP Basic pair, so they are one
 * connection here rather than two integrations an operator has to keep in step.
 *
 * **The test environment is a hostname, not a flag.** Hepsiburada's docs give
 * the `-sit` hosts and say production is the same URL with `-sit` removed. That
 * is a closed set of two, so it is a dropdown over {@link HOSTS} and never a
 * string built from config.
 *
 * **`User-Agent` is required.** Same trap as Trendyol: the request is refused
 * without it even when the credentials are right.
 *
 * **The order feeds filter on when a row was CREATED, not last modified.**
 * `begindate` is documented as "kalemler/paketler eklenen tarihten itibaren".
 * A watermark that marched forward would therefore see each package exactly
 * once — at creation, in whatever status it started in — and never again. So a
 * run re-walks a rolling window instead of advancing past it. See
 * {@link IntegrationSource.pull} and the absence of a resume token.
 *
 * **Stock and price land in a queue.** The upload answers with an id; whether
 * the listings took it is a second call. Same shape as Trendyol's
 * `batchRequestId`, and verified here under the same rule — every item refused
 * is a mapping error worth failing the run for, one of many is not.
 *
 * ## Why there is no webhook block
 *
 * Hepsiburada does have a push model, and it is not the shape this engine's
 * `webhook` capability describes. It does not POST to one endpoint you give it:
 * it requires the SELLER to stand up a REST API under a base URL and implement
 * a route per event — `POST {base}/orders`, `PUT {base}/packages/{no}/intransit`,
 * and so on for deliver, undeliver, unpack, cancel and address change — secured
 * with HTTP Basic credentials the seller shares out of band, with no
 * registration API and a manual test sign-off before it is enabled in
 * production.
 *
 * Supporting that means one subscription owning SEVERAL routed paths and two
 * methods, which is a real extension to {@link IntegrationWebhook} rather than a
 * quirk to absorb in a provider. It is deliberately not made here on the
 * strength of one example, for the same reason phase 3 refused to lift an
 * address-and-parcel shape out of a single carrier. If a second provider wants
 * the same many-paths-one-subscription shape, that is the signal to build it.
 *
 * Until then the poll below is the whole story, and it is not a bad one: the
 * feeds are cheap, the published allowance is a thousand requests a second, and
 * a re-walked window repairs itself in a way a missed delivery never does.
 */

/**
 * Where each API lives, per environment. A closed set: never built from input.
 *
 * Two hosts because Hepsiburada splits them, not because this provider chose to.
 * The `-sit` pair is what their documentation's examples use; production is
 * documented as the same names with `-sit` removed.
 */
const HOSTS = {
  production: {
    oms: "https://oms-external.hepsiburada.com",
    listing: "https://listing-external.hepsiburada.com",
    // A THIRD host, and it is the catalog's: creating a product, reading the
    // category tree and reading a category's attributes all live here, while
    // `listing` above only ever changes an offer that already exists.
    catalog: "https://mpop.hepsiburada.com/product",
  },
  test: {
    oms: "https://oms-external-sit.hepsiburada.com",
    listing: "https://listing-external-sit.hepsiburada.com",
    catalog: "https://mpop-sit.hepsiburada.com/product",
  },
} as const;

type Environment = keyof typeof HOSTS;

/**
 * The feeds a sync can mirror.
 *
 * Hepsiburada has no single "everything that changed" endpoint — the lifecycle
 * is split across endpoints that each return a different entity. Rather than
 * pick one and call it "orders", the choice is the operator's, and the record
 * shape follows from it:
 *
 * - `packages` — whole packages, keyed by package number. The closest analogue
 *   to Trendyol's shipment package, and the feed that carries an address, a
 *   status and the lines in one record.
 * - `orders` — line items not yet packed (`Open` / `Unpacked`), grouped into
 *   one record per order number.
 * - `cancelled` — cancelled line items, same grouping.
 *
 * A sync is one feed, so two feeds mirrored into one collection are two syncs
 * and therefore two id namespaces — which is what stops a package number and an
 * order number, different value spaces both, from ever colliding on a row.
 */
const FEEDS = ["packages", "orders", "cancelled"] as const;
type Feed = (typeof FEEDS)[number];

/**
 * Hepsiburada's documented cap on the packages feed: "en fazla ve varsayılan
 * olarak 10 paket".
 *
 * Only that feed publishes a cap. The line-item feeds are left to the engine's
 * own page bound rather than given an invented one — and the walk below ends on
 * `totalCount` rather than on a short page, so a cap nobody documented cannot
 * end the walk early either.
 */
const PACKAGES_PAGE = 10;

/** The widest lookback a sync will re-walk, and the default when unset. */
const MAX_LOOKBACK_DAYS = 30;
const DEFAULT_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;

/** How long to wait before asking what became of a submitted upload. */
const UPLOAD_SETTLE_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const hepsiburada = defineProvider({
  id: "hepsiburada",
  label: "Hepsiburada",
  category: "marketplace",
  capabilities: ["source", "destination", "task", "listing"],
  /**
   * Hepsiburada publishes a thousand requests per second and returns
   * `X-RateLimit-*` headers with a 429. Paced well under it: the bucket is
   * per-isolate and best-effort, and nothing here needs that much — the widest
   * walk is a rolling window of packages ten at a time.
   */
  limits: { rps: 20, burst: 40 },
  configFields: [
    {
      key: "merchantId",
      label: "Merchant ID",
      placeholder: "the GUID Hepsiburada issued for this store",
    },
    { key: "username", label: "API username", secret: true },
    { key: "password", label: "API password", secret: true },
    {
      key: "environment",
      label: "Environment",
      options: [
        { value: "production", label: "Production" },
        { value: "test", label: "Test (SIT)" },
      ],
    },
  ],
  source: {
    childGroups: [{ key: "lines", label: "Order lines" }],
    settingFields: [
      {
        key: "feed",
        label: "What to mirror",
        options: [
          { value: "packages", label: "Packages (packed and later)" },
          { value: "orders", label: "Orders awaiting packing" },
          { value: "cancelled", label: "Cancelled line items" },
        ],
      },
      {
        key: "lookbackDays",
        label: "Each run re-reads",
        options: [
          { value: "1", label: "Last 24 hours" },
          { value: "7", label: "Last 7 days" },
          { value: "14", label: "Last 14 days" },
          { value: "30", label: "Last 30 days (max)" },
        ],
      },
    ],
    /**
     * One page of the chosen feed, inside a rolling window.
     *
     * The window does NOT advance between runs, and that is the whole design
     * decision of this source. `begindate` filters on creation, so a run that
     * started where the last one finished would see every package exactly once,
     * frozen in whatever status it was created with. Re-reading is free — rows
     * are upserted — and it is the only way the collection ever learns that
     * yesterday's package shipped.
     *
     * Which also means there is no resume token below. The engine's documented
     * default is exactly right here: a page walk ends, and the next run reads
     * the source from the top again to pick up edits.
     */
    async pull(ctx) {
      const conn = readConnection(ctx, "sync");
      const feed = readFeed(ctx.setting("feed"));
      const offset = readOffset(ctx.cursor);

      const now = Date.now();
      const lookback = readLookbackDays(ctx.setting("lookbackDays"));
      const limit = feed === "packages" ? Math.min(ctx.limit, PACKAGES_PAGE) : ctx.limit;

      const url = new URL(`${conn.oms}${FEED_PATHS[feed](conn.merchantId)}`);
      url.searchParams.set("begindate", isoDate(now - lookback * DAY_MS));
      url.searchParams.set("enddate", isoDate(now));
      url.searchParams.set("limit", String(limit));
      // Documented capitalised on the packages feed and lower-case on the
      // line-item ones. Sent both ways rather than guessed at: an unknown query
      // parameter is ignored, and getting this wrong silently re-reads page one
      // for ever.
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("Offset", String(offset));

      const res = await ctx.fetch(url.toString(), { headers: conn.headers });
      if (!res.ok) throw await readError(res, `read the ${feed}`);
      const body = (await res.json()) as unknown;

      const page = feed === "packages" ? packagePage(body) : lineItemPage(body, feed);
      const seen = offset + page.count;

      // `totalCount` is what ends the walk on the paged feeds, rather than a
      // short page: only the packages feed documents a cap, and ending on
      // "fewer than asked for" would stop early against any undocumented one.
      const more = page.total === null ? page.count >= limit : seen < page.total;
      return { records: page.records, cursor: more && page.count > 0 ? String(seen) : null };
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
     * Same argument as Trendyol's: the two uploads are independent endpoints,
     * and most sellers mirror one of them while managing the other in the
     * panel. Offering a price column on a stock-only sync would be a column
     * that is silently dropped.
     *
     * A listing is addressed by EITHER identifier, so both are offered
     * unconditionally and {@link itemFor} refuses a row that carries neither.
     */
    columns: [
      { value: "hepsiburadaSku", label: "Hepsiburada SKU (HBSKU)" },
      { value: "merchantSku", label: "Merchant SKU" },
      { value: "availableStock", label: "Available stock", when: { updates: ["stock", "both"] } },
      {
        value: "maximumPurchasableQuantity",
        label: "Max purchasable quantity",
        when: { updates: ["stock", "both"] },
      },
      { value: "price", label: "Price", when: { updates: ["price", "both"] } },
    ],
    async push(ctx) {
      const conn = readConnection(ctx, "write-back");
      const mode = ctx.setting("updates") ?? "both";

      // Built once and filtered per upload, so a row missing a price does not
      // also drop out of the stock upload it was perfectly valid for.
      const rows = ctx.rows.map((row) => itemFor(row)).filter((r): r is Identified => r !== null);
      if (rows.length === 0) {
        throw new Error(
          "No row in the batch carried a Hepsiburada SKU or a merchant SKU — check the column mapping",
        );
      }

      if (mode !== "price") await upload(ctx, conn, "stock", rows.map(stockItem).filter(hasValue));
      if (mode !== "stock") await upload(ctx, conn, "price", rows.map(priceItem).filter(hasValue));
    },
  },
  /**
   * The notifications a seller owes the marketplace, one task each.
   *
   * Split for the same reason Trendyol's two are: the once-only guard is keyed
   * by (integration, task, row), so a single `set_status` task would notify
   * "in transit" and then refuse to notify "delivered", handing back the first
   * run's answer instead. A package legitimately moves several times, and
   * "exactly once" has to mean once per move.
   *
   * `refresh_package` is the exception and is marked repeatable — it is a read.
   */
  /**
   * Putting a product ON SALE — and the odd one out on three axes at once,
   * every one of them absorbed here rather than by the engine.
   *
   * 1. **The categories are PAGED.** The other three hand back the whole tree
   *    in one request; this one is walked.
   * 2. **An attribute's values are a SECOND call**, one per attribute. The
   *    other three send the values inline.
   * 3. **The create is a FILE.** `POST /api/products/import` takes
   *    `multipart/form-data` with one binary part — and the part is a JSON
   *    document, which is the fact that made this implementable at all.
   *
   * A fourth thing is subtler and shapes the code more than any of them: **the
   * file keys on attribute NAMES, and its values are value NAMES** —
   * `"Marka": "Nike"`, `"renk_variant_property": "Siyah"`. So this provider
   * reports each attribute's NAME as its id. Our engine hands `publish` the
   * stored binding and nothing else; had the ids been Hepsiburada's own, the
   * provider would have to re-fetch and re-walk the whole category to turn them
   * back into the names the file needs.
   *
   * **`FAILED` here means a TECHNICAL error and is worth re-sending**, where the
   * same word at the other three means the marketplace refused the product. The
   * distinction is not translated away: it is reported as a rejection with
   * Hepsiburada's own words attached, because an operator re-sending is a
   * decision, not something to do silently on their behalf.
   */
  listing: {
    columns: [
      { value: "UrunAdi", label: "Product name" },
      { value: "UrunAciklamasi", label: "Description" },
      { value: "Marka", label: "Brand name" },
      { value: "images", label: "Image URLs (up to 10)" },
      { value: "Video1", label: "Video URL (optional)" },
      { value: "GarantiSuresi", label: "Warranty in months (optional)" },
    ],
    variantColumns: [
      { value: "merchantSku", label: "Merchant SKU" },
      { value: "Barcode", label: "Barcode" },
      { value: "price", label: "Price" },
      { value: "stock", label: "Stock quantity" },
      { value: "tax_vat_rate", label: "VAT rate" },
    ],
    // Hepsiburada echoes our own `merchantSku` on every status row — `hbSku` is
    // theirs and does not exist until the product is created.
    referenceColumn: "merchantSku",
    outputs: [
      { key: "listingId", label: "Hepsiburada SKU (hbSku)" },
      { key: "listingStatus", label: "Listing status" },
      { key: "listingError", label: "Rejection reason" },
      { key: "listedAt", label: "Listed at" },
    ],

    /**
     * The tree, walked.
     *
     * `leaf=false` is NOT sent: a picker needs the parents too, to show an
     * operator where a leaf sits. The walk is bounded — a tree that never ends
     * is a paging bug at the far end, and the alternative to a bound is a form
     * that never loads.
     */
    async categories(ctx) {
      const conn = readConnection(ctx, "listing");
      const out: ListingCategory[] = [];
      for (let page = 0; page < MAX_CATEGORY_PAGES; page++) {
        const url = new URL(`${conn.catalog}/api/categories/get-all-categories`);
        url.searchParams.set("status", "ACTIVE");
        url.searchParams.set("page", String(page));
        url.searchParams.set("size", String(CATEGORY_PAGE));
        const res = await ctx.fetch(url.toString(), { headers: conn.headers });
        if (!res.ok) throw await readError(res, "read the categories");
        const body = (await res.json()) as { data?: unknown };
        const rows = asArray(obj(body.data).data ?? body.data);
        if (rows.length === 0) break;
        for (const raw of rows) {
          const row = obj(raw);
          const id = text(row.categoryId);
          if (!id) continue;
          out.push({
            id,
            // `displayName` is what a person reads; `name` is the slug-ish one.
            name: text(row.displayName) ?? text(row.name) ?? id,
            parentId: text(row.parentCategoryId),
            leaf: row.leaf === true,
          });
        }
        if (rows.length < CATEGORY_PAGE) break;
      }
      return out;
    },

    /**
     * What one category demands — and the only `attributes` here that costs
     * more than one request.
     *
     * `baseAttributes` are deliberately DROPPED: they are the fixed fields
     * (`UrunAdi`, `price`, `stock`, …) already declared as columns above, and
     * returning them would ask an operator to map the same thing twice, in two
     * places that could then disagree.
     *
     * Values come from a second call PER attribute, so the number of requests
     * is bounded. An attribute past the bound, or one whose values cannot be
     * read, is offered as free text rather than dropped — a required attribute
     * that vanished would make the category unlistable.
     */
    async attributes(ctx) {
      const conn = readConnection(ctx, "listing");
      const categoryId = numericId(ctx.categoryId, "category id");
      const res = await ctx.fetch(`${conn.catalog}/api/categories/${categoryId}/attributes`, {
        headers: conn.headers,
      });
      if (!res.ok) throw await readError(res, "read the category attributes");
      const body = (await res.json()) as { data?: unknown };
      const data = obj(obj(body.data).data ?? body.data);

      const declared: { raw: Record<string, unknown>; variant: boolean }[] = [
        ...asArray(data.attributes).map((a) => ({ raw: obj(a), variant: false })),
        ...asArray(data.variantAttributes).map((a) => ({ raw: obj(a), variant: true })),
      ];

      const out: ListingAttribute[] = [];
      let lookups = 0;
      for (const { raw, variant } of declared) {
        // The NAME is the identifier, because the name is what the import file
        // uses as its key. See this block's note.
        const name = text(raw.name);
        if (!name) continue;
        const attributeId = text(raw.id);
        let values: { id: string; name: string }[] = [];
        if (attributeId && lookups < MAX_VALUE_LOOKUPS) {
          lookups++;
          values = await readAttributeValues(ctx, conn, categoryId, attributeId);
        }
        out.push({
          id: name,
          name,
          required: raw.mandatory === true,
          variant,
          multiple: raw.multiValue === true,
          // With no closed set to pick from, free text is the only answer left.
          allowCustom: values.length === 0,
          values,
        });
      }
      return out;
    },

    async publish(ctx) {
      const conn = readConnection(ctx, "listing");

      // One file per CATEGORY, because the file names its category once at the
      // top rather than per row. A batch spanning two categories is therefore
      // two requests — and the engine expects one ticket, so the rest are left
      // for the next run rather than silently dropped.
      const byCategory = new Map<string, ListingProduct[]>();
      for (const product of ctx.products) {
        const list = byCategory.get(product.categoryId) ?? [];
        list.push(product);
        byCategory.set(product.categoryId, list);
      }
      const [first] = [...byCategory.entries()];
      if (!first) return { batchId: "", rejected: [] };
      const [categoryId, products] = first;

      const rows: Record<string, unknown>[] = [];
      const rejected: ListingVerdict[] = [];
      for (const product of products) {
        for (const variant of product.variants) {
          const built = buildImportRow(product, variant);
          if (typeof built === "string") {
            rejected.push({ reference: variant.reference, status: "rejected", errors: [built] });
            continue;
          }
          rows.push(built);
        }
      }
      // Anything in another category is not refused — it is simply not in this
      // file, and the next run picks it up.
      if (rows.length === 0) return { batchId: "", rejected };

      const file = JSON.stringify({
        categoryId: Number(numericId(categoryId, "category id")),
        merchant: conn.merchantId,
        attributes: rows,
      });
      const form = new FormData();
      // The part is a JSON DOCUMENT sent as a file — the name matters only in
      // so far as it must be there.
      form.append("file", new Blob([file], { type: "application/json" }), "products.json");

      const res = await ctx.fetch(`${conn.catalog}/api/products/import?version=1`, {
        method: "POST",
        // Content-Type is deliberately NOT set: the boundary is generated with
        // the body, and a hand-written header would name a boundary that is not
        // in it.
        headers: conn.headers,
        body: form,
      });
      if (!res.ok) throw await readError(res, "create the products");

      const body = (await res.json().catch(() => ({}))) as { data?: unknown };
      const batchId = text(obj(body.data).trackingId ?? obj(body.data).data ?? body.data);
      if (!batchId) {
        throw new Error("Hepsiburada accepted the products but returned no tracking id");
      }
      return { batchId, ...(rejected.length > 0 ? { rejected } : {}) };
    },

    /**
     * What became of an import.
     *
     * **`FAILED` is a technical error at Hepsiburada, not a refusal**, and the
     * roadmap's rule holds: the same word must not be translated twice. It is
     * still reported as a rejection — the unit did not list — but the reason
     * carries Hepsiburada's own words, and a sentence saying it is worth
     * re-sending, which is the only thing that distinguishes it for the person
     * who has to act.
     */
    async poll(ctx) {
      const conn = readConnection(ctx, "listing");
      const trackingId = ctx.batchId.trim();
      // The ticket is Hepsiburada's own and goes into a URL PATH, so it is
      // checked rather than trusted: it round-trips through our database first.
      if (!/^[A-Za-z0-9-]{1,64}$/.test(trackingId)) {
        throw new Error("Hepsiburada tracking id is not a tracking id");
      }

      const res = await ctx.fetch(`${conn.catalog}/api/products/status/${trackingId}`, {
        headers: conn.headers,
      });
      if (!res.ok) throw await readError(res, "read the listing import");
      const body = (await res.json()) as { data?: unknown };
      const rows = asArray(obj(body.data).data ?? body.data);

      const out: ListingVerdict[] = [];
      for (const raw of rows) {
        const row = obj(raw);
        const reference = text(row.merchantSku);
        if (!reference) continue;
        const status = text(row.importStatus)?.toUpperCase();
        const reasons = asArray(row.rejectReasonsMessages)
          .map((r) => text(r))
          .filter((r): r is string => r !== null);

        if (status === "SUCCESS") {
          // `hbSku` is Hepsiburada's own id and the one an operator needs to
          // find the product in their panel.
          out.push({ reference, status: "accepted", externalId: text(row.hbSku) ?? reference });
        } else if (status === "FAILED") {
          out.push({
            reference,
            status: "rejected",
            errors: [
              ...(reasons.length > 0 ? reasons : ["Hepsiburada refused it without giving a reason"]),
              "Hepsiburada reports this as a technical failure rather than a rejection — sending it again is usually the fix",
            ],
          });
        } else {
          out.push({ reference, status: "pending" });
        }
      }
      return out;
    },
  },
  tasks: [
    {
      id: "mark_intransit",
      label: "Mark as shipped (in transit)",
      settingFields: [
        packageNumberSetting(),
        {
          key: "trackingNumberField",
          label: "Tracking number field",
          placeholder: "the row field holding the carrier's tracking number, e.g. tracking_number",
        },
        {
          key: "trackingUrlField",
          label: "Tracking URL field (optional)",
          placeholder: "the row field holding the carrier's tracking link",
        },
        {
          key: "deciField",
          label: "Desi field (optional)",
          placeholder: "the row field holding the parcel's volumetric weight",
        },
      ],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "trackingNumber", label: "Tracking number sent" },
        { key: "shippedAt", label: "Shipped at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const packageNumber = readPackageNumber(ctx);

        const trackingNumber = requiredRowValue(ctx, "trackingNumberField", "tracking number");
        const shippedDate = new Date().toISOString();
        const trackingUrl = optionalRowValue(ctx, "trackingUrlField");
        const deci = optionalRowNumber(ctx, "deciField");

        await packageAction(ctx, conn, packageNumber, "intransit", "POST", {
          shippedDate,
          trackingNumber,
          ...(trackingUrl === null ? {} : { trackingUrl }),
          ...(deci === null ? {} : { deci }),
        });

        return { outputs: { status: "InTransit", trackingNumber, shippedAt: Date.parse(shippedDate) } };
      },
    },
    {
      id: "mark_delivered",
      label: "Mark as delivered",
      settingFields: [
        packageNumberSetting(),
        {
          key: "receivedByField",
          label: "Received by field (optional)",
          placeholder: "the row field naming who took delivery",
        },
      ],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "receivedBy", label: "Received by" },
        { key: "deliveredAt", label: "Delivered at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const packageNumber = readPackageNumber(ctx);
        const receivedBy = optionalRowValue(ctx, "receivedByField");
        const receivedDate = new Date().toISOString();

        await packageAction(ctx, conn, packageNumber, "deliver", "POST", {
          receivedDate,
          ...(receivedBy === null ? {} : { receivedBy }),
        });

        return {
          outputs: { status: "Delivered", receivedBy, deliveredAt: Date.parse(receivedDate) },
        };
      },
    },
    {
      id: "mark_undelivered",
      label: "Mark as undelivered",
      settingFields: [
        packageNumberSetting(),
        {
          key: "reasonField",
          label: "Reason field",
          placeholder: "the row field holding why delivery failed, e.g. undelivered_reason",
        },
      ],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "reason", label: "Reason sent" },
        { key: "undeliveredAt", label: "Reported at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const packageNumber = readPackageNumber(ctx);
        const undeliveredReason = requiredRowValue(ctx, "reasonField", "reason");
        const undeliveredDate = new Date().toISOString();

        await packageAction(ctx, conn, packageNumber, "undeliver", "POST", {
          undeliveredDate,
          undeliveredReason,
        });

        return {
          outputs: {
            status: "UnDelivered",
            reason: undeliveredReason,
            undeliveredAt: Date.parse(undeliveredDate),
          },
        };
      },
    },
    {
      id: "send_invoice_link",
      label: "Send invoice link",
      settingFields: [
        packageNumberSetting(),
        {
          key: "invoiceLinkField",
          label: "Invoice link field",
          placeholder: "the row field holding the invoice's URL, e.g. invoice_url",
        },
        {
          key: "serialNumberField",
          label: "Invoice serial number field (optional)",
          placeholder: "the row field holding the invoice serial, e.g. invoice_serial",
        },
        {
          key: "rowNumberField",
          label: "Invoice row number field (optional)",
          placeholder: "the row field holding the invoice number, e.g. invoice_number",
        },
      ],
      outputs: [
        { key: "invoiceLink", label: "Invoice link sent" },
        { key: "invoicedAt", label: "Sent at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const packageNumber = readPackageNumber(ctx);
        const invoiceLink = requiredRowValue(ctx, "invoiceLinkField", "invoice link");
        const arrangementDate = new Date().toISOString();
        const serialNumber = optionalRowValue(ctx, "serialNumberField");
        const rowNumber = optionalRowValue(ctx, "rowNumberField");

        await packageAction(ctx, conn, packageNumber, "invoice", "PUT", {
          arrangementDate,
          invoiceLink,
          ...(serialNumber === null ? {} : { serialNumber }),
          ...(rowNumber === null ? {} : { rowNumber }),
        });

        return { outputs: { invoiceLink, invoicedAt: Date.parse(arrangementDate) } };
      },
    },
    {
      id: "get_label",
      label: "Get shipping barcode",
      /**
       * Deliberately NOT repeatable, despite being a GET.
       *
       * Hepsiburada calls this one "ortak barkod oluşturma" — creating a shared
       * barcode — so asking twice is not provably free, and `repeatable` is a
       * claim about the provider having no side effect rather than about the
       * HTTP verb. The safe default is the guard; a re-run is still available
       * deliberately.
       *
       * The payload is handed over verbatim rather than turned into a stored
       * artifact. `BarcodeData` is documented as `{ data: string[], format }`
       * and the ENCODING of those strings is not part of the contract — so
       * calling it a PDF and storing it as one would be a guess this file is
       * not entitled to make. Same rule as EasyPost's label host.
       */
      settingFields: [
        packageNumberSetting(),
        {
          key: "format",
          label: "Label format (optional)",
          placeholder: "the format Hepsiburada should render, when your account uses one",
        },
      ],
      outputs: [
        { key: "labelFormat", label: "Label format" },
        { key: "labelData", label: "Label data" },
        { key: "labelCount", label: "Labels returned" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const packageNumber = readPackageNumber(ctx);

        const url = new URL(
          `${conn.oms}/packages/merchantid/${conn.merchantId}/packagenumber/${encodeURIComponent(packageNumber)}/labels`,
        );
        const format = ctx.setting("format");
        if (format) url.searchParams.set("format", format);

        const res = await ctx.fetch(url.toString(), { headers: conn.headers });
        if (!res.ok) throw await readError(res, "create the barcode");
        const body = (await res.json()) as { data?: unknown; format?: unknown };

        const data = Array.isArray(body.data) ? body.data.filter((d): d is string => typeof d === "string") : [];
        if (data.length === 0) {
          throw new Error(`Hepsiburada returned no barcode for package ${packageNumber}`);
        }
        return {
          outputs: {
            labelFormat: text(body.format),
            // Joined rather than handed over as an array: the output lands in
            // one column, and a seller printing one package's barcode has one.
            labelData: data.join("\n"),
            labelCount: data.length,
          },
        };
      },
    },
    {
      id: "refresh_package",
      label: "Refresh package tracking",
      /**
       * The read half, and the one task here that is genuinely repeatable.
       *
       * Where a package is has no side effect at Hepsiburada, and its whole
       * value is that the answer moves. Under the once-only guard the row would
       * keep the status it had the first time anyone asked. Put it on a cron
       * flow over the packages that are not delivered yet.
       */
      repeatable: true,
      settingFields: [packageNumberSetting()],
      outputs: [
        { key: "status", label: "Package status" },
        { key: "trackingNumber", label: "Tracking number" },
        { key: "trackingUrl", label: "Tracking URL" },
        { key: "cargoCompany", label: "Carrier" },
        { key: "barcode", label: "Delivery barcode" },
        { key: "estimatedDeliveryAt", label: "Estimated delivery" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const packageNumber = readPackageNumber(ctx);

        const res = await ctx.fetch(
          `${conn.oms}/packages/merchantid/${conn.merchantId}/packagenumber/${encodeURIComponent(packageNumber)}`,
          { headers: conn.headers },
        );
        if (!res.ok) throw await readError(res, "read the package");
        const body = (await res.json()) as Record<string, unknown>;

        return {
          outputs: {
            status: text(body.status),
            trackingNumber: text(body.trackingInfoCode),
            trackingUrl: text(body.trackingInfoUrl),
            cargoCompany: text(body.cargoCompany),
            barcode: text(body.barcode),
            estimatedDeliveryAt: epoch(body.estimatedArrivalDate),
          },
        };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  merchantId: string;
  oms: string;
  listing: string;
  catalog: string;
  headers: Record<string, string>;
}

/**
 * Read the credentials and turn them into the headers every call needs.
 *
 * `merchantId` is interpolated into every URL path, so it is checked to be a
 * GUID before it goes anywhere near one — Hepsiburada issues it as a GUID, and
 * a value that is not one is a mis-paste rather than a request worth sending.
 */
const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const merchantId = ctx.str("merchantId");
  if (!merchantId) throw new Error(`Hepsiburada ${what} has no merchant id`);
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(merchantId)) {
    throw new Error("Hepsiburada merchant id must be the GUID from your integration details");
  }

  const username = ctx.str("username");
  const password = ctx.str("password");
  if (!username || !password) throw new Error(`Hepsiburada ${what} has no API username and password`);
  // `btoa` throws on anything outside Latin-1 and names a DOM API while doing
  // it. A credential with a stray non-ASCII character is a paste that went
  // wrong, and saying so is the difference between fixing it and filing a bug.
  if (/[^\x20-\x7E]/.test(`${username}${password}`)) {
    throw new Error("Hepsiburada username and password must be plain ASCII — check for a bad paste");
  }

  const environment: Environment = ctx.str("environment") === "test" ? "test" : "production";
  const hosts = HOSTS[environment];

  return {
    merchantId,
    oms: hosts.oms,
    listing: hosts.listing,
    catalog: hosts.catalog,
    headers: {
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
      // Documented as required on every operation. A request without it is
      // refused, credentials notwithstanding — the same trap Trendyol sets.
      "User-Agent": `${merchantId} - backlex`,
      Accept: "application/json",
    },
  };
};

// ── Feeds ────────────────────────────────────────────────────────────────────

const FEED_PATHS: Record<Feed, (merchantId: string) => string> = {
  packages: (m) => `/packages/merchantid/${m}`,
  orders: (m) => `/orders/merchantid/${m}`,
  cancelled: (m) => `/orders/merchantid/${m}/cancelled`,
};

const readFeed = (raw: string | null): Feed =>
  (FEEDS as readonly string[]).includes(raw ?? "") ? (raw as Feed) : "packages";

const readLookbackDays = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_LOOKBACK_DAYS ? Math.floor(n) : DEFAULT_LOOKBACK_DAYS;
};

/**
 * The offset this page starts at.
 *
 * The cursor round-trips through the database and back into a query parameter,
 * so it is re-derived as a number rather than echoed — a cursor holding
 * anything else restarts the walk, which is the harmless answer.
 */
const readOffset = (cursor: string | null): number => {
  const n = cursor === null ? 0 : Number(cursor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Hepsiburada's date filters take a plain ISO timestamp. */
const isoDate = (ms: number): string => new Date(ms).toISOString();

interface Page {
  records: { externalId: string; data: Record<string, unknown>; children: Record<string, Child[]> }[];
  /** How many rows the API returned, before grouping. Ends the walk. */
  count: number;
  total: number | null;
}

interface Child {
  externalId: string;
  data: Record<string, unknown>;
}

/**
 * The packages feed: a bare array of whole packages, each already an order-like
 * record with its own lines.
 */
const packagePage = (body: unknown): Page => {
  const raw = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  const records = raw
    .map((p) => {
      const id = text(p.packageNumber) ?? text(p.id);
      return id ? { externalId: id, data: packageData(p), children: { lines: packageLines(p.items) } } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  return { records, count: raw.length, total: null };
};

/**
 * The line-item feeds, grouped into one record per order number.
 *
 * The API returns a flat list of lines and this engine's records are headers
 * with children, so the grouping happens here. An order split across two pages
 * is not a problem: children are upserted, so the second page adds the lines
 * the first one did not carry rather than replacing them.
 */
const lineItemPage = (body: unknown, feed: Feed): Page => {
  const env = obj(body);
  const raw = Array.isArray(env.items) ? (env.items as Record<string, unknown>[]) : [];

  const byOrder = new Map<string, { data: Record<string, unknown>; lines: Child[] }>();
  for (const line of raw) {
    const orderNumber = text(line.orderNumber);
    if (!orderNumber) continue;
    const lineId = text(line.id) ?? text(line.lineItemId);
    if (!lineId) continue;

    let entry = byOrder.get(orderNumber);
    if (!entry) {
      // The header is taken from the first line of the order: order number,
      // date, customer and addresses are per-order values repeated on every
      // line, so any line carries them.
      entry = { data: feed === "cancelled" ? cancelledData(line) : orderData(line), lines: [] };
      byOrder.set(orderNumber, entry);
    }
    entry.lines.push({ externalId: lineId, data: feed === "cancelled" ? cancelledLine(line) : orderLine(line) });
  }

  const records = [...byOrder.entries()].map(([externalId, e]) => ({
    externalId,
    data: e.data,
    children: { lines: e.lines },
  }));
  return { records, count: raw.length, total: num(env.totalCount) };
};

// ── Record shapes ────────────────────────────────────────────────────────────

/**
 * One package, flattened for mapping.
 *
 * Addresses are spread into their parts rather than handed over as objects: a
 * mapping targets one column, and an operator wanting the city in a `city`
 * column cannot get there from a nested blob. Names keep Hepsiburada's own
 * where there is one, so the picker matches their panel and their docs.
 *
 * A Turkish address is il / ilçe / mahalle, which arrives here as
 * city / town / district — note that `town` is the ilçe and `district` the
 * mahalle, which is the opposite of what the English words suggest and is
 * exactly the kind of thing worth writing down once.
 */
const packageData = (p: Record<string, unknown>): Record<string, unknown> => ({
  packageNumber: p.packageNumber ?? null,
  packageId: p.id ?? null,
  barcode: p.barcode ?? null,
  status: p.status ?? null,
  orderDate: p.orderDate ?? null,
  dueDate: p.dueDate ?? null,
  unpackedDate: p.unpackedDate ?? null,
  estimatedArrivalDate: p.estimatedArrivalDate ?? null,
  cargoCompany: p.cargoCompany ?? null,
  isCargoChangable: p.isCargoChangable ?? null,

  customerId: p.customerId ?? null,
  customerName: p.customerName ?? null,
  recipientName: p.recipientName ?? null,
  email: p.email ?? null,
  phoneNumber: p.phoneNumber ?? null,

  totalPrice: money(p.totalPrice),
  currency: moneyCurrency(p.totalPrice),
  shippingTotalPrice: money(p.shippingTotalPrice),
  customsTotalPrice: money(p.customsTotalPrice),

  shippingAddress: p.shippingAddressDetail ?? null,
  shippingDistrict: p.shippingDistrict ?? null,
  shippingTown: p.shippingTown ?? null,
  shippingCity: p.shippingCity ?? null,
  shippingCountryCode: p.shippingCountryCode ?? null,

  billingAddress: p.billingAddress ?? null,
  billingDistrict: p.billingDistrict ?? null,
  billingTown: p.billingTown ?? null,
  billingCity: p.billingCity ?? null,
  billingPostalCode: p.billingPostalCode ?? null,
  billingCountryCode: p.billingCountryCode ?? null,
  companyName: p.companyName ?? null,
  identityNo: p.identityNo ?? null,
  taxNumber: p.taxNumber ?? null,
  taxOffice: p.taxOffice ?? null,
});

const packageLines = (raw: unknown): Child[] => {
  if (!Array.isArray(raw)) return [];
  const out: Child[] = [];
  for (const line of raw) {
    const l = obj(line);
    const id = text(l.lineItemId);
    if (!id) continue;
    out.push({
      externalId: id,
      data: {
        lineItemId: l.lineItemId ?? null,
        orderNumber: l.orderNumber ?? null,
        orderDate: l.orderDate ?? null,
        hbSku: l.hbSku ?? null,
        merchantSku: l.merchantSku ?? null,
        listingId: l.listingId ?? null,
        productName: l.productName ?? null,
        productBarcode: l.productBarcode ?? null,
        quantity: l.quantity ?? null,
        unitPrice: money(l.price),
        totalPrice: money(l.totalPrice),
        currency: moneyCurrency(l.totalPrice) ?? moneyCurrency(l.price),
        merchantUnitPrice: money(l.merchantUnitPrice),
        merchantTotalPrice: money(l.merchantTotalPrice),
        commission: money(l.commission),
        commissionRate: l.commissionRate ?? null,
        totalHBDiscount: money(l.totalHBDiscount),
        totalMerchantDiscount: money(l.totalMerchantDiscount),
        vat: l.vat ?? null,
        vatRate: l.vatRate ?? null,
        deliveryType: l.deliveryType ?? null,
        creationReason: l.creationReason ?? null,
        weight: l.weight ?? null,
      },
    });
  }
  return out;
};

/** One order, taken from any of its lines. */
const orderData = (l: Record<string, unknown>): Record<string, unknown> => {
  const ship = obj(l.shippingAddress);
  const invoice = obj(l.invoice);
  const invoiceAddress = obj(invoice.address);
  const cargo = obj(l.cargoCompanyModel);
  return {
    orderNumber: l.orderNumber ?? null,
    orderId: l.orderId ?? null,
    orderDate: l.orderDate ?? null,
    dueDate: l.dueDate ?? null,
    lastStatusUpdateDate: l.lastStatusUpdateDate ?? null,
    status: l.status ?? null,
    packageNumber: l.packageNumber ?? null,

    customerId: l.customerId ?? null,
    customerName: l.customerName ?? null,
    deliveryType: l.deliveryType ?? null,
    dispatchTime: l.dispatchTime ?? null,
    pickUpTime: l.pickUpTime ?? null,

    cargoCompany: cargo.name ?? l.cargoCompany ?? null,
    cargoCompanyShortName: cargo.shortName ?? null,
    cargoTrackingUrl: cargo.trackingUrl ?? null,

    shippingName: ship.name ?? null,
    shippingAddress: ship.address ?? null,
    shippingDistrict: ship.district ?? null,
    shippingTown: ship.town ?? null,
    shippingCity: ship.city ?? null,
    shippingPostalCode: ship.postalCode ?? null,
    shippingCountryCode: ship.countryCode ?? null,
    shippingPhone: ship.phoneNumber ?? null,
    shippingEmail: ship.email ?? null,

    invoiceName: invoiceAddress.name ?? null,
    invoiceAddress: invoiceAddress.address ?? null,
    invoiceCity: invoiceAddress.city ?? null,
    invoiceTown: invoiceAddress.town ?? null,
    invoiceCountryCode: invoiceAddress.countryCode ?? null,
    turkishIdentityNumber: invoice.turkishIdentityNumber ?? null,
    taxNumber: invoice.taxNumber ?? null,
    taxOffice: invoice.taxOffice ?? null,
  };
};

const orderLine = (l: Record<string, unknown>): Record<string, unknown> => ({
  lineItemId: l.id ?? null,
  sku: l.sku ?? null,
  merchantSku: l.merchantSKU ?? null,
  name: l.name ?? null,
  barcode: l.barcode ?? l.productBarcode ?? null,
  quantity: l.quantity ?? null,
  status: l.status ?? null,
  unitPrice: money(l.unitPrice),
  totalPrice: money(l.totalPrice),
  currency: moneyCurrency(l.totalPrice) ?? moneyCurrency(l.unitPrice),
  commission: money(l.commission),
  commissionRate: l.commissionRate ?? null,
  vat: l.vat ?? null,
  vatRate: l.vatRate ?? null,
  canCreatePackage: l.canCreatePackage ?? null,
  isCancellable: l.isCancellable ?? null,
  sapNumber: l.sapNumber ?? null,
  creationReason: l.creationReason ?? null,
  productImageUrlFormat: l.productImageUrlFormat ?? null,
});

/**
 * A cancelled line carries far less than an open one — no address, no customer,
 * no prices. Mapping the missing fields as null anyway would write emptiness
 * over an order the `orders` feed had already filled in, so the cancelled
 * record deliberately holds only what the feed actually says.
 */
const cancelledData = (l: Record<string, unknown>): Record<string, unknown> => ({
  orderNumber: l.orderNumber ?? null,
  status: "Cancelled",
  cancelDate: l.cancelDate ?? null,
  cancelledBy: l.cancelledBy ?? null,
  cancelReasonCode: l.cancelReasonCode ?? null,
});

const cancelledLine = (l: Record<string, unknown>): Record<string, unknown> => ({
  lineItemId: l.lineItemId ?? null,
  sku: l.sku ?? null,
  merchantSku: l.merchantSku ?? null,
  quantity: l.quantity ?? null,
  status: "Cancelled",
  cancelDate: l.cancelDate ?? null,
  cancelledBy: l.cancelledBy ?? null,
  cancelReasonCode: l.cancelReasonCode ?? null,
});

// ── Stock and price ──────────────────────────────────────────────────────────

interface Identified {
  hepsiburadaSku: string | null;
  merchantSku: string | null;
  availableStock: number | null;
  maximumPurchasableQuantity: number | null;
  price: number | null;
}

/**
 * One mapped row, or `null` when it addresses no listing.
 *
 * Either identifier will do — Hepsiburada accepts the HBSKU, the merchant's own
 * SKU, or both — but a row with neither points at nothing, and sending it would
 * report a clean run for a listing that was never touched.
 */
const itemFor = (row: DestinationRow): Identified | null => {
  const hepsiburadaSku = text(row.hepsiburadaSku);
  const merchantSku = text(row.merchantSku);
  if (!hepsiburadaSku && !merchantSku) return null;
  return {
    hepsiburadaSku,
    merchantSku,
    // Whole units, and a negative stock is a mapping error rather than an
    // oversell to publish.
    availableStock: clampStock(num(row.availableStock)),
    maximumPurchasableQuantity: clampStock(num(row.maximumPurchasableQuantity)),
    price: num(row.price),
  };
};

const clampStock = (n: number | null): number | null => (n === null ? null : Math.max(0, Math.floor(n)));

const identity = (r: Identified): Record<string, unknown> => ({
  ...(r.hepsiburadaSku === null ? {} : { hepsiburadaSku: r.hepsiburadaSku }),
  ...(r.merchantSku === null ? {} : { merchantSku: r.merchantSku }),
});

/** A stock upload item, or `null` when this row had no stock mapped. */
const stockItem = (r: Identified): Record<string, unknown> | null => {
  if (r.availableStock === null && r.maximumPurchasableQuantity === null) return null;
  return {
    ...identity(r),
    ...(r.availableStock === null ? {} : { availableStock: r.availableStock }),
    ...(r.maximumPurchasableQuantity === null
      ? {}
      : { maximumPurchasableQuantity: r.maximumPurchasableQuantity }),
  };
};

/** A price upload item, or `null` when this row had no price mapped. */
const priceItem = (r: Identified): Record<string, unknown> | null =>
  r.price === null ? null : { ...identity(r), price: r.price };

const hasValue = (v: Record<string, unknown> | null): v is Record<string, unknown> => v !== null;

/**
 * Submit one upload and check what became of it.
 *
 * The upload answers with an id and nothing else — whether the listings took it
 * is a second call. That call fails the run only when EVERY item was refused,
 * which is a mapping error worth holding the watermark for. One archived
 * listing among two hundred does not: it would hold the watermark on its row
 * for ever and the sync would never reach the rows behind it. Same asymmetry as
 * Trendyol's, for the same reason.
 */
const upload = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  kind: "stock" | "price",
  items: Record<string, unknown>[],
): Promise<void> => {
  // Nothing to send is not an error here: a stock-and-price sync whose batch
  // happens to carry no prices still has stock to deliver, and the push as a
  // whole already refused a batch that addressed no listing at all.
  if (items.length === 0) return;

  const res = await ctx.fetch(`${conn.listing}/listings/merchantid/${conn.merchantId}/${kind}-uploads`, {
    method: "POST",
    headers: { ...conn.headers, "Content-Type": "application/json" },
    body: JSON.stringify(items),
  });
  if (!res.ok) throw await readError(res, `update ${kind}`);

  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  const id = text(body.id);
  if (!id) return;

  await sleep(UPLOAD_SETTLE_MS);
  const check = await ctx.fetch(
    `${conn.listing}/listings/merchantid/${conn.merchantId}/${kind}-uploads/id/${encodeURIComponent(id)}`,
    { headers: conn.headers },
  );
  // The upload was accepted; not being able to read its result afterwards is
  // not grounds to re-send it.
  if (!check.ok) return;

  const result = (await check.json().catch(() => ({}))) as {
    status?: unknown;
    total?: unknown;
    errors?: unknown[];
  };
  const total = num(result.total) ?? 0;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (total === 0 || errors.length < total) return;

  throw new Error(
    `Hepsiburada refused every ${kind} item in the batch — check the SKU mapping${
      errors[0] ? `: ${JSON.stringify(errors[0]).slice(0, 160)}` : ""
    }`,
  );
};

// ── Listings ─────────────────────────────────────────────────────────────────

/** One page of the category walk, and the bound on how many pages it takes.
 *  A tree that never ends is a paging bug at the far end; the alternative to a
 *  bound is a form that never finishes loading. */
const CATEGORY_PAGE = 500;
const MAX_CATEGORY_PAGES = 60;

/**
 * How many attributes get their values fetched.
 *
 * Values are a second call PER attribute here — the only marketplace of the
 * four that makes them one — so a category with thirty attributes would be
 * thirty requests before the form could be drawn. Bounded, and an attribute
 * past the bound is offered as free text rather than dropped: a required
 * attribute that vanished would make the category unlistable.
 */
const MAX_VALUE_LOOKUPS = 25;

/** Hepsiburada's numbered image fields: Image1 … Image10. */
const MAX_IMAGES = 10;

/**
 * One attribute's closed value set, or an empty list.
 *
 * A failure here is deliberately NOT fatal. The values are a convenience — the
 * attribute itself is still mappable as free text — and one attribute's lookup
 * failing must not take down a form the operator could otherwise fill in.
 */
const readAttributeValues = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  categoryId: string,
  attributeId: string,
): Promise<{ id: string; name: string }[]> => {
  const url = new URL(
    `${conn.catalog}/api/categories/${categoryId}/attribute/${encodeURIComponent(attributeId)}/values`,
  );
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "500");
  const res = await ctx.fetch(url.toString(), { headers: conn.headers }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { data?: unknown };
  const rows = asArray(obj(body.data).data ?? body.data);
  const out: { id: string; name: string }[] = [];
  for (const raw of rows) {
    const row = obj(raw);
    // The value's NAME is what the import file carries, so it is the id here
    // too — the same reason the attribute's name is its id.
    const name = text(row.name) ?? text(row.value) ?? text(raw);
    if (name && !out.some((o) => o.id === name)) out.push({ id: name, name });
  }
  return out;
};

/**
 * One row of the import file, or the reason this unit cannot become one.
 *
 * The row is a flat bag of NAMED fields — the fixed ones this provider declares
 * as columns, plus whatever the category's own attributes are called.
 */
function buildImportRow(
  product: ListingProduct,
  variant: ListingVariant,
): Record<string, unknown> | string {
  const p = product.fields;
  const v = variant.fields;

  const merchantSku = text(v.merchantSku);
  if (!merchantSku) {
    return "No merchant SKU — Hepsiburada echoes it on every status row, so a listing cannot be tracked without one";
  }

  const name = text(p.UrunAdi);
  if (!name) return "No product name";
  const description = text(p.UrunAciklamasi);
  if (!description) return "No description";
  const brand = text(p.Marka);
  if (!brand) return "No brand name";

  const price = num(v.price);
  if (price === null) return "Price is missing or not a number";
  const stock = num(v.stock);
  if (stock === null || stock < 0) return "Stock quantity is missing or not a number";

  const images = imageUrls(v.images ?? p.images);
  if (images.length === 0) return "No image URL — Hepsiburada requires at least one";

  const row: Record<string, unknown> = {
    merchantSku,
    // Derived from the product row's key — what makes several SKUs one product
    // page, and what makes a re-run land on the same page.
    VaryantGroupID: product.groupId,
    UrunAdi: name,
    UrunAciklamasi: description,
    Marka: brand,
    price,
    stock: Math.floor(stock),
  };

  const barcode = text(v.Barcode);
  if (barcode) row.Barcode = barcode;
  const vat = num(v.tax_vat_rate);
  if (vat !== null) row.tax_vat_rate = vat;
  const warranty = num(p.GarantiSuresi);
  if (warranty !== null) row.GarantiSuresi = warranty;
  const video = text(p.Video1);
  if (video) row.Video1 = video;
  images.forEach((url, i) => {
    row[`Image${i + 1}`] = url;
  });

  // The category's own attributes, keyed by NAME — which is what this
  // provider reports as an attribute's id, precisely so this line can exist.
  for (const a of variant.attributes) {
    const value = a.valueId ?? a.custom;
    if (a.attributeId && value) row[a.attributeId] = value;
  }
  return row;
}

/** Up to ten image URLs, as the numbered fields want them. */
const imageUrls = (v: unknown): string[] => {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,;|]/) : [];
  const out: string[] = [];
  for (const entry of raw) {
    const s = typeof entry === "string" ? entry : text(obj(entry).url);
    const url = s?.trim();
    if (url && /^https?:\/\//.test(url) && !out.includes(url)) out.push(url);
    if (out.length === MAX_IMAGES) break;
  }
  return out;
};

/** A category id on its way into a URL path. Digits only, because it
 *  round-trips through our database first. */
const numericId = (raw: string, what: string): string => {
  const value = raw.trim();
  if (!/^\d{1,20}$/.test(value)) throw new Error(`Hepsiburada ${what} must be numeric`);
  return value;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * Which row field carries the Hepsiburada package number.
 *
 * A function rather than a shared constant so the tasks cannot end up holding
 * one object between them — the descriptor is spread into the catalog, and a
 * single frozen instance shared across six tasks is an unpleasant surprise the
 * day anything mutates it.
 *
 * Free text, unlike the choices elsewhere in this file, because the value set
 * is the COLLECTION's fields, which a provider cannot know. The engine's own
 * check is the one that matters: a mapping onto a field the collection does not
 * have is refused when the task is invoked.
 */
function packageNumberSetting() {
  return {
    key: "packageNumberField",
    label: "Package number field",
    placeholder: "the row field holding the Hepsiburada package number, e.g. package_number",
  };
}

/**
 * The package number this task acts on, read off the row.
 *
 * It is interpolated into a URL path, so it is checked rather than trusted. The
 * numbers Hepsiburada issues are digit strings; refusing anything else names
 * the mis-pointed setting instead of producing a 404 from a URL nobody meant to
 * build.
 */
const readPackageNumber = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("packageNumberField");
  if (!field) throw new Error("Hepsiburada task needs the row field holding the package number");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no Hepsiburada package number`);
  if (!/^[A-Za-z0-9-]{1,40}$/.test(value)) {
    throw new Error(`"${field}" does not hold a Hepsiburada package number`);
  }
  return value;
};

const requiredRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
  what: string,
): string => {
  const field = ctx.setting(settingKey);
  if (!field) throw new Error(`Hepsiburada task needs the row field holding the ${what}`);
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no ${what} to send to Hepsiburada`);
  return value;
};

const optionalRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): string | null => {
  const field = ctx.setting(settingKey);
  return field ? text(ctx.row[field]) : null;
};

const optionalRowNumber = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): number | null => {
  const field = ctx.setting(settingKey);
  return field ? num(ctx.row[field]) : null;
};

const packageAction = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
  packageNumber: string,
  action: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
): Promise<void> => {
  const res = await ctx.fetch(
    `${conn.oms}/packages/merchantid/${conn.merchantId}/packagenumber/${encodeURIComponent(packageNumber)}/${action}`,
    {
      method,
      headers: { ...conn.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await readError(res, `notify "${action}"`);
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
 * Hepsiburada wraps every amount as `{ amount, currency }`. The two are
 * unpacked into separate columns rather than mapped as a blob, for the same
 * reason addresses are: a mapping targets one column.
 */
const money = (v: unknown): number | null => num(obj(v).amount);
const moneyCurrency = (v: unknown): string | null => text(obj(v).currency);

const epoch = (v: unknown): number | null => {
  const raw = text(v);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
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
    const body = JSON.parse(raw) as { message?: string; title?: string; errors?: unknown };
    detail = (body.message ?? body.title ?? detail).slice(0, 160);
  } catch {
    // Hepsiburada answers a plain string on most failures, and the truncated
    // body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      "Hepsiburada rejected the credentials — check the API username, password and merchant id, and that they match the environment",
    );
  }
  if (res.status === 404) {
    return new Error(`Hepsiburada has no such resource and could not ${what} — check the merchant id`);
  }
  return new Error(`Hepsiburada responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};
