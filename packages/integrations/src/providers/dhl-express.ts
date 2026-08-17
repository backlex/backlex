import { defineProvider } from "../provider";
import {
  parcelSettingFields,
  readParcel,
  readShipFrom,
  readShipTo,
  shipFromConfigFields,
  shipToSettingFields,
  type PostalAddress,
} from "../address";

/**
 * DHL Express — booking a parcel and getting its label, through the MyDHL API.
 *
 * ## Why this is a second DHL card and not a task on the first
 *
 * `./dhl` already exists and tracks parcels. It is a DIFFERENT product: the
 * **Shipment Tracking – Unified** API on `api-eu.dhl.com`, self-serve, one
 * consumer key, fronting sixteen DHL divisions. This file calls **MyDHL API**
 * on `express.api.dhl.com` — different host, Basic auth instead of a key, and
 * a contract account number. Every other provider in this registry is one API
 * with one credential set, and folding two products into one card would make
 * the capability matrix depend on which service the row happens to name.
 *
 * The tracking file says booking would arrive "when somebody has the portal
 * account", and for **DHL eCommerce Türkiye** that is still true — its bodies
 * live in a spec ZIP behind an IBM API Connect login. It is not true for
 * Express: DHL publishes the whole MyDHL contract as OpenAPI 3.0.0 at
 * `developer.dhl.com/sites/default/files/2026-07/dpdhl-express-api-3.3.1.yaml`
 * (v3.3.1, released 2026-06-28), and every field below was read out of that
 * spec rather than reconstructed from prose.
 *
 * ## Tracking a parcel booked here
 *
 * With `./dhl`, and with `service=express` — NOT `ecommerce-tr`. MyDHL books
 * DHL **Express** consignments, while the tracking card's flagship division is
 * the Turkish eCommerce one, so a booking made here is invisible to a poll
 * configured for that service. The two cards are the same company and not the
 * same parcel network, and the tracking number this task returns is an Express
 * waybill.
 *
 * ## Why there is no cancel task
 *
 * Because DHL Express has no such endpoint. In all 22,726 lines of the spec
 * there is exactly one `delete:` operation and it is
 * `/pickups/{dispatchConfirmationNumber}` — it cancels the courier's
 * COLLECTION, not the shipment. No shipment-tagged operation mentions cancel,
 * void or delete, and DHL's guidance is to discard an unused label: billing
 * happens when the parcel is collected, not when the label is made.
 *
 * So this ships book-and-label, and the docs say plainly that an unused label
 * is thrown away rather than voided. A task called `cancel_shipment` that
 * merely cancelled a pickup would be worse than its absence — the label would
 * stay valid, the parcel would still travel, and the operator would believe
 * otherwise. `./aras` ships book and cancel with no tracking, and `./dhl`
 * ships tracking with no booking, so "some of a carrier's tasks" is the
 * established answer here rather than a compromise invented for this file.
 *
 * ## Why the environment is a setting, unlike EasyPost
 *
 * `./easypost` says test mode "is the key, not a setting" — an `EZTK…` key
 * transacts against the sandbox by itself. MyDHL is the other way round: the
 * same credentials address `…/mydhlapi/test` and `…/mydhlapi`, so the
 * environment is a genuine choice and has to be one here. Getting it wrong is
 * expensive in one direction only — a production booking is a real consignment
 * and a real invoice — so it is a picker with test first, and nothing is
 * inferred.
 */

/** Where MyDHL answers. Test and production are the same credentials at
 *  different paths, which is why the operator has to choose. */
const HOSTS: Record<string, string> = {
  test: "https://express.api.dhl.com/mydhlapi/test",
  production: "https://express.api.dhl.com/mydhlapi",
};

/**
 * The contract version this file was written against, sent on every request.
 *
 * `x-version` is `required: true` on `POST /shipments` and easy to miss — the
 * spec declares it as a shared `$ref`'d parameter rather than inline, so it
 * does not appear beside the operation's own arguments. Pinning it means a
 * later DHL default cannot silently change what the request means.
 */
const API_VERSION = "3.3.1";

const text = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/** Base64 to bytes, the way `./bigquery` already does it — `Buffer` is not
 *  available on every runtime this package ships to. */
const fromBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

interface Connection {
  base: string;
  headers: Record<string, string>;
  accountNumber: string;
}

/**
 * Read the connection, refusing early and by name.
 *
 * Every one of these is missing on a connection made before this provider
 * existed, and MyDHL answers a missing credential with a bare 401 that reads
 * as "wrong password" rather than "you never filled this in".
 */
const readConnection = (ctx: {
  str(key: string): string | null;
}): Connection => {
  const username = ctx.str("username");
  const password = ctx.str("password");
  if (!username || !password) {
    throw new Error(
      "DHL Express needs the MyDHL API username and password — these are the API credentials from your DHL Express account, not your MyDHL web login",
    );
  }
  const accountNumber = ctx.str("accountNumber");
  if (!accountNumber) {
    throw new Error("DHL Express needs the shipper account number to bill the consignment to");
  }
  const env = ctx.str("environment") ?? "test";
  const base = HOSTS[env];
  if (!base) {
    throw new Error(`DHL Express has no "${env}" environment — choose test or production`);
  }
  return {
    base,
    accountNumber,
    headers: {
      // `btoa` rather than Buffer: this package runs on Workers too, and the
      // credentials are ASCII by DHL's own field definitions.
      authorization: `Basic ${btoa(`${username}:${password}`)}`,
      "content-type": "application/json",
      accept: "application/json",
      "x-version": API_VERSION,
    },
  };
};

/**
 * MyDHL's timestamp, which is not ISO 8601 and will be read as such by anyone
 * who does not check: `2019-08-04T14:00:31GMT+01:00` — the offset is appended
 * to the literal `GMT`, with no space and no colon-less variant accepted.
 * `toISOString()` produces `…Z` and DHL rejects it.
 *
 * Sent as UTC because the pickup window here is DHL's to schedule; the offset
 * is part of the format rather than a choice this provider makes.
 */
const dhlTimestamp = (at: Date): string =>
  `${at.toISOString().replace(/\.\d{3}Z$/, "")}GMT+00:00`;

/**
 * A `PostalAddress` as MyDHL wants it.
 *
 * Two mappings worth naming. `companyName` is REQUIRED by the spec while the
 * shared shape allows a person with no company, so the recipient's own name
 * stands in — a blank there is a validation error, and DHL does not mind the
 * two agreeing. And the shared `state` becomes `provinceCode`, which DHL
 * documents as a code rather than a name; it is optional, so a full name is
 * passed through rather than guessed at.
 */
const wireAddress = (a: PostalAddress, who: string) => {
  const missing = (["city", "postcode", "country"] as const).filter((k) => !a[k]);
  if (missing.length) {
    throw new Error(
      `DHL Express requires a city, postcode and country on the ${who} address — missing: ${missing.join(", ")}`,
    );
  }
  return {
    postalAddress: {
      postalCode: a.postcode!,
      cityName: a.city!,
      countryCode: a.country!,
      addressLine1: a.street1,
      ...(a.street2 ? { addressLine2: a.street2 } : {}),
      ...(a.state ? { provinceCode: a.state } : {}),
    },
    contactInformation: {
      phone: a.phone ?? "",
      companyName: a.company ?? a.name,
      fullName: a.name,
    },
  };
};

/**
 * Turn a MyDHL failure into something an operator can act on.
 *
 * The body is RFC-7807-shaped, and `detail` is the field worth surfacing: DHL
 * puts a JSON pointer in it (`#/customerDetails/shipperDetails: required key
 * [countryCode] not found`), which names the setting to go and fix. `title`
 * alone is "Validation error" and helps nobody.
 */
const readError = async (res: Response, what: string): Promise<Error> => {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw) as {
      detail?: unknown;
      title?: unknown;
      message?: unknown;
      additionalDetails?: unknown;
    };
    const extra = Array.isArray(body.additionalDetails)
      ? body.additionalDetails.map(text).filter(Boolean).join("; ")
      : null;
    detail = (text(body.detail) ?? extra ?? text(body.title) ?? text(body.message) ?? detail).slice(0, 300);
  } catch {
    // Not JSON — a gateway in front of MyDHL answers HTML on some failures,
    // and the truncated body is still the most useful thing to show.
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      "DHL Express rejected the credentials — check the MyDHL API username and password, and that the account is enabled for the environment you chose",
    );
  }
  return new Error(`DHL Express responded ${res.status} and could not ${what}${detail ? `: ${detail}` : ""}`);
};

export const dhlExpress = defineProvider({
  id: "dhl-express",
  label: "DHL Express",
  category: "carrier",
  capabilities: ["task"],
  /**
   * MyDHL publishes no public rate limit, and a booking is one call per
   * consignment rather than a poll, so this paces conservatively rather than
   * inventing a number: booking is not the kind of call an operator makes in
   * bursts, and a courier API answering 429 mid-flow is worse than waiting.
   */
  limits: { rps: 2, burst: 2 },
  configFields: [
    { key: "username", label: "MyDHL API username", secret: true },
    { key: "password", label: "MyDHL API password", secret: true },
    {
      key: "accountNumber",
      label: "DHL account number",
      placeholder: "the 9-digit Express account the consignment is billed to",
    },
    {
      key: "environment",
      label: "Environment",
      /**
       * Test first, deliberately. The two environments are the same
       * credentials at different paths, so a wrong default is not a failed
       * request — it is a real consignment and a real invoice.
       */
      options: [
        { value: "test", label: "Test" },
        { value: "production", label: "Production" },
      ],
    },
    ...shipFromConfigFields(),
  ],
  tasks: [
    {
      id: "book_shipment",
      label: "Book shipment",
      settingFields: [
        {
          key: "productCode",
          /**
           * Free text, unlike most closed sets here, and for the reason
           * `./ptt` gives about its own: the valid values are account- and
           * lane-specific — which products a payer may buy between two
           * countries is answered by `/products`, not by a constant — so a
           * dropdown would be a list of guesses, and a guess rendered as a
           * closed choice reads as a promise.
           */
          label: "Product code",
          placeholder: "DHL's service code, e.g. D for Express Worldwide",
        },
        ...shipToSettingFields(),
        // MyDHL carries the unit in the request rather than fixing it, and
        // this provider sends metric — so the hints have to say so, or a 5 kg
        // parcel gets booked as 5 lb.
        ...parcelSettingFields({ weight: "kilograms", length: "centimetres" }),
        {
          key: "descriptionField",
          label: "Contents description field (optional)",
          placeholder: "the row field describing what is in the box",
        },
      ],
      outputs: [
        { key: "trackingNumber", label: "Tracking number" },
        { key: "trackingUrl", label: "Tracking URL" },
        /**
         * Kept even though this provider offers no cancel task: it is what
         * `/pickups/{n}` would need, and an operator who has to telephone DHL
         * about a collection is asked for exactly this number.
         */
        { key: "dispatchConfirmationNumber", label: "Pickup confirmation number" },
        { key: "packageCount", label: "Packages" },
        { key: "label", label: "Label", artifact: true },
      ],
      async run(ctx) {
        const conn = readConnection(ctx);
        const productCode = ctx.setting("productCode");
        if (!productCode) {
          throw new Error("DHL Express needs a product code to book — set it on the step");
        }
        const parcel = readParcel(ctx, "kilograms");
        const descriptionField = ctx.setting("descriptionField");
        const description =
          (descriptionField ? text(ctx.row[descriptionField]) : null) ?? "Goods";

        const body = {
          plannedShippingDateAndTime: dhlTimestamp(new Date()),
          // `isRequested: false` books the consignment WITHOUT asking a
          // courier to come for it — the operator drops it off, or already has
          // a standing collection. Requesting one from a row write would
          // schedule a van off the back of a database insert.
          pickup: { isRequested: false },
          productCode,
          accounts: [{ typeCode: "shipper", number: conn.accountNumber }],
          customerDetails: {
            shipperDetails: wireAddress(readShipFrom(ctx, "DHL Express"), "ship-from"),
            receiverDetails: wireAddress(readShipTo(ctx, "DHL Express"), "recipient"),
          },
          content: {
            packages: [
              {
                weight: parcel.weight,
                ...(parcel.length && parcel.width && parcel.height
                  ? {
                      dimensions: {
                        length: parcel.length,
                        width: parcel.width,
                        height: parcel.height,
                      },
                    }
                  : {}),
              },
            ],
            // A domestic consignment is not customs-declarable and DHL refuses
            // the declaration fields that would come with it. Two different
            // countries is the whole test.
            isCustomsDeclarable: false,
            description,
            incoterm: "DAP",
            unitOfMeasurement: "metric",
          },
        };

        const res = await ctx.fetch(`${conn.base}/shipments`, {
          method: "POST",
          headers: conn.headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) throw await readError(res, "book the shipment");
        const out = (await res.json()) as {
          shipmentTrackingNumber?: unknown;
          trackingUrl?: unknown;
          dispatchConfirmationNumber?: unknown;
          packages?: unknown[];
          documents?: { typeCode?: unknown; content?: unknown; imageFormat?: unknown }[];
        };

        const trackingNumber = text(out.shipmentTrackingNumber);
        if (!trackingNumber) {
          throw new Error("DHL Express accepted the booking but returned no tracking number");
        }

        // `typeCode` is free text in the spec with `label` as its example, so
        // the label is found by name rather than by position — the array also
        // carries invoices and receipts when those were requested, and taking
        // documents[0] would attach whichever DHL happened to list first.
        const label = (out.documents ?? []).find(
          (d) => text(d?.typeCode)?.toLowerCase() === "label",
        );
        const content = text(label?.content);
        // `imageFormat` is DHL's string, and it reaches both a filename and a
        // content type. Constrained to the formats DHL documents rather than
        // passed through: an unexpected value would otherwise be interpolated
        // into a storage key, and a label is not the place to find out that a
        // response body can name a path.
        const raw = (text(label?.imageFormat) ?? "PDF").toLowerCase();
        const format = ["pdf", "png", "zpl", "epl", "lp2"].includes(raw) ? raw : "pdf";

        return {
          outputs: {
            trackingNumber,
            trackingUrl: text(out.trackingUrl),
            dispatchConfirmationNumber: text(out.dispatchConfirmationNumber),
            packageCount: Array.isArray(out.packages) ? out.packages.length : 1,
          },
          ...(content
            ? {
                artifact: {
                  outputKey: "label",
                  filename: `${trackingNumber}.${format}`,
                  contentType: format === "pdf" ? "application/pdf" : `image/${format}`,
                  bytes: fromBase64(content),
                },
              }
            : {}),
        };
      },
    },
  ],
});
