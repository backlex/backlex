import { defineProvider } from "../provider";

/**
 * EasyPost — book a shipment, get a tracking number and a label, ask where it
 * is, cancel it.
 *
 * The first `carrier` provider, and deliberately an aggregator rather than a
 * courier. The three tasks below are the whole contract a carrier has with this
 * engine, and proving it against something with public docs, a self-serve test
 * key and a real PDF at the end of it means the next carrier — a national one,
 * behind a branch application and a SOAP envelope — is a translation problem
 * rather than a design one.
 *
 * Four things about this API shape the code below.
 *
 * **Booking is one call, not four.** EasyPost's normal flow creates a shipment,
 * reads its rates, and buys one. Naming `service` and `carrier_accounts` on the
 * create call makes it buy immediately and hand back the bought shipment. A
 * task is one row in and one answer out, and a three-request flow with two
 * places to die in the middle is not that.
 *
 * **There is no idempotency header.** EasyPost does not publish one, so the
 * engine's task-run row is the ONLY thing standing between a retry and a second
 * label. That is exactly the guard {@link https://docs.easypost.com} cannot give
 * us, and the reason `book_shipment` must never be marked repeatable.
 *
 * **The label is a URL, not bytes.** It has to be fetched from wherever EasyPost
 * hosts it, and that host is not part of the documented contract — see
 * {@link labelHostAllowed}. A label that cannot be stored does NOT fail the
 * booking: the shipment is bought either way, and losing the row that records it
 * is far worse than losing a PDF that can be fetched again from the URL the run
 * kept.
 *
 * **Test mode is the key, not a setting.** A test key (`EZTK…`) transacts
 * against test carriers and produces real label PDFs with no money involved;
 * a production key (`EZAK…`) buys postage. There is deliberately no environment
 * dropdown, because there is nothing for it to switch — offering one would imply
 * a production key could be made safe by picking "test".
 */

/** Where the API lives. A constant: never built from config. */
const BASE = "https://api.easypost.com/v2";

/**
 * EasyPost's own vocabulary for where a parcel is.
 *
 * Kept verbatim rather than remapped, because it is already the neutral set —
 * an aggregator's whole job is normalising thirty couriers onto one list, and
 * inventing a second list here would mean two things to keep in step and a
 * status the docs describe under a name the column never shows.
 */
const TRACKER_STATUSES = [
  "unknown",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "available_for_pickup",
  "return_to_sender",
  "failure",
  "cancelled",
] as const;

/**
 * May a label be fetched from this host?
 *
 * EasyPost returns a URL it hosts, and which host that is has never been part of
 * the documented contract — it has been both an `easypost.com` subdomain and an
 * S3 bucket. Fetching whatever a third party puts in a JSON field is how a
 * server ends up making requests somebody else chose, so the answer is an
 * allow-list rather than a scheme check.
 *
 * A host outside it is not an error. See {@link storeLabel}: the shipment is
 * already bought, and refusing to record it because its PDF moved would be the
 * worst of the available outcomes.
 */
const labelHostAllowed = (host: string): boolean =>
  host === "easypost.com" ||
  host.endsWith(".easypost.com") ||
  /^easypost-files\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);

/** Bytes above this are not a shipping label, and are not worth holding in memory. */
const MAX_LABEL_BYTES = 8 * 1024 * 1024;

export const easypost = defineProvider({
  id: "easypost",
  label: "EasyPost",
  category: "carrier",
  capabilities: ["task"],
  /**
   * EasyPost publishes no numeric quota, only that it answers 429. Paced at a
   * rate a booking flow never approaches, so the limit is a courtesy rather
   * than a constraint; the 429 path is the real guarantee.
   */
  limits: { rps: 5, burst: 10 },
  configFields: [
    {
      key: "apiKey",
      label: "API key",
      secret: true,
      placeholder: "EZTK… for test, EZAK… to buy real postage",
    },
    // The ship-FROM address is the workspace's own and is the same on every
    // consignment, so it belongs to the connection. Putting it on the task
    // would mean re-typing a warehouse address onto every flow step that books
    // anything.
    { key: "fromName", label: "Ship-from name" },
    { key: "fromCompany", label: "Ship-from company (optional)" },
    { key: "fromStreet1", label: "Ship-from street" },
    { key: "fromStreet2", label: "Ship-from street 2 (optional)" },
    { key: "fromCity", label: "Ship-from city" },
    { key: "fromState", label: "Ship-from state/province (optional)" },
    { key: "fromZip", label: "Ship-from postcode" },
    {
      key: "fromCountry",
      label: "Ship-from country",
      placeholder: "ISO 3166-1 alpha-2, e.g. US or TR",
    },
    { key: "fromPhone", label: "Ship-from phone (optional)" },
  ],
  tasks: [
    {
      id: "book_shipment",
      label: "Book shipment",
      /**
       * Every `*Field` names a COLUMN on the row, not a value.
       *
       * The same idiom the Trendyol tasks use, and for the same reason: a task
       * serves collections that name their columns differently, so the mapping
       * belongs to whoever invokes it. It is a long list because booking a
       * parcel genuinely needs a destination and a weight — if a second carrier
       * arrives wanting these same fifteen settings verbatim, THAT is the
       * signal to lift an address-and-parcel shape into the engine. One
       * example is not enough to abstract from.
       */
      settingFields: [
        { key: "carrierAccount", label: "Carrier account", placeholder: "ca_… from your EasyPost account" },
        { key: "service", label: "Service", placeholder: "the carrier's service level, e.g. Priority" },
        { key: "toNameField", label: "Recipient name field", placeholder: "e.g. ship_to_name" },
        { key: "toStreet1Field", label: "Recipient street field", placeholder: "e.g. ship_to_street" },
        { key: "toStreet2Field", label: "Recipient street 2 field (optional)" },
        { key: "toCityField", label: "Recipient city field" },
        { key: "toStateField", label: "Recipient state/province field (optional)" },
        { key: "toZipField", label: "Recipient postcode field" },
        { key: "toCountryField", label: "Recipient country field", placeholder: "holds an ISO alpha-2 code" },
        { key: "toPhoneField", label: "Recipient phone field (optional)" },
        { key: "weightField", label: "Weight field", placeholder: "the row field holding weight in ounces" },
        { key: "lengthField", label: "Length field, inches (optional)" },
        { key: "widthField", label: "Width field, inches (optional)" },
        { key: "heightField", label: "Height field, inches (optional)" },
        {
          key: "predefinedPackage",
          label: "Predefined package (optional)",
          placeholder: "carrier packaging instead of dimensions, e.g. FlatRateEnvelope",
        },
      ],
      outputs: [
        { key: "shipmentId", label: "Carrier shipment ID" },
        { key: "trackingCode", label: "Tracking number" },
        { key: "carrier", label: "Carrier" },
        { key: "service", label: "Service" },
        { key: "trackingUrl", label: "Tracking URL" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "estimatedDeliveryAt", label: "Estimated delivery" },
        { key: "rate", label: "Rate paid" },
        { key: "currency", label: "Rate currency" },
        { key: "labelKey", label: "Label", artifact: true },
      ],
      async run(ctx) {
        const { headers } = readConnection(ctx);
        const service = ctx.setting("service");
        if (!service) throw new Error("EasyPost needs a service level to buy — set it on the step");
        const carrierAccount = ctx.setting("carrierAccount");
        if (!carrierAccount) {
          throw new Error("EasyPost needs a carrier account (ca_…) to buy from — set it on the step");
        }

        const shipment: Record<string, unknown> = {
          to_address: toAddress(ctx),
          from_address: fromAddress(ctx),
          parcel: parcel(ctx),
          service,
          carrier_accounts: [carrierAccount],
        };

        const res = await ctx.fetch(`${BASE}/shipments`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ shipment }),
        });
        if (!res.ok) throw await readError(res, "book the shipment");
        const body = (await res.json()) as EasyPostShipment;

        // A shipment that came back without a tracking code was not bought. It
        // exists at EasyPost as an unbought draft, and reporting success would
        // mark an order shipped against a parcel no courier has heard of.
        const trackingCode = text(body.tracking_code);
        if (!trackingCode) {
          throw new Error(
            `EasyPost created the shipment but did not buy it — check that "${service}" is a service the carrier account offers`,
          );
        }

        const outputs = {
          shipmentId: text(body.id),
          trackingCode,
          carrier: text(body.selected_rate?.carrier),
          service: text(body.selected_rate?.service) ?? service,
          trackingUrl: text(body.tracker?.public_url),
          shipmentStatus: status(body.tracker?.status),
          estimatedDeliveryAt: epoch(body.tracker?.est_delivery_date),
          rate: numeric(body.selected_rate?.rate),
          currency: text(body.selected_rate?.currency),
        };

        const artifact = await storeLabel(ctx, body, trackingCode);
        return artifact ? { outputs, artifact } : { outputs };
      },
    },
    {
      id: "refresh_tracking",
      label: "Refresh tracking",
      /**
       * The read half, and the reason the engine grew repeatable tasks.
       *
       * Where a parcel is has no side effect at EasyPost and its whole value is
       * that the answer moves — booked today, delivered on Thursday. Under the
       * once-only guard the row would keep `pre_transit` forever, which is the
       * least useful answer this field will ever hold. Put it on a cron flow
       * over the shipments that are not `delivered` yet.
       */
      repeatable: true,
      settingFields: [
        {
          key: "shipmentIdField",
          label: "Shipment ID field",
          placeholder: "the row field book_shipment wrote, e.g. carrier_shipment_id",
        },
      ],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "trackingCode", label: "Tracking number" },
        { key: "trackingUrl", label: "Tracking URL" },
        { key: "estimatedDeliveryAt", label: "Estimated delivery" },
        { key: "deliveredAt", label: "Delivered at" },
        { key: "lastEvent", label: "Last scan" },
      ],
      async run(ctx) {
        const { headers } = readConnection(ctx);
        const id = readShipmentId(ctx);

        const res = await ctx.fetch(`${BASE}/shipments/${encodeURIComponent(id)}`, { headers });
        if (!res.ok) throw await readError(res, "read the tracking");
        const body = (await res.json()) as EasyPostShipment;

        const details = body.tracker?.tracking_details ?? [];
        const last = details.length > 0 ? details[details.length - 1] : undefined;
        const delivered = details.find((d) => d?.status === "delivered");

        return {
          outputs: {
            shipmentStatus: status(body.tracker?.status),
            trackingCode: text(body.tracking_code),
            trackingUrl: text(body.tracker?.public_url),
            estimatedDeliveryAt: epoch(body.tracker?.est_delivery_date),
            deliveredAt: epoch(delivered?.datetime),
            lastEvent: text(last?.message) ?? text(last?.status),
          },
        };
      },
    },
    {
      id: "cancel_shipment",
      label: "Cancel shipment",
      /**
       * Refunding a label is EasyPost's cancel, and it is NOT repeatable: it is
       * a request to a carrier, and asking twice is asking twice.
       *
       * `refund_status` comes back `submitted` rather than `refunded` — carriers
       * take up to a month to answer — so this writes what was asked for, not
       * what was granted. The row saying `submitted` for a while is the truth;
       * writing `refunded` on the strength of having asked would not be.
       */
      settingFields: [
        {
          key: "shipmentIdField",
          label: "Shipment ID field",
          placeholder: "the row field book_shipment wrote, e.g. carrier_shipment_id",
        },
      ],
      outputs: [
        { key: "refundStatus", label: "Refund status" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "cancelledAt", label: "Cancelled at" },
      ],
      async run(ctx) {
        const { headers } = readConnection(ctx);
        const id = readShipmentId(ctx);

        const res = await ctx.fetch(`${BASE}/shipments/${encodeURIComponent(id)}/refund`, {
          method: "POST",
          headers,
        });
        if (!res.ok) throw await readError(res, "cancel the shipment");
        const body = (await res.json()) as EasyPostShipment;

        const refundStatus = text(body.refund_status);
        // The one answer that is a refusal rather than a delay. Saying so here
        // beats a row that reads "not_applicable" and an operator who believes
        // the consignment is cancelled.
        if (refundStatus === "not_applicable") {
          throw new Error(
            "EasyPost will not refund this label — it is outside the carrier's refund window or was never bought",
          );
        }

        return {
          outputs: {
            refundStatus: refundStatus ?? "submitted",
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
 * The key, as a Basic-auth header.
 *
 * EasyPost puts the key in the USERNAME and leaves the password empty, so the
 * encoded pair ends in a colon. `btoa` throws on anything outside Latin-1 and
 * names a DOM API when it does, which tells an operator nothing about the
 * credential they pasted — so a stray non-ASCII character is caught here and
 * described.
 */
const readConnection = (ctx: { str(k: string): string | null }): { headers: Record<string, string> } => {
  const apiKey = ctx.str("apiKey");
  if (!apiKey) throw new Error("EasyPost connection has no API key");
  if (/[^\x20-\x7E]/.test(apiKey)) {
    throw new Error("EasyPost API key must be plain ASCII — check for a bad paste");
  }
  return {
    headers: {
      Authorization: `Basic ${btoa(`${apiKey}:`)}`,
      Accept: "application/json",
    },
  };
};

/** The shipment handle a task acts on, read off the row. */
const readShipmentId = (ctx: {
  row: Readonly<Record<string, unknown>>;
  setting(k: string): string | null;
}): string => {
  const field = ctx.setting("shipmentIdField");
  if (!field) throw new Error("EasyPost task needs the row field holding the shipment id");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no EasyPost shipment id`);
  // Interpolated into a URL path, and EasyPost's ids are a known shape — a row
  // carrying something else is a mis-pointed setting, and saying so beats a 404
  // from a URL nobody meant to build.
  if (!/^shp_[A-Za-z0-9]{1,64}$/.test(value)) {
    throw new Error(`"${field}" does not hold an EasyPost shipment id — they look like shp_…`);
  }
  return value;
};

// ── Building the shipment ────────────────────────────────────────────────────

interface FieldReader {
  row: Readonly<Record<string, unknown>>;
  str(k: string): string | null;
  setting(k: string): string | null;
}

/**
 * Read the row column a setting points at, RAW. Absent setting → nothing.
 *
 * Raw rather than stringified because the caller knows which shape it wants and
 * this does not: a weight column holds a number, and coercing everything
 * through the string reader here would drop it silently and report the row as
 * having no weight at all.
 */
const fromRow = (ctx: FieldReader, setting: string): unknown => {
  const field = ctx.setting(setting);
  return field ? ctx.row[field] : null;
};

/**
 * Where it is going.
 *
 * Only the destination is validated up front, and only for the two parts every
 * carrier needs — a name to hand it to and a street to take it to. Everything
 * else EasyPost judges against the country's own rules, and it knows those far
 * better than a check here could.
 */
const toAddress = (ctx: FieldReader): Record<string, unknown> => {
  const name = text(fromRow(ctx, "toNameField"));
  const street1 = text(fromRow(ctx, "toStreet1Field"));
  if (!name || !street1) {
    throw new Error(
      "The row has no recipient name and street — point the task's recipient fields at the columns that hold them",
    );
  }
  return prune({
    name,
    street1,
    street2: text(fromRow(ctx, "toStreet2Field")),
    city: text(fromRow(ctx, "toCityField")),
    state: text(fromRow(ctx, "toStateField")),
    // A postcode column is often numeric, and a leading zero survives only as
    // text — so this is stringified rather than read as one.
    zip: scalar(fromRow(ctx, "toZipField")),
    country: country(text(fromRow(ctx, "toCountryField"))),
    phone: scalar(fromRow(ctx, "toPhoneField")),
  });
};

/** Where it is coming from — the connection's own address. */
const fromAddress = (ctx: FieldReader): Record<string, unknown> => {
  const name = ctx.str("fromName");
  const street1 = ctx.str("fromStreet1");
  if (!name || !street1) {
    throw new Error("The EasyPost connection has no ship-from name and street — add them to the connection");
  }
  return prune({
    name,
    company: ctx.str("fromCompany"),
    street1,
    street2: ctx.str("fromStreet2"),
    city: ctx.str("fromCity"),
    state: ctx.str("fromState"),
    zip: ctx.str("fromZip"),
    country: country(ctx.str("fromCountry")),
    phone: ctx.str("fromPhone"),
  });
};

/**
 * What is in the box.
 *
 * Weight is the one thing no carrier will quote without. Dimensions are
 * optional because `predefined_package` replaces them — a flat-rate envelope
 * has no dimensions to give.
 */
const parcel = (ctx: FieldReader): Record<string, unknown> => {
  const weight = numeric(fromRow(ctx, "weightField"));
  if (weight === null || weight <= 0) {
    throw new Error(
      "The row has no parcel weight — point the task's weight field at a column holding ounces",
    );
  }
  return prune({
    weight,
    length: numeric(fromRow(ctx, "lengthField")),
    width: numeric(fromRow(ctx, "widthField")),
    height: numeric(fromRow(ctx, "heightField")),
    predefined_package: ctx.setting("predefinedPackage"),
  });
};

/**
 * An ISO 3166-1 alpha-2 code, upper-cased, or nothing.
 *
 * A country column holding "United States" is a mapping pointed at the display
 * name, and sending it would have EasyPost reject the address with a message
 * about the country field rather than about the column that filled it.
 */
const country = (raw: string | null): string | null => {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(`"${raw}" is not a country code — EasyPost wants ISO alpha-2, like US or TR`);
  }
  return code;
};

/**
 * A scalar column as the string EasyPost wants, without losing its shape.
 *
 * A postcode stored as a number is still a postcode, and `String(90277)` is the
 * right answer — but a JSON or relation column reaching here would stringify to
 * `[object Object]` and be sent as an address line, so anything non-scalar is
 * nothing.
 */
const scalar = (v: unknown): string | null => {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return text(v);
};

/** Drop the keys with nothing in them: EasyPost validates empty strings. */
const prune = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));

// ── The label ────────────────────────────────────────────────────────────────

/**
 * Fetch the label PDF so the row can name a stored key rather than a URL that
 * expires.
 *
 * Returns nothing rather than throwing on every failure here, and that is the
 * important decision in this file. By the time this runs the shipment is BOUGHT
 * — postage is paid and a courier is expecting a parcel. Failing the task would
 * roll the run back to `failed`, which the queue retries, which books a second
 * shipment. A missing PDF is a nuisance; a second consignment is money and a
 * confused courier.
 */
const storeLabel = async (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  body: EasyPostShipment,
  trackingCode: string,
): Promise<{ outputKey: string; filename: string; contentType: string; bytes: Uint8Array } | null> => {
  const raw = text(body.postage_label?.label_pdf_url) ?? text(body.postage_label?.label_url);
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !labelHostAllowed(url.hostname)) return null;

  const res = await ctx.fetch(url.toString()).catch(() => null);
  if (!res?.ok) return null;

  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_LABEL_BYTES) return null;

  // The extension decides how the stored object is served, so it is taken from
  // which URL was used rather than from a Content-Type a CDN guessed.
  const pdf = raw === text(body.postage_label?.label_pdf_url);
  return {
    outputKey: "labelKey",
    filename: `label-${trackingCode}.${pdf ? "pdf" : "png"}`,
    contentType: pdf ? "application/pdf" : "image/png",
    bytes: new Uint8Array(buf),
  };
};

// ── Reading answers ──────────────────────────────────────────────────────────

interface EasyPostShipment {
  id?: unknown;
  tracking_code?: unknown;
  refund_status?: unknown;
  selected_rate?: { carrier?: unknown; service?: unknown; rate?: unknown; currency?: unknown };
  postage_label?: { label_url?: unknown; label_pdf_url?: unknown };
  tracker?: {
    status?: unknown;
    public_url?: unknown;
    est_delivery_date?: unknown;
    tracking_details?: { status?: unknown; message?: unknown; datetime?: unknown }[];
  };
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const numeric = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = text(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * A tracker status, or `unknown`.
 *
 * Checked against the declared set rather than passed through: the column is a
 * select, and a value outside its choices is one the admin renders as a blank
 * chip with nothing to say why.
 */
const status = (v: unknown): string => {
  const s = text(v);
  return s && (TRACKER_STATUSES as readonly string[]).includes(s) ? s : "unknown";
};

/** A date EasyPost sent, as epoch ms — the shape every timestamp column takes. */
const epoch = (v: unknown): number | null => {
  const s = text(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
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
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as {
      error?: { message?: unknown; code?: unknown; errors?: { field?: unknown; message?: unknown }[] };
    };
    const field = body.error?.errors?.find((e) => text(e?.message));
    detail = (
      text(field?.message) ? `${text(field?.field) ?? "field"}: ${text(field?.message)}` : text(body.error?.message) ?? detail
    ).slice(0, 200);
  } catch {
    // Not JSON — a gateway in front of the API answers HTML on some failures,
    // and the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error("EasyPost rejected the API key — check it, and that it is not a disabled key");
  }
  if (res.status === 402) {
    return new Error("EasyPost refused the purchase for billing reasons — check the account's balance");
  }
  if (res.status === 404) {
    return new Error(`EasyPost has no such shipment and could not ${what}`);
  }
  return new Error(`EasyPost responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};
