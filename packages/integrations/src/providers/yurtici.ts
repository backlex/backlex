import { defineProvider } from "../provider";
import { findNode, soapCall, SoapFault, xmlText, type SoapValue, type XmlNode } from "../soap";

/**
 * Yurtiçi Kargo — book a consignment, ask where it is, cancel it.
 *
 * The second carrier, the first national one, and the first provider in this
 * engine to speak SOAP. Everything it needs beyond that is the same contract
 * EasyPost proved: one row in, a tracking key out, and the two reads that
 * follow. The `carrier` category was defined as that contract rather than as a
 * company precisely so this file could be a translation problem.
 *
 * Its whole surface is derived from the published WSDL at
 * `webservices.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices?wsdl`,
 * which is readable without credentials — the credentials themselves still come
 * from a branch application, but the contract does not.
 *
 * Four things shape the code below.
 *
 * **We choose the consignment's key, and Yurtiçi keys everything off it.**
 * `cargoKey` is supplied by the caller on `createShipment` and is what
 * `queryShipment` and `cancelShipment` address afterwards. It is derived from
 * the engine's idempotency key — stable for this (integration, task, row) and
 * identical across every retry — so a retried booking re-books the SAME
 * consignment instead of creating a second one. That matters more here than
 * anywhere else in this engine: there is no idempotency header to fall back on
 * and a duplicate consignment is a courier arriving twice.
 *
 * **The credentials travel in the BODY, not in a header.** Every operation's
 * first two arguments are `wsUserName` and `wsPassword`. That is Yurtiçi's
 * design; it is why they are ordinary secret config fields and why nothing here
 * builds an Authorization header.
 *
 * **A failure is a field, not a status code.** The service answers 200 with an
 * `errCode` inside. Zero is success and anything else carries `errMessage`, so
 * a provider that only checked HTTP would report every refusal as a clean
 * booking. See {@link readOutcome}.
 *
 * **The address is il / ilçe by NAME.** `cityName` and `townName` are the words,
 * not codes — which is exactly what the marketplace sources in this engine
 * already carry, so an order pulled from Trendyol or Hepsiburada can be booked
 * without a lookup table in between.
 */

/** Where the service lives, and the namespace its operations are in. */
const ENDPOINT = "https://webservices.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices";
const NAMESPACE = "http://yurticikargo.com.tr/ShippingOrderDispatcherServices";

/**
 * The languages the service will answer in. A closed set: it reaches the
 * envelope, and a value outside it is answered with a fault rather than a
 * translation.
 */
const LANGUAGES = [
  { value: "TR", label: "Türkçe" },
  { value: "EN", label: "English" },
] as const;

export const yurtici = defineProvider({
  id: "yurtici",
  label: "Yurtiçi Kargo",
  category: "carrier",
  capabilities: ["task"],
  /**
   * No published quota. Paced modestly anyway: these are per-row operations an
   * operator or a flow triggers, so nothing here walks pages, and a courier's
   * integration endpoint is not a service to hammer.
   */
  limits: { rps: 5, burst: 10 },
  configFields: [
    { key: "wsUserName", label: "Web service username", secret: true },
    { key: "wsPassword", label: "Web service password", secret: true },
    { key: "language", label: "Answer language", options: LANGUAGES },
  ],
  tasks: [
    {
      id: "book_shipment",
      label: "Book a consignment",
      /**
       * Deliberately NOT repeatable, and the reason is sharper here than
       * elsewhere: booking twice puts two consignments on a courier's manifest
       * and someone turns up to collect a parcel that does not exist. The
       * engine's task-run row is the guard, and {@link consignmentKey} is the
       * second one — a retry that gets past the first re-books the same key.
       */
      settingFields: [
        addressSetting("receiverNameField", "Receiver name field", "e.g. shipping_name"),
        addressSetting("receiverAddressField", "Receiver address field", "e.g. shipping_address"),
        addressSetting("cityField", "City (il) field", "e.g. shipping_city"),
        addressSetting("townField", "Town (ilçe) field", "e.g. shipping_town"),
        addressSetting("phoneField", "Receiver phone field", "e.g. shipping_phone"),
        addressSetting("emailField", "Receiver email field (optional)", "e.g. customer_email"),
        addressSetting("invoiceKeyField", "Invoice key field (optional)", "e.g. order_number"),
        addressSetting("descriptionField", "Description field (optional)", "e.g. order_note"),
        addressSetting("desiField", "Volumetric weight (desi) field (optional)", "e.g. parcel_desi"),
        addressSetting("weightField", "Weight (kg) field (optional)", "e.g. parcel_kg"),
        addressSetting("pieceCountField", "Piece count field (optional)", "e.g. parcel_count"),
      ],
      outputs: [
        { key: "cargoKey", label: "Consignment key" },
        { key: "invoiceKey", label: "Invoice key" },
        { key: "jobId", label: "Job id" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "bookedAt", label: "Booked at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const cargoKey = consignmentKey(ctx.idempotencyKey);

        const order: Record<string, SoapValue> = {
          cargoKey,
          invoiceKey: optionalRowValue(ctx, "invoiceKeyField"),
          receiverCustName: requiredRowValue(ctx, "receiverNameField", "receiver name"),
          receiverAddress: requiredRowValue(ctx, "receiverAddressField", "receiver address"),
          cityName: requiredRowValue(ctx, "cityField", "city"),
          townName: requiredRowValue(ctx, "townField", "town"),
          receiverPhone1: requiredRowValue(ctx, "phoneField", "receiver phone"),
          emailAddress: optionalRowValue(ctx, "emailField"),
          desi: optionalRowNumber(ctx, "desiField"),
          kg: optionalRowNumber(ctx, "weightField"),
          // A consignment is one piece unless the row says otherwise. Sending
          // nothing would leave the courier to guess, and every parcel this
          // engine books is at least one.
          cargoCount: Math.max(1, Math.floor(optionalRowNumber(ctx, "pieceCountField") ?? 1)),
          description: optionalRowValue(ctx, "descriptionField"),
        };

        const body = await call(ctx, conn, "createShipment", {
          ...conn.credentials,
          ShippingOrderVO: order,
        });

        const detail = findNode(body, "shippingOrderDetailVO");
        readOutcome(detail, "book the consignment");

        return {
          outputs: {
            // Echoed from the answer where there is one, because the service is
            // the authority on what it stored — falling back to what we sent
            // keeps the row addressable either way.
            cargoKey: xmlText(detail, "cargoKey") ?? cargoKey,
            invoiceKey: xmlText(detail, "invoiceKey"),
            jobId: xmlText(findNode(body, "ShippingOrderResultVO"), "jobId"),
            shipmentStatus: "booked",
            bookedAt: Date.now(),
          },
        };
      },
    },
    {
      id: "refresh_tracking",
      label: "Refresh tracking",
      /**
       * The read half, and the one task here that is genuinely repeatable.
       *
       * Where a parcel is has no side effect at Yurtiçi and its whole value is
       * that the answer moves. Under the once-only guard the row would keep
       * whatever the first poll said. Put it on a cron flow over the
       * consignments that are not delivered yet.
       */
      repeatable: true,
      settingFields: [
        addressSetting("cargoKeyField", "Consignment key field", "the row field book_shipment wrote, e.g. carrier_shipment_id"),
        {
          key: "keyType",
          label: "Key type",
          placeholder: "which key the field holds, per your Yurtiçi contract — 0 unless told otherwise",
        },
      ],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "statusDetail", label: "Status detail" },
        { key: "waybillNo", label: "Waybill number" },
        { key: "docId", label: "Document id" },
        { key: "trackingUrl", label: "Tracking URL" },
        { key: "deliveredAt", label: "Delivered at" },
        { key: "receivedBy", label: "Received by" },
        { key: "totalDesi", label: "Total desi" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const key = readConsignmentKey(ctx);

        const body = await call(ctx, conn, "queryShipment", {
          ...conn.credentials,
          keys: key,
          // Free text rather than a picker, unlike every other choice in this
          // file: the WSDL types it as an int and does not enumerate it, and a
          // dropdown built from a guess would be worse than a field the
          // operator fills in from their own contract documentation.
          keyType: readKeyType(ctx.setting("keyType")),
          addHistoricalData: false,
          onlyTracking: false,
        });

        const detail = findNode(body, "shippingDeliveryDetailVO");
        readOutcome(detail, "read the tracking");

        const item = findNode(detail, "shippingDeliveryItemDetailVO");
        if (!item) throw new Error(`Yurtiçi has no consignment "${key}"`);

        return {
          outputs: {
            // Yurtiçi's own vocabulary, kept rather than remapped onto some
            // invented neutral set: a second list is a second thing to keep in
            // step, and the operator's panel shows these words.
            shipmentStatus: xmlText(item, "cargoEventExplanation") ?? xmlText(item, "deliveryTypeExplanation"),
            statusDetail: xmlText(item, "cargoReasonExplanation"),
            waybillNo: xmlText(item, "waybillNo"),
            docId: xmlText(item, "docId"),
            trackingUrl: xmlText(item, "trackingUrl"),
            deliveredAt: joinDateTime(xmlText(item, "deliveryDate"), xmlText(item, "deliveryTime")),
            receivedBy: xmlText(item, "receiverInfo"),
            totalDesi: xmlText(item, "totalDesi"),
          },
        };
      },
    },
    {
      id: "cancel_shipment",
      label: "Cancel a consignment",
      /**
       * NOT repeatable. Cancelling is a request to a courier, and asking twice
       * is asking twice — the second one is answered with an error about a
       * consignment that is already gone, which reaches an operator as a failed
       * run they did not cause.
       */
      settingFields: [
        addressSetting("cargoKeyField", "Consignment key field", "the row field book_shipment wrote, e.g. carrier_shipment_id"),
      ],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "cancelledAt", label: "Cancelled at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx, "task");
        const key = readConsignmentKey(ctx);

        const body = await call(ctx, conn, "cancelShipment", {
          ...conn.credentials,
          // Plural on the wire — the operation takes a list — but a task acts
          // on one row, so it is always a list of one here.
          cargoKeys: key,
        });

        readOutcome(findNode(body, "shippingCancelDetailVO"), "cancel the consignment");
        return { outputs: { shipmentStatus: "cancelled", cancelledAt: Date.now() } };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  /** The three arguments every operation begins with. */
  credentials: Record<string, SoapValue>;
}

/**
 * Read the credentials into the arguments every operation carries.
 *
 * They reach an XML body rather than a header, so the injection risk is markup
 * rather than a newline — and {@link buildBody} escapes it. The ASCII check is
 * still worth having for the reason it is everywhere else in this engine: a
 * credential with a stray non-ASCII character is a paste that went wrong, and
 * saying so beats an authentication fault nobody can act on.
 *
 * Note `userLanguage` versus `wsLanguage`: `createShipment` and
 * `cancelShipment` name it the first way and `queryShipment` the second. Both
 * are sent, because an argument a service does not expect is ignored and a
 * missing one is a fault.
 */
const readConnection = (ctx: { str(k: string): string | null }, what: string): Connection => {
  const wsUserName = ctx.str("wsUserName");
  const wsPassword = ctx.str("wsPassword");
  if (!wsUserName || !wsPassword) throw new Error(`Yurtiçi ${what} has no web service username and password`);
  if (/[\p{Cc}]/u.test(`${wsUserName}${wsPassword}`)) {
    throw new Error("Yurtiçi username and password must not contain control characters — check for a bad paste");
  }

  const language = ctx.str("language");
  const userLanguage = (LANGUAGES as readonly { value: string }[]).some((l) => l.value === language)
    ? (language as string)
    : "TR";

  return { credentials: { wsUserName, wsPassword, userLanguage, wsLanguage: userLanguage } };
};

const call = (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  _conn: Connection,
  operation: string,
  body: Record<string, SoapValue>,
): Promise<XmlNode> =>
  soapCall(ctx.fetch, ENDPOINT, { namespace: NAMESPACE, operation, body }).catch((e: unknown) => {
    // A fault is the service saying no, and its own words are far more useful
    // than anything this side could infer. Re-thrown named so a run's error
    // reads as the courier's refusal rather than as a transport failure.
    if (e instanceof SoapFault) throw new Error(`Yurtiçi refused the request: ${e.message.slice(0, 160)}`);
    throw e;
  });

/**
 * The consignment key for this booking.
 *
 * Derived from the engine's idempotency key, which is stable for this
 * (integration, task, row) and identical across every retry — so a retry that
 * gets past the once-only guard re-books the SAME consignment rather than
 * putting a second one on a courier's manifest. There is no idempotency header
 * here to fall back on, which is what makes this the guard that matters.
 *
 * Reduced to characters a key field will take, and capped.
 */
const consignmentKey = (idempotencyKey: string): string =>
  idempotencyKey.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "backlex";

/**
 * Which row field carries the consignment key, and the key it holds.
 *
 * A function rather than a shared constant so the tasks cannot end up holding
 * one object between them — the descriptor is spread into the catalog, and a
 * frozen instance shared across three tasks is an unpleasant surprise the day
 * anything mutates it.
 */
function addressSetting(key: string, label: string, placeholder: string) {
  return { key, label, placeholder };
}

const readConsignmentKey = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("cargoKeyField");
  if (!field) throw new Error("Yurtiçi task needs the row field holding the consignment key");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no Yurtiçi consignment key`);
  return value;
};

const readKeyType = (raw: string | null): number => {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : 0;
};

/**
 * Turn the service's own outcome fields into a thrown error, or nothing.
 *
 * This is the whole reason a provider cannot just check the HTTP status here:
 * Yurtiçi answers 200 with an `errCode` inside, so a booking that was refused
 * looks exactly like one that succeeded until this reads the field. Zero is
 * success; anything else carries `errMessage`, and an answer with no detail
 * element at all is a refusal too — it means the operation returned nothing to
 * be the outcome of.
 */
const readOutcome = (detail: XmlNode | null, what: string): void => {
  if (!detail) throw new Error(`Yurtiçi returned no result and could not ${what}`);
  const code = xmlText(detail, "errCode");
  if (code === null || code === "0") return;
  const message = xmlText(detail, "errMessage") ?? xmlText(detail, "operationMessage");
  throw new Error(`Yurtiçi could not ${what} (${code})${message ? `: ${message.slice(0, 160)}` : ""}`);
};

// ── Rows ─────────────────────────────────────────────────────────────────────

const requiredRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
  what: string,
): string => {
  const field = ctx.setting(settingKey);
  if (!field) throw new Error(`Yurtiçi booking needs the row field holding the ${what}`);
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no ${what} to send to Yurtiçi`);
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
 * Yurtiçi splits a delivery moment across two fields. Joined into one value so
 * a mapping onto a single column reads as a moment rather than as a date with
 * the time lost.
 */
const joinDateTime = (date: string | null, time: string | null): string | null => {
  if (!date) return null;
  return time ? `${date} ${time}` : date;
};

/** Re-exported so the tests and the docs read one source for the wire address. */
export const YURTICI_ENDPOINT = ENDPOINT;
export const YURTICI_NAMESPACE = NAMESPACE;
