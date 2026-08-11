import {
  parcelSettingFields,
  readParcel,
  readShipFrom,
  readShipTo,
  shipFromConfigFields,
  shipToSettingFields,
  type PostalAddress,
} from "../address";
import { defineProvider } from "../provider";

/**
 * UPS — book a shipment and store its label, read where the parcel is, void it.
 *
 * The sixth carrier and the last one the roadmap planned for. Two things about
 * it are firsts for this engine, and both are the interesting part of the file.
 *
 * ## It is the first provider that mints its own token
 *
 * Every OAuth provider here so far (Notion, Google, QuickBooks, Xero) uses the
 * **authorization-code** grant, which the engine drives: an admin is redirected,
 * consents, and the engine stores and refreshes the tokens. UPS uses
 * **client-credentials**, where there is no user to redirect and no refresh
 * token — the credentials themselves are exchanged for a short-lived bearer.
 * That does not fit `IntegrationOAuth`, and pretending it did would mean an
 * authorize screen nobody can consent on.
 *
 * So the exchange lives here, and {@link tokenFor} caches the result. The cache
 * is keyed by the credential pair rather than by client id alone: a rotated
 * secret must not keep serving a token minted from the old one, and a key that
 * IS the credential can only be read by a caller that already holds it.
 * Per-isolate and best-effort, exactly like the rate-limit buckets — a cold
 * isolate mints a fresh token, which costs one request.
 *
 * ## It is the second user of the shared address shape, and the reason it exists
 *
 * `../address` was lifted out of EasyPost when this file turned out to want the
 * same fifteen settings under the same names — the rule this repo already
 * follows for `./soap`. What UPS adds on top is not the shape but its
 * **units**: every weight and dimension carries a `UnitOfMeasurement` code, so
 * the operator picks LBS/KGS and IN/CM on the connection and the same numbers
 * mean what they say. EasyPost fixes ounces and inches instead, which is why
 * the shared placeholders take the unit as a parameter.
 *
 * ## Three things the code depends on
 *
 * **`transId` and `transactionSrc` are required on every call.** UPS documents
 * `transId` as "an identifier unique to the request"; it is a correlation id
 * rather than an idempotency key, and it is derived from the engine's
 * idempotency key so a support conversation about a retried booking has one
 * reference rather than three.
 *
 * **A booking answers with a nested success, not a status code.** The label and
 * the tracking number are in
 * `ShipmentResponse.ShipmentResults.PackageResults`, which is an object for one
 * package and an array for several. Reading only the first shape would work
 * until the day somebody books two boxes.
 *
 * **The label arrives as base64 in the response**, not as a URL to fetch. That
 * is better than EasyPost's arrangement, where a separate host has to be
 * allow-listed — there is nothing here to go and get, so nothing to fail after
 * postage is already paid.
 */

/**
 * The two environments, and they are two HOSTS rather than two keys.
 *
 * Unlike EasyPost — where the key itself decides whether postage is real — UPS
 * publishes a Customer Integration Environment on its own hostname. A picker is
 * therefore right here and would be wrong there.
 */
const ENVIRONMENTS = [
  { value: "production", label: "Production (onlinetools.ups.com)" },
  { value: "test", label: "Customer Integration Environment (wwwcie.ups.com)" },
] as const;

const HOSTS = {
  production: "https://onlinetools.ups.com",
  test: "https://wwwcie.ups.com",
} as const;

/** The Ship API release this provider speaks. The only value UPS documents. */
const SHIP_VERSION = "v2409";

/** Weight units UPS accepts, and the label an operator recognises. */
const WEIGHT_UNITS = [
  { value: "KGS", label: "Kilograms" },
  { value: "LBS", label: "Pounds" },
] as const;

/** Dimension units, same story. */
const LENGTH_UNITS = [
  { value: "CM", label: "Centimetres" },
  { value: "IN", label: "Inches" },
] as const;

/**
 * Label formats UPS will render.
 *
 * A closed set because it decides what lands in storage: GIF and PDF are
 * documents a person opens, ZPL and EPL are printer languages a warehouse sends
 * straight to a thermal printer. The stored file's content type and extension
 * follow from this, which is why {@link labelFile} maps it rather than guessing
 * from the bytes.
 */
const LABEL_FORMATS = [
  { value: "GIF", label: "GIF image" },
  { value: "PDF", label: "PDF document" },
  { value: "ZPL", label: "ZPL (Zebra printer)" },
  { value: "EPL", label: "EPL (Eltron printer)" },
  { value: "SPL", label: "SPL (Sato printer)" },
  { value: "STARPL", label: "STAR PL (Star printer)" },
] as const;

export const ups = defineProvider({
  id: "ups",
  label: "UPS",
  category: "carrier",
  capabilities: ["task"],
  /**
   * No published per-account quota on these endpoints, only that UPS answers
   * 429. Paced like every other courier here: these are per-row operations an
   * operator or a flow triggers, so nothing walks pages. The 429 path is the
   * real guarantee either way.
   */
  limits: { rps: 5, burst: 10 },
  configFields: [
    { key: "clientId", label: "Client ID", secret: true, placeholder: "from your app on developer.ups.com" },
    { key: "clientSecret", label: "Client secret", secret: true },
    {
      key: "accountNumber",
      label: "Shipper account number",
      placeholder: "your six-character UPS account, e.g. A1B2C3",
    },
    { key: "environment", label: "Environment", options: ENVIRONMENTS },
    // The shared shape. Same nine keys EasyPost already ships, because they are
    // a contract stored in live connections rather than names chosen per file.
    ...shipFromConfigFields(),
    { key: "weightUnit", label: "Weight unit", options: WEIGHT_UNITS },
    { key: "lengthUnit", label: "Dimension unit", options: LENGTH_UNITS },
  ],
  tasks: [
    {
      id: "book_shipment",
      label: "Book shipment",
      /**
       * NOT repeatable: booking twice buys postage twice and puts two
       * consignments on a courier's manifest. The engine's task-run row is the
       * guard — UPS publishes no idempotency header, and unlike the SOAP
       * couriers here there is no caller-chosen consignment key to fall back
       * on, so that row is the only thing standing between a retry and a second
       * label.
       */
      settingFields: [
        {
          key: "service",
          label: "Service",
          placeholder: "UPS service code from your rate card, e.g. 11 (Standard) or 07 (Worldwide Express)",
        },
        {
          key: "packaging",
          label: "Packaging type",
          placeholder: "UPS packaging code, e.g. 02 for your own packaging",
        },
        ...shipToSettingFields(),
        // The unit is on the connection, so the hint reads it back rather than
        // naming one — a placeholder saying "ounces" over a KGS connection is
        // how a 5 kg parcel gets booked as 5 lb.
        ...parcelSettingFields({ weight: "the connection's weight unit", length: "connection unit" }),
        {
          key: "labelFormat",
          label: "Label format",
          options: LABEL_FORMATS,
        },
        { key: "descriptionField", label: "Description field (optional)", placeholder: "e.g. order_number" },
      ],
      outputs: [
        { key: "shipmentId", label: "Carrier shipment ID" },
        { key: "trackingNumber", label: "Tracking number" },
        { key: "service", label: "Service" },
        { key: "rate", label: "Rate charged" },
        { key: "currency", label: "Rate currency" },
        { key: "billingWeight", label: "Billable weight" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "bookedAt", label: "Booked at" },
        /**
         * Stored, and the row is given the storage key rather than a URL — the
         * way every other stored file on this platform is held. UPS hands the
         * label back inside the response as base64, so unlike EasyPost there is
         * no second host to reach and nothing that can fail after postage has
         * already been paid.
         */
        { key: "labelKey", label: "Label", artifact: true },
      ],
      async run(ctx) {
        const conn = readConnection(ctx);
        const format = readChoice(ctx.setting("labelFormat"), LABEL_FORMATS, "GIF");

        const shipment = {
          Description: ctx.setting("descriptionField")
            ? text(ctx.row[ctx.setting("descriptionField") as string])
            : null,
          Shipper: {
            ...party(readShipFrom(ctx, "UPS")),
            // The account that gets billed, and UPS wants it named twice — once
            // as the shipper's number and again in the payment instruction.
            ShipperNumber: conn.accountNumber,
          },
          ShipTo: party(readShipTo(ctx, "UPS")),
          ShipFrom: party(readShipFrom(ctx, "UPS")),
          PaymentInformation: {
            ShipmentCharge: { Type: "01", BillShipper: { AccountNumber: conn.accountNumber } },
          },
          Service: { Code: requiredSetting(ctx, "service", "UPS service code") },
          Package: packageOf(ctx, conn),
        };

        const body = await call(ctx, conn, "POST", `/api/shipments/${SHIP_VERSION}/ship`, {
          ShipmentRequest: {
            Request: { RequestOption: "nonvalidate" },
            Shipment: shipment,
            LabelSpecification: { LabelImageFormat: { Code: format } },
          },
        });

        const results = (body as UpsShipResponse).ShipmentResponse?.ShipmentResults;
        const shipmentId = text(results?.ShipmentIdentificationNumber);
        // One package answers with an object and several with an array. Reading
        // only the first shape would work until somebody books two boxes.
        const packages = asList<UpsPackageResult>(results?.PackageResults);
        const first = packages[0];
        const trackingNumber = text(first?.TrackingNumber);
        if (!shipmentId || !trackingNumber) {
          throw new Error("UPS accepted the shipment but returned no tracking number");
        }

        const charge = results?.ShipmentCharges?.TotalCharges;
        return {
          outputs: {
            shipmentId,
            trackingNumber,
            service: ctx.setting("service"),
            rate: text(charge?.MonetaryValue),
            currency: text(charge?.CurrencyCode),
            billingWeight: text(results?.BillingWeight?.Weight),
            shipmentStatus: "booked",
            bookedAt: Date.now(),
          },
          artifact: labelFile(first?.ShippingLabel?.GraphicImage, format, trackingNumber) ?? undefined,
        };
      },
    },
    {
      id: "refresh_tracking",
      label: "Refresh tracking",
      /**
       * The read half, and genuinely repeatable: where a parcel is has no side
       * effect at UPS and the whole value of the answer is that it moves. Under
       * the once-only guard the row would keep whatever the first poll said.
       * Put it on a cron flow over the shipments that are not delivered yet.
       */
      repeatable: true,
      settingFields: [
        {
          key: "trackingNumberField",
          label: "Tracking number field",
          placeholder: "the row field book_shipment wrote, e.g. carrier_shipment_id",
        },
      ],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "statusDescription", label: "Status detail" },
        { key: "statusAt", label: "Status reported at" },
        { key: "statusLocation", label: "Last known location" },
        { key: "estimatedDeliveryAt", label: "Estimated delivery" },
        { key: "deliveredAt", label: "Delivered at" },
        { key: "service", label: "Service" },
        { key: "packageCount", label: "Packages" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx);
        const trackingNumber = readTrackingNumber(ctx);

        const body = await call(
          ctx,
          conn,
          "GET",
          `/api/track/v1/details/${encodeURIComponent(trackingNumber)}`,
          null,
        );

        const shipments = asList<UpsTrackShipment>((body as UpsTrackResponse).trackResponse?.shipment);
        const pkg = asList<UpsPackage>(shipments[0]?.package)[0];
        if (!pkg) throw new Error(`UPS has no shipment "${trackingNumber}"`);

        // UPS documents activities as chronological with the most recent FIRST,
        // so unlike DHL the order is part of the contract and the newest is
        // simply the head. `currentStatus` is preferred where present because it
        // is the package's state rather than one scan of it.
        const latest = asList<UpsActivity>(pkg.activity)[0];
        const status = pkg.currentStatus ?? latest?.status;
        const dates = asList<UpsDeliveryDate>(pkg.deliveryDate);

        return {
          outputs: {
            // UPS's own five-ish coarse type beside its own words, kept rather
            // than remapped onto an invented set — the operator's panel shows
            // these, and a second list is a second thing to keep in step.
            shipmentStatus: text(status?.statusCode) ?? text(status?.type),
            statusDescription: text(status?.description) ?? text(status?.simplifiedTextDescription),
            statusAt: joinDateTime(latest?.date, latest?.time),
            statusLocation: text(latest?.location?.address?.city),
            // SDD is the scheduled date, RDD a rescheduled one, DEL the day it
            // actually landed. A rescheduled date supersedes the original.
            estimatedDeliveryAt: upsDate(pickDate(dates, "RDD") ?? pickDate(dates, "SDD")),
            deliveredAt: upsDate(pickDate(dates, "DEL")),
            service: text(pkg.service?.description) ?? text(pkg.service?.code),
            packageCount: text(pkg.packageCount),
          },
        };
      },
    },
    {
      id: "cancel_shipment",
      label: "Void shipment",
      /**
       * NOT repeatable. Voiding is a request to a carrier, and asking twice is
       * asking twice — the second is answered with an error about a shipment
       * that is already gone, which reaches an operator as a failed run they did
       * not cause.
       *
       * Addressed by the shipment identification number rather than the tracking
       * number, because that is what UPS's void endpoint takes in its path. The
       * booking writes both, so the row has it.
       */
      settingFields: [
        {
          key: "shipmentIdField",
          label: "Shipment ID field",
          placeholder: "the row field book_shipment wrote, e.g. carrier_shipment_id",
        },
      ],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "resultMessage", label: "Carrier message" },
        { key: "cancelledAt", label: "Cancelled at" },
      ],
      async run(ctx) {
        const conn = readConnection(ctx);
        const field = ctx.setting("shipmentIdField");
        if (!field) throw new Error("UPS void needs the row field holding the shipment id");
        const shipmentId = text(ctx.row[field]);
        if (!shipmentId) throw new Error(`Row field "${field}" holds no UPS shipment id`);

        const body = await call(
          ctx,
          conn,
          "DELETE",
          `/api/shipments/${SHIP_VERSION}/void/cancel/${encodeURIComponent(shipmentId)}`,
          null,
        );

        const status = (body as UpsVoidResponse).VoidShipmentResponse?.SummaryResult?.Status;
        return {
          outputs: {
            shipmentStatus: "cancelled",
            resultMessage: text(status?.Description) ?? text(status?.Code),
            cancelledAt: Date.now(),
          },
        };
      },
    },
  ],
});

// ── Connection ───────────────────────────────────────────────────────────────

interface Connection {
  host: string;
  clientId: string;
  clientSecret: string;
  accountNumber: string;
  weightUnit: string;
  lengthUnit: string;
}

/**
 * Read the connection.
 *
 * The credentials reach an `Authorization: Basic` header, so a newline in one
 * would be a request-splitting primitive rather than a bad password — hence the
 * check is for printable ASCII rather than for shape. Base64 would mask it,
 * which is exactly why it is caught before the encoding rather than after.
 */
const readConnection = (ctx: { str(k: string): string | null }): Connection => {
  const clientId = ctx.str("clientId");
  const clientSecret = ctx.str("clientSecret");
  if (!clientId || !clientSecret) throw new Error("UPS task has no client id and secret");
  if (/[^\x20-\x7e]/.test(`${clientId}${clientSecret}`)) {
    throw new Error("UPS client id and secret must be printable ASCII — check for a bad paste");
  }

  const accountNumber = ctx.str("accountNumber");
  if (!accountNumber) throw new Error("UPS task has no shipper account number");

  return {
    host: HOSTS[readChoice(ctx.str("environment"), ENVIRONMENTS, "production") as keyof typeof HOSTS],
    clientId,
    clientSecret,
    accountNumber,
    weightUnit: readChoice(ctx.str("weightUnit"), WEIGHT_UNITS, "KGS"),
    lengthUnit: readChoice(ctx.str("lengthUnit"), LENGTH_UNITS, "CM"),
  };
};

/**
 * A bearer token for these credentials, minted or remembered.
 *
 * Keyed by the credential PAIR rather than by client id alone: a rotated secret
 * must not keep serving a token minted from the old one, and a key that is
 * itself the credential can only be read by a caller already holding it. The
 * map is per-isolate and best-effort — a cold isolate mints a fresh token,
 * which costs exactly one request.
 *
 * Retired a minute before UPS says it expires, because the token still has to
 * survive the call it is about to be used on.
 */
const tokens = new Map<string, { value: string; expiresAtMs: number }>();
const TOKEN_GRACE_MS = 60_000;

const tokenFor = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  conn: Connection,
): Promise<string> => {
  const key = `${conn.host} ${conn.clientId} ${conn.clientSecret}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.value;

  const res = await ctx.fetch(`${conn.host}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64(`${conn.clientId}:${conn.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw await readError(res, "authenticate");

  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  const value = text(body.access_token);
  if (!value) throw new Error("UPS returned no access token");

  // Documented as a string of seconds. A missing or unreadable one is treated
  // as the shortest sane life rather than as forever — a token cached past its
  // death answers 401 on every call until the isolate recycles.
  const seconds = Number(text(body.expires_in) ?? "");
  const lifeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5 * 60_000;
  tokens.set(key, { value, expiresAtMs: Date.now() + Math.max(0, lifeMs - TOKEN_GRACE_MS) });
  return value;
};

/** Drop every cached token. Tests only — each spec starts from a cold isolate. */
export const resetUpsTokens = (): void => {
  tokens.clear();
};

/**
 * One call, with the two headers UPS requires on every endpoint.
 *
 * `transId` is documented as "an identifier unique to the request". It is a
 * correlation id rather than an idempotency key — UPS publishes none — so it is
 * derived from the engine's idempotency key, which makes a support conversation
 * about a retried booking cite one reference instead of three.
 */
const call = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response>; idempotencyKey: string },
  conn: Connection,
  method: string,
  path: string,
  body: unknown,
): Promise<unknown> => {
  const token = await tokenFor(ctx, conn);
  const res = await ctx.fetch(`${conn.host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      transId: transactionId(ctx.idempotencyKey),
      transactionSrc: "backlex",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await readError(res, "complete the request");
  return res.json();
};

/** UPS caps `transId` at 32 characters and it reaches a header. */
const transactionId = (idempotencyKey: string): string =>
  idempotencyKey.replace(/[^A-Za-z0-9-]/g, "").slice(0, 32) || "backlex";

// ── Building the shipment ────────────────────────────────────────────────────

/**
 * A shared {@link PostalAddress} in UPS's own field names.
 *
 * The only thing this file owns about an address. UPS nests the street as an
 * `AddressLine` array and spells the postcode `PostalCode`; EasyPost calls the
 * same two `street1` and `zip`. Keeping each translation in its own provider is
 * what lets `../address` stay a description of a postal address rather than a
 * union of two carriers' wire formats.
 */
const party = (a: PostalAddress): Record<string, unknown> =>
  prune({
    Name: a.company ?? a.name,
    AttentionName: a.name,
    Phone: a.phone ? { Number: a.phone } : null,
    Address: prune({
      AddressLine: [a.street1, a.street2].filter((l): l is string => !!l),
      City: a.city,
      StateProvinceCode: a.state,
      PostalCode: a.postcode,
      CountryCode: a.country,
    }),
  });

/**
 * What is in the box, in UPS's names and with the units it demands.
 *
 * Every measure UPS takes carries its own `UnitOfMeasurement`, which is the one
 * real difference between this and EasyPost's parcel: there, ounces and inches
 * are implied. Dimensions travel only when the row has all three — UPS rejects
 * a partial set, and sending two of them would fail the booking with a message
 * about the box rather than about the column nobody mapped.
 */
const packageOf = (
  ctx: Parameters<typeof readParcel>[0],
  conn: Connection,
): Record<string, unknown> => {
  const parcel = readParcel(ctx, "the connection's weight unit");
  const { length, width, height } = parcel;
  const complete = length !== null && width !== null && height !== null;

  return prune({
    Packaging: { Code: requiredSetting(ctx, "packaging", "UPS packaging code") },
    PackageWeight: {
      UnitOfMeasurement: { Code: conn.weightUnit },
      Weight: String(parcel.weight),
    },
    Dimensions: complete
      ? {
          UnitOfMeasurement: { Code: conn.lengthUnit },
          Length: String(length),
          Width: String(width),
          Height: String(height),
        }
      : null,
  });
};

/**
 * The label, decoded from the base64 UPS answered with.
 *
 * Returns nothing rather than throwing, for the same reason EasyPost's does:
 * by the time this runs the shipment is BOOKED and a courier is expecting a
 * parcel. Failing the task would roll the run back to `failed`, which the queue
 * retries, which books a second shipment. A missing label is a nuisance; a
 * second consignment is money and a confused courier.
 */
const labelFile = (
  graphic: unknown,
  format: string,
  trackingNumber: string,
): { outputKey: string; filename: string; contentType: string; bytes: Uint8Array } | null => {
  const encoded = text(graphic);
  if (!encoded) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded.replace(/\s+/g, ""));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    // Not base64. The shipment is already booked, so this is reported by the
    // row having no label rather than by failing a run that cannot be retried
    // safely.
    return null;
  }
  const kind = LABEL_TYPES[format] ?? { ext: "txt", type: "text/plain" };
  return {
    outputKey: "labelKey",
    filename: `${trackingNumber}.${kind.ext}`,
    contentType: kind.type,
    bytes,
  };
};

/**
 * What each label format actually is once it is stored.
 *
 * Mapped from the format that was ASKED for rather than sniffed from the bytes:
 * ZPL and EPL are printer languages that look like plain text, and a stored
 * `.txt` a warehouse cannot send to its printer is a label nobody can use.
 */
const LABEL_TYPES: Record<string, { ext: string; type: string }> = {
  GIF: { ext: "gif", type: "image/gif" },
  PDF: { ext: "pdf", type: "application/pdf" },
  ZPL: { ext: "zpl", type: "text/plain; charset=utf-8" },
  EPL: { ext: "epl", type: "text/plain; charset=utf-8" },
  SPL: { ext: "spl", type: "text/plain; charset=utf-8" },
  STARPL: { ext: "starpl", type: "text/plain; charset=utf-8" },
};

// ── The answer ───────────────────────────────────────────────────────────────

interface UpsStatus {
  code?: unknown;
  description?: unknown;
  simplifiedTextDescription?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

interface UpsDeliveryDate {
  date?: unknown;
  type?: unknown;
}

interface UpsPackageResult {
  TrackingNumber?: unknown;
  ShippingLabel?: { GraphicImage?: unknown };
}

interface UpsPackage {
  activity?: unknown;
  currentStatus?: UpsStatus;
  deliveryDate?: unknown;
  service?: { code?: unknown; description?: unknown };
  packageCount?: unknown;
}

interface UpsTrackShipment {
  package?: unknown;
}

interface UpsActivity {
  date?: unknown;
  time?: unknown;
  status?: UpsStatus;
  location?: { address?: { city?: unknown } };
}

interface UpsShipResponse {
  ShipmentResponse?: {
    ShipmentResults?: {
      ShipmentIdentificationNumber?: unknown;
      BillingWeight?: { Weight?: unknown };
      ShipmentCharges?: { TotalCharges?: { CurrencyCode?: unknown; MonetaryValue?: unknown } };
      PackageResults?: unknown;
    };
  };
}

interface UpsTrackResponse {
  trackResponse?: {
    shipment?: unknown;
  };
}

interface UpsVoidResponse {
  VoidShipmentResponse?: { SummaryResult?: { Status?: { Code?: unknown; Description?: unknown } } };
}

/**
 * UPS answers with an object for one and an array for several, throughout.
 *
 * `PackageResults`, `shipment`, `package`, `activity` and `deliveryDate` all do
 * it, so this is the single place that stops caring. A provider that indexed
 * `[0]` on the object form would read `undefined` and report a successful
 * booking with no tracking number.
 */
const asList = <T>(v: unknown): T[] => {
  if (Array.isArray(v)) return v as T[];
  return v === null || v === undefined ? [] : [v as T];
};

const pickDate = (dates: UpsDeliveryDate[], type: string): unknown =>
  dates.find((d) => text(d?.type) === type)?.date;

/** UPS dates are `YYYYMMDD` and times `HHMMSS`, both without a separator. */
const upsDate = (raw: unknown): string | null => {
  const s = text(raw);
  if (!s || !/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const joinDateTime = (date: unknown, time: unknown): string | null => {
  const day = upsDate(date);
  if (!day) return null;
  const t = text(time);
  return t && /^\d{6}$/.test(t) ? `${day} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : day;
};

// ── Shared ───────────────────────────────────────────────────────────────────

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

const prune = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));

const readChoice = (raw: string | null, options: readonly { value: string }[], fallback: string): string =>
  raw !== null && options.some((o) => o.value === raw) ? raw : fallback;

const requiredSetting = (ctx: { setting(k: string): string | null }, key: string, what: string): string => {
  const value = ctx.setting(key);
  if (!value) throw new Error(`UPS booking needs the ${what}`);
  return value;
};

const readTrackingNumber = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("trackingNumberField");
  if (!field) throw new Error("UPS task needs the row field holding the tracking number");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no UPS tracking number`);
  return value;
};

const base64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

/**
 * Turn a failed call into something an operator can act on.
 *
 * UPS wraps every error the same way — `response.errors[]` with a `code` and a
 * `message` — on both the OAuth endpoint and the APIs, so one reader serves all
 * of them.
 *
 * 429 is deliberately absent: the engine's fetch wrapper classifies it before a
 * provider sees the response, so a branch here would be unreachable and would
 * read as though it still decided something.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { response?: { errors?: { code?: unknown; message?: unknown }[] } };
    const first = body.response?.errors?.find((e) => text(e?.message));
    if (first) detail = `${text(first.code) ?? "error"}: ${text(first.message)}`.slice(0, 200);
  } catch {
    // Not JSON — a gateway in front of the API answers HTML on some failures,
    // and the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `UPS rejected the credentials — check the client id and secret, and that the app is subscribed to the API (${detail})`,
    );
  }
  return new Error(`UPS responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

/** Re-exported so the tests and the docs read one source for the wire addresses. */
export const UPS_HOSTS = HOSTS;
export const UPS_SHIP_VERSION = SHIP_VERSION;
