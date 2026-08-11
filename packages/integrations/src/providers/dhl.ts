import { defineProvider } from "../provider";

/**
 * DHL — where a parcel is, across every DHL division that publishes tracking.
 *
 * The fourth carrier, and the first one that ships as HALF a carrier on
 * purpose. It is worth reading why, because the shape is going to recur.
 *
 * ## Why this file has one task and not three
 *
 * A carrier's three tasks — book, track, cancel — are independent contracts,
 * and DHL publishes them at very different heights. **Tracking is a public,
 * self-serve, documented API**: an operator signs up on `developer.dhl.com`,
 * gets a key, and this task works. **Booking is not.** For Türkiye it still
 * lives behind `apizone.mngkargo.com.tr`, an IBM API Connect portal whose
 * request bodies are inside a spec ZIP you can only download once you have an
 * account, and there is no `apizone.dhlecommerce.com.tr` to replace it. Writing
 * `book_shipment` from a guess at those bodies would produce a task that fails
 * at a courier rather than at a form.
 *
 * So this ships tracking now and gains booking when somebody has the portal
 * account. Aras already ships the mirror image of this — book and cancel, no
 * tracking, because its tracking operations return an untyped DataSet — so
 * "some of a carrier's tasks" is an established answer here rather than a
 * compromise invented for DHL.
 *
 * ## Why it is `dhl` and not `mng-kargo`
 *
 * DHL Group completed its acquisition of MNG Kargo in October 2023, and on
 * 22 May 2025 the Turkish brand became **DHL eCommerce**. A seller's panel,
 * the signage and the tracking pages all say DHL now, so a card reading only
 * "MNG Kargo" would look like an integration nobody had touched in two years.
 *
 * But the API this file calls is not the Turkish one — it is DHL's **Shipment
 * Tracking – Unified** API, which fronts fifteen-odd DHL divisions behind one
 * endpoint and one key. Ex-MNG parcels became reachable through it on
 * 21 July 2026 when `service=ecommerce-tr` was added. Narrowing the provider to
 * Türkiye would throw that away for nothing: the same key already tracks DHL
 * Express, Paket in Germany and Parcel in the Netherlands, and the difference
 * is one value in one dropdown. {@link SERVICES} is that dropdown, and its
 * Turkish entry names MNG so the operator looking for it finds it.
 *
 * ## Three things the code depends on
 *
 * **The service is chosen per invocation, and it is required.** DHL will guess
 * when it is not sent, and a guess spanning fifteen divisions can return a
 * shipment belonging to somebody else who happens to share the number — which
 * is what `possibleAdditionalShipmentsUrl` in the response exists to admit. A
 * task that wrote another seller's delivery date onto a row would be worse than
 * one that refuses to run, so {@link readService} refuses.
 *
 * **The answer is a list, and only one entry is the row's.** `shipments` can
 * carry more than one; {@link pickShipment} takes the one whose id is the
 * number that was asked for and only falls back to the first when DHL echoed
 * nothing recognisable.
 *
 * **Nothing here depends on the order of `events`.** The live API returns them
 * newest-first, which is the opposite of every other carrier in this engine —
 * and it is not in the published contract either way. DHL hands back a separate
 * `status` object that IS the current state, so this file reads that and treats
 * `events` as an unordered bag it only ever searches by status code.
 *
 * ## Pacing, and what the bucket does not protect
 *
 * The free tier is **250 calls a day at one per five seconds**. The bucket
 * below enforces the pace, not the quota — five seconds apart is 17,000 calls a
 * day, so a large enough fleet of parcels will exhaust the daily allowance long
 * before the pacing notices. The 429 is the real guarantee, and the engine
 * classifies it as busy rather than broken so a poll that runs out at 4pm
 * resumes instead of tripping the breaker.
 *
 * There is a push (webhook) version of this API, and it supports `ecommerce-tr`
 * — but access is granted through a form on the developer portal rather than by
 * a subscribe endpoint, so there is nothing for {@link IntegrationWebhook} to
 * register. Polling on a cron over the parcels that are not delivered yet is
 * the whole story here today.
 */

/** Where the unified tracking API lives. One host for every division. */
const BASE = "https://api-eu.dhl.com/track/shipments";

/**
 * The DHL divisions this API will answer for.
 *
 * A closed set taken from the published parameter reference, so a typo fails at
 * the form rather than at a run with a shipment nobody recognises. `post-de` is
 * deliberately absent: it is deprecated and its queries are rerouted to `svb`,
 * which is in the list under its own name.
 */
const SERVICES = [
  { value: "ecommerce-tr", label: "DHL eCommerce Türkiye (MNG Kargo)" },
  { value: "express", label: "DHL Express" },
  { value: "ecommerce", label: "DHL eCommerce" },
  { value: "ecommerce-europe", label: "DHL eCommerce Europe" },
  { value: "ecommerce-iberia", label: "DHL eCommerce Iberia" },
  { value: "parcel-de", label: "DHL Paket (Germany)" },
  { value: "parcel-nl", label: "DHL Parcel (Netherlands)" },
  { value: "parcel-uk", label: "DHL Parcel (United Kingdom)" },
  { value: "parcel-pl", label: "DHL Parcel (Poland)" },
  { value: "svb", label: "Deutsche Post mail (replaces post-de)" },
  { value: "sameday", label: "DHL Same Day" },
  { value: "freight", label: "DHL Freight" },
  { value: "global-forwarding", label: "DHL Global Forwarding" },
  { value: "ppl", label: "PPL (Czechia)" },
  { value: "blue-dart", label: "Blue Dart (India)" },
  { value: "poste-italiane", label: "Poste Italiane" },
] as const;

/**
 * The coarse state DHL puts every division's vocabulary into.
 *
 * Five values, and they are the only part of a status that is comparable across
 * divisions — the `status` string beside them is the division's own wording
 * ("DELIVERED - PARCEL LOCKER", "ARRIVAL AT POST OFFICE") and is written to its
 * own column rather than squeezed into this one. Anything outside the set is
 * written as `unknown` for the reason every enum in this engine is checked: the
 * column is a select, and a value outside its choices renders as a blank chip
 * with nothing to say why.
 */
const STATUS_CODES = ["pre-transit", "transit", "delivered", "failure", "unknown"] as const;

export const dhl = defineProvider({
  id: "dhl",
  label: "DHL",
  category: "carrier",
  capabilities: ["task"],
  /**
   * The published free tier: one call per five seconds. Expressed as a
   * fractional rps with a burst of one, so every call waits its full interval
   * rather than four of them going at once and the fifth being told off.
   *
   * Keyed per connected account by the engine's wrapper, which is right here:
   * the quota belongs to the API key, so two workspaces do not pace each other.
   */
  limits: { rps: 0.2, burst: 1 },
  configFields: [
    { key: "apiKey", label: "API key", secret: true, placeholder: "the consumer key from developer.dhl.com" },
    {
      key: "language",
      /**
       * Free text rather than a picker, unlike the service beside it. DHL
       * documents this as an ISO 639-1 code and does not publish which ones a
       * given division answers in, so a dropdown here would be a list of
       * guesses — and a guess that renders as a closed choice reads as a
       * promise. The service list above is enumerated in the reference; this is
       * not.
       */
      label: "Response language (optional)",
      placeholder: "ISO 639-1 code, e.g. tr — leave empty for DHL's default",
    },
  ],
  tasks: [
    {
      id: "refresh_tracking",
      label: "Refresh tracking",
      /**
       * Repeatable, and this provider is the clearest case for it in the engine:
       * reading where a parcel is has no side effect at DHL, and the whole value
       * of the answer is that it moves. Under the once-only guard the row would
       * keep whatever the first poll said, which for a parcel booked this
       * morning is `pre-transit` forever.
       *
       * Put it on a cron flow over the consignments that are not `delivered`
       * yet. That filter is not tidiness — it is what keeps a 250-a-day
       * allowance spent on parcels still in motion.
       */
      repeatable: true,
      settingFields: [
        {
          key: "trackingNumberField",
          label: "Tracking number field",
          placeholder: "the row field holding DHL's number, e.g. carrier_shipment_id",
        },
        {
          key: "service",
          label: "DHL service",
          placeholder: "which DHL division carries the parcel",
          options: SERVICES,
        },
        {
          key: "recipientPostalCodeField",
          /**
           * Optional, and it buys more than it looks like: DHL withholds some
           * detail — the weight among it — until the caller proves it knows the
           * destination postcode. Sent when the row has one, left out when it
           * does not, because an empty value is answered with a 400 rather than
           * being ignored.
           */
          label: "Recipient postcode field (optional)",
          placeholder: "unlocks detail DHL withholds otherwise, e.g. shipping_postcode",
        },
      ],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "statusDescription", label: "Status detail" },
        { key: "statusAt", label: "Status reported at" },
        { key: "statusLocation", label: "Last known location" },
        { key: "trackingNumber", label: "Tracking number" },
        { key: "trackingUrl", label: "Tracking URL" },
        { key: "estimatedDeliveryAt", label: "Estimated delivery" },
        { key: "deliveredAt", label: "Delivered at" },
        { key: "carrierService", label: "DHL service" },
        { key: "productName", label: "Product" },
      ],
      async run(ctx) {
        const apiKey = readApiKey(ctx);
        const trackingNumber = readTrackingNumber(ctx);

        const url = new URL(BASE);
        url.searchParams.set("trackingNumber", trackingNumber);
        url.searchParams.set("service", readService(ctx));
        const language = ctx.str("language");
        if (language) url.searchParams.set("language", language);
        const postcode = optionalRowValue(ctx, "recipientPostalCodeField");
        if (postcode) url.searchParams.set("recipientPostalCode", postcode);

        const res = await ctx.fetch(url.toString(), {
          headers: { "DHL-API-Key": apiKey, Accept: "application/json" },
        });
        if (!res.ok) throw await readError(res, trackingNumber);

        const body = (await res.json()) as { shipments?: DhlShipment[] };
        const shipment = pickShipment(body.shipments, trackingNumber);
        // A 200 carrying no shipment is the same answer as a 404 and is worth
        // saying the same way: DHL has never heard of this number, which is
        // nearly always the wrong field mapped or the wrong division chosen.
        if (!shipment) throw new Error(`DHL has no shipment "${trackingNumber}" — check the number and the DHL service`);

        const status = shipment.status;
        return {
          outputs: {
            shipmentStatus: statusCode(status?.statusCode),
            // The division's own words, kept rather than remapped: they are what
            // an operator recognises from the tracking page, and a second
            // vocabulary would be a second thing to keep in step.
            statusDescription: text(status?.description) ?? text(status?.status),
            statusAt: epoch(status?.timestamp),
            statusLocation: text(status?.location?.address?.addressLocality),
            trackingNumber: text(shipment.id) ?? trackingNumber,
            trackingUrl: text(shipment.serviceUrl),
            estimatedDeliveryAt: epoch(shipment.estimatedTimeOfDelivery),
            deliveredAt: deliveredAt(shipment),
            // Which division actually answered. Worth a column: it is how an
            // operator finds out the parcel they thought was ex-MNG was handed
            // to DHL Express somewhere along the way.
            carrierService: text(shipment.service),
            productName: text(shipment.details?.product?.productName),
          },
        };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

/**
 * Read the API key.
 *
 * It reaches a header, so a newline in it would be a request-splitting
 * primitive rather than a bad password — which is why the check is for control
 * characters rather than for shape. A key with one in it is a paste that went
 * wrong, and saying so beats a 401 nobody can act on.
 */
const readApiKey = (ctx: { str(k: string): string | null }): string => {
  const apiKey = ctx.str("apiKey");
  if (!apiKey) throw new Error("DHL task has no API key");
  if (/[^\x21-\x7e]/.test(apiKey)) {
    throw new Error("DHL API key must be printable ASCII — check for a bad paste");
  }
  return apiKey;
};

/**
 * Which DHL division to ask, refusing when nobody chose.
 *
 * The parameter is optional at DHL and required here, which is a deliberate
 * narrowing. Left out, DHL guesses across every division it fronts, and a
 * tracking number is only unique WITHIN one of them — so the guess can return a
 * real shipment that belongs to somebody else. Writing that shipment's delivery
 * date onto this row is a failure nobody would ever look for, and refusing to
 * run is the cheaper answer by a wide margin.
 */
const readService = (ctx: { setting(k: string): string | null }): string => {
  const service = ctx.setting("service");
  if (!service) throw new Error("DHL task needs the DHL service the parcel moves with");
  if (!(SERVICES as readonly { value: string }[]).some((s) => s.value === service)) {
    throw new Error(`"${service}" is not a DHL service this API tracks`);
  }
  return service;
};

// ── Rows ─────────────────────────────────────────────────────────────────────

const readTrackingNumber = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("trackingNumberField");
  if (!field) throw new Error("DHL task needs the row field holding the tracking number");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no DHL tracking number`);
  return value;
};

const optionalRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): string | null => {
  const field = ctx.setting(settingKey);
  return field ? text(ctx.row[field]) : null;
};

// ── The answer ───────────────────────────────────────────────────────────────

interface DhlEvent {
  timestamp?: unknown;
  statusCode?: unknown;
  status?: unknown;
  description?: unknown;
  location?: { address?: { addressLocality?: unknown } };
}

interface DhlShipment {
  id?: unknown;
  service?: unknown;
  status?: DhlEvent;
  events?: DhlEvent[];
  estimatedTimeOfDelivery?: unknown;
  serviceUrl?: unknown;
  details?: { product?: { productName?: unknown } };
}

/**
 * The one shipment in the answer that belongs to this row.
 *
 * `shipments` is a list because a tracking number can match more than one
 * record — DHL says as much by handing back a `possibleAdditionalShipmentsUrl`
 * alongside it. A task acts on ONE row, so it must choose, and the only
 * defensible choice is the entry whose id is the number that was asked for.
 *
 * The fallback to the first entry is for the divisions that echo a normalised
 * id (leading zeros trimmed, a prefix added) rather than the caller's string:
 * with one entry there is nothing to confuse it with, and with several and no
 * match there is nothing better to go on than DHL's own ordering.
 */
const pickShipment = (shipments: DhlShipment[] | undefined, trackingNumber: string): DhlShipment | null => {
  const list = Array.isArray(shipments) ? shipments.filter((s) => s && typeof s === "object") : [];
  return list.find((s) => text(s.id) === trackingNumber) ?? list[0] ?? null;
};

/**
 * When the parcel was delivered, or nothing.
 *
 * Read from `status` first, because that object IS the current state and is the
 * only thing here the published contract orders. `events` is searched only when
 * the shipment has moved PAST delivery — returned to sender, say — and it is
 * searched rather than indexed for the reason at the top of this file: the live
 * API answers newest-first, the docs do not promise it, and a provider that
 * took `events[0]` would be right by luck until the day it was not.
 */
const deliveredAt = (shipment: DhlShipment): number | null => {
  if (statusCode(shipment.status?.statusCode) === "delivered") return epoch(shipment.status?.timestamp);
  const events = Array.isArray(shipment.events) ? shipment.events : [];
  const delivered = events.find((e) => e && statusCode(e.statusCode) === "delivered");
  return delivered ? epoch(delivered.timestamp) : null;
};

/** One of DHL's five coarse codes, or `unknown`. */
const statusCode = (v: unknown): string => {
  const s = text(v);
  return s && (STATUS_CODES as readonly string[]).includes(s) ? s : "unknown";
};

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/**
 * A DHL timestamp as epoch ms — the shape every timestamp column takes.
 *
 * Worth knowing while reading this: some divisions send an offset
 * (`2026-06-24T13:04:00+02:00`) and others send none (`2023-05-08T10:37:00`),
 * so a bare one is parsed as local time by `Date.parse`. That is DHL's contract
 * rather than something to correct here — inventing a zone for a division that
 * did not name one would move a delivery across midnight for readers in the
 * wrong half of the world.
 */
const epoch = (v: unknown): number | null => {
  const s = text(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Turn a failed call into something an operator can act on.
 *
 * DHL answers `application/problem+json` (RFC 7807), so the useful sentence is
 * in `detail` with `title` behind it. Verified against the live API: a bad or
 * absent key is `{"status":401,"title":"Unauthorized","detail":"Access to the
 * resource is not allowed."}`, which on its own would send an operator looking
 * for a permission problem — hence the 401 branch says what to check.
 *
 * 429 is deliberately absent: the engine's fetch wrapper classifies it before a
 * provider sees the response, so a branch here would be unreachable and would
 * read as though it still decided something. It matters more for this provider
 * than for most — a 250-a-day allowance runs out mid-afternoon — and being busy
 * rather than broken is exactly what keeps the poll alive until tomorrow.
 */
const readError = async (res: Response, trackingNumber: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { title?: unknown; detail?: unknown };
    detail = (text(body.detail) ?? text(body.title) ?? detail).slice(0, 200);
  } catch {
    // Not JSON — a gateway in front of the API answers HTML on some failures,
    // and the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error("DHL rejected the API key — check it, and that the key's app is subscribed to Shipment Tracking");
  }
  if (res.status === 404) {
    return new Error(`DHL has no shipment "${trackingNumber}" — check the number and the DHL service`);
  }
  return new Error(`DHL responded ${res.status} and could not read the tracking${detail ? `: ${detail}` : ""}`);
};

/** Re-exported so the tests and the docs read one source for the wire address. */
export const DHL_TRACKING_URL = BASE;
