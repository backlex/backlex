import { defineProvider } from "../provider";
import { findNode, nodeList, soapCall, SoapFault, xmlText, type SoapValue, type XmlNode } from "../soap";

/**
 * Aras Kargo — book a consignment and cancel it.
 *
 * The third carrier and the second over SOAP, which is the point of it: the
 * helper written for Yurtiçi carried straight across, and this file is the
 * translation problem the `carrier` category was defined to make it.
 *
 * Its surface comes from the published WSDL at
 * `customerws.araskargo.com.tr/arascargoservice.asmx?wsdl`, readable without
 * credentials. The credentials themselves come from a branch application; the
 * contract does not.
 *
 * ## Why there is no tracking task
 *
 * Aras has several operations that would answer "where is this consignment" —
 * `GetCargoTransaction`, `GetCargoInfo`, `GetSortedCargoInfo` — and every one of
 * them returns an **untyped .NET DataSet**: the WSDL declares the response as
 * `<s:any>` carrying a diffgram, so the column names inside are not part of the
 * published contract at all. A task must declare the fields it writes back, and
 * declaring a set of names guessed from the shape of somebody else's DataSet is
 * how a row ends up permanently empty while the run reports success.
 *
 * Those names ARE in the integration document Aras hands over with the
 * credentials. When somebody has that document in front of them, the task is a
 * short addition to this file — the helper already reads an arbitrary tree by
 * name. Until then, the two operations below are fully typed and correct, and
 * the third one is honest about not existing.
 *
 * ## Three things the code depends on
 *
 * **We choose the consignment's key.** `IntegrationCode` is supplied by the
 * caller and is what `CancelDispatch` addresses afterwards. It is derived from
 * the engine's idempotency key — stable for this (integration, task, row) and
 * identical across every retry — so a retried booking re-books the SAME
 * consignment rather than putting a second one on a courier's manifest.
 *
 * **The credentials are sent twice, and spelled two ways.** `SetOrder` takes
 * `userName`/`password` as arguments AND repeats them inside every `Order`;
 * `GetCargoTransaction` spells the first one `username`, lower case. That is
 * Aras's WSDL, not a transcription error, and it is why {@link credentialsFor}
 * exists instead of one shared object.
 *
 * **A refusal is a field, not a status code.** The service answers 200 with a
 * `ResultCode` inside, so a provider that only checked HTTP would report every
 * refusal as a clean booking. Zero is success — see {@link readResult}.
 */

/** Where the service lives, and the namespace ASP.NET generated for it. */
const ENDPOINT = "https://customerws.araskargo.com.tr/arascargoservice.asmx";
const NAMESPACE = "http://tempuri.org/";

export const aras = defineProvider({
  id: "aras",
  label: "Aras Kargo",
  category: "carrier",
  capabilities: ["task"],
  /**
   * No published quota. Paced modestly anyway: these are per-row operations an
   * operator or a flow triggers, so nothing here walks pages, and a courier's
   * integration endpoint is not a service to hammer.
   */
  limits: { rps: 5, burst: 10 },
  configFields: [
    { key: "userName", label: "Web service username", secret: true },
    { key: "password", label: "Web service password", secret: true },
  ],
  tasks: [
    {
      id: "book_shipment",
      label: "Book a consignment",
      /**
       * Deliberately NOT repeatable: booking twice puts two consignments on a
       * courier's manifest and someone turns up to collect a parcel that does
       * not exist. The engine's task-run row is the first guard and
       * {@link consignmentKey} is the second — a retry that gets past the first
       * re-books the same integration code.
       */
      settingFields: [
        rowField("receiverNameField", "Receiver name field", "e.g. shipping_name"),
        rowField("receiverAddressField", "Receiver address field", "e.g. shipping_address"),
        rowField("cityField", "City (il) field", "e.g. shipping_city"),
        rowField("townField", "Town (ilçe) field", "e.g. shipping_town"),
        rowField("quarterField", "Quarter (mahalle) field (optional)", "e.g. shipping_neighbourhood"),
        rowField("phoneField", "Receiver phone field", "e.g. shipping_phone"),
        rowField("invoiceNumberField", "Invoice number field (optional)", "e.g. order_number"),
        rowField("descriptionField", "Description field (optional)", "e.g. order_note"),
        rowField("volumetricWeightField", "Volumetric weight (desi) field (optional)", "e.g. parcel_desi"),
        rowField("weightField", "Weight (kg) field (optional)", "e.g. parcel_kg"),
        rowField("pieceCountField", "Piece count field (optional)", "e.g. parcel_count"),
        rowField("codAmountField", "Cash-on-delivery amount field (optional)", "e.g. cod_amount"),
      ],
      outputs: [
        { key: "integrationCode", label: "Consignment key" },
        { key: "invoiceKey", label: "Invoice key" },
        { key: "resultMessage", label: "Carrier message" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "bookedAt", label: "Booked at" },
      ],
      async run(ctx) {
        const creds = credentialsFor(ctx, "task");
        const integrationCode = consignmentKey(ctx.idempotencyKey);
        const codAmount = optionalRowNumber(ctx, "codAmountField");

        const order: Record<string, SoapValue> = {
          // Aras wants them inside the order too, not only as arguments.
          UserName: creds.userName,
          Password: creds.password,
          IntegrationCode: integrationCode,
          InvoiceNumber: optionalRowValue(ctx, "invoiceNumberField"),
          ReceiverName: requiredRowValue(ctx, "receiverNameField", "receiver name"),
          ReceiverAddress: requiredRowValue(ctx, "receiverAddressField", "receiver address"),
          ReceiverPhone1: requiredRowValue(ctx, "phoneField", "receiver phone"),
          ReceiverCityName: requiredRowValue(ctx, "cityField", "city"),
          ReceiverTownName: requiredRowValue(ctx, "townField", "town"),
          // The mahalle. Carried because a Turkish address is il / ilçe /
          // mahalle and a courier wants all three — and because the marketplace
          // sources in this engine already pull it, so dropping it here would
          // mean the address arrived complete and left incomplete.
          ReceiverQuarterName: optionalRowValue(ctx, "quarterField"),
          VolumetricWeight: optionalRowText(ctx, "volumetricWeightField"),
          Weight: optionalRowText(ctx, "weightField"),
          // A consignment is one piece unless the row says otherwise. Leaving
          // it out would make the courier guess, and every parcel this engine
          // books is at least one.
          PieceCount: String(Math.max(1, Math.floor(optionalRowNumber(ctx, "pieceCountField") ?? 1))),
          Description: optionalRowValue(ctx, "descriptionField"),
          // The flag and the amount go together or neither goes: a COD amount
          // with no flag is silently not collected, which is the one failure
          // mode here that costs the seller money.
          ...(codAmount === null || codAmount <= 0 ? {} : { IsCod: "1", CodAmount: String(codAmount) }),
        };

        const body = await call(ctx, "SetOrder", {
          orderInfo: { Order: order },
          userName: creds.userName,
          password: creds.password,
        });

        // SetOrder takes a list and answers with one result per order. A task
        // acts on one row, so there is exactly one — but it is read as a list
        // because that is what the schema says and a single-element list must
        // not read differently from a longer one.
        const results = nodeList(findNode(body, "SetOrderResult"), "OrderResultInfo");
        const first = results[0] ?? findNode(body, "OrderResultInfo");
        readResult(first, "book the consignment");

        return {
          outputs: {
            integrationCode,
            invoiceKey: xmlText(first, "InvoiceKey"),
            resultMessage: xmlText(first, "ResultMessage"),
            shipmentStatus: "booked",
            bookedAt: Date.now(),
          },
        };
      },
    },
    {
      id: "cancel_shipment",
      label: "Cancel a consignment",
      /**
       * NOT repeatable. Cancelling is a request to a courier, and asking twice
       * is asking twice — the second is answered with an error about a
       * consignment that is already gone, which reaches an operator as a failed
       * run they did not cause.
       */
      settingFields: [
        rowField(
          "integrationCodeField",
          "Consignment key field",
          "the row field book_shipment wrote, e.g. carrier_shipment_id",
        ),
      ],
      outputs: [
        { key: "cargoKey", label: "Carrier's own key" },
        { key: "resultMessage", label: "Carrier message" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "cancelledAt", label: "Cancelled at" },
      ],
      async run(ctx) {
        const creds = credentialsFor(ctx, "task");
        const integrationCode = readIntegrationCode(ctx);

        const body = await call(ctx, "CancelDispatch", {
          userName: creds.userName,
          password: creds.password,
          integrationCode,
        });

        const result = findNode(body, "CancelDispatchResult");
        readResult(result, "cancel the consignment");

        return {
          outputs: {
            cargoKey: xmlText(result, "CargoKey"),
            resultMessage: xmlText(result, "ResultMessage"),
            shipmentStatus: "cancelled",
            cancelledAt: Date.now(),
          },
        };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

/**
 * Read the credentials.
 *
 * They reach an XML body rather than a header, so the risk is markup rather
 * than a newline — and the envelope builder escapes it. The control-character
 * check is still worth having for the reason it is everywhere else in this
 * engine: a credential with one in it is a paste that went wrong, and saying so
 * beats an authentication fault nobody can act on.
 *
 * Returned as a pair rather than as a ready-made argument object because Aras
 * spells the username two different ways across its own operations —
 * `userName` on `SetOrder` and `CancelDispatch`, `username` on the query
 * operations — so each call site names them itself.
 */
const credentialsFor = (
  ctx: { str(k: string): string | null },
  what: string,
): { userName: string; password: string } => {
  const userName = ctx.str("userName");
  const password = ctx.str("password");
  if (!userName || !password) throw new Error(`Aras ${what} has no web service username and password`);
  if (/[\p{Cc}]/u.test(`${userName}${password}`)) {
    throw new Error("Aras username and password must not contain control characters — check for a bad paste");
  }
  return { userName, password };
};

const call = (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  operation: string,
  body: Record<string, SoapValue>,
): Promise<XmlNode> =>
  soapCall(ctx.fetch, ENDPOINT, {
    namespace: NAMESPACE,
    operation,
    body,
    // ASP.NET checks it, and the WSDL gives it as the namespace plus the
    // operation name. Getting it wrong is answered with a fault about an
    // operation nobody asked for.
    action: `${NAMESPACE}${operation}`,
  }).catch((e: unknown) => {
    // A fault is the service saying no, and its own words are more useful than
    // anything this side could infer.
    if (e instanceof SoapFault) throw new Error(`Aras refused the request: ${e.message.slice(0, 160)}`);
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
 */
const consignmentKey = (idempotencyKey: string): string =>
  idempotencyKey.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "backlex";

/**
 * Turn the service's own result fields into a thrown error, or nothing.
 *
 * This is why a provider cannot just check the HTTP status: Aras answers 200
 * with a `ResultCode` inside, so a booking that was refused looks exactly like
 * one that succeeded until this reads the field. Zero is success; anything else
 * carries `ResultMessage`, and an answer with no result element at all is a
 * refusal too — it means the operation returned nothing to be the outcome of.
 */
const readResult = (result: XmlNode | null, what: string): void => {
  if (!result) throw new Error(`Aras returned no result and could not ${what}`);
  const code = xmlText(result, "ResultCode");
  if (code === null || code === "0") return;
  const message = xmlText(result, "ResultMessage");
  throw new Error(`Aras could not ${what} (${code})${message ? `: ${message.slice(0, 160)}` : ""}`);
};

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * One row-field setting.
 *
 * A function rather than shared constants so the two tasks cannot end up
 * holding one object between them — the descriptor is spread into the catalog,
 * and a frozen instance shared across tasks is an unpleasant surprise the day
 * anything mutates it.
 */
function rowField(key: string, label: string, placeholder: string) {
  return { key, label, placeholder };
}

const readIntegrationCode = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("integrationCodeField");
  if (!field) throw new Error("Aras task needs the row field holding the consignment key");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no Aras consignment key`);
  return value;
};

const requiredRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
  what: string,
): string => {
  const field = ctx.setting(settingKey);
  if (!field) throw new Error(`Aras booking needs the row field holding the ${what}`);
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no ${what} to send to Aras`);
  return value;
};

const optionalRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): string | null => {
  const field = ctx.setting(settingKey);
  return field ? text(ctx.row[field]) : null;
};

/** Aras types every measure as a STRING, so a number is sent as its text. */
const optionalRowText = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): string | null => {
  const n = optionalRowNumber(ctx, settingKey);
  return n === null ? null : String(n);
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

/** Re-exported so the tests and the docs read one source for the wire address. */
export const ARAS_ENDPOINT = ENDPOINT;
export const ARAS_NAMESPACE = NAMESPACE;
