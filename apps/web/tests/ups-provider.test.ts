/**
 * UPS — the sixth carrier, and two firsts for this engine.
 *
 * It is the first provider that mints its own token (client-credentials, which
 * `IntegrationOAuth` cannot express because there is no user to redirect), and
 * it is the second user of the shared address shape — the reason `../address`
 * was lifted out of EasyPost at all.
 *
 * What is UPS's own and worth pinning: the token is cached and re-minted when
 * the secret rotates, every call carries transId + transactionSrc, the answer
 * is an object for one package and an array for several throughout, the label
 * arrives as base64 rather than a URL, and a label that cannot be decoded must
 * NOT fail a run whose shipment is already booked.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  INTEGRATION_KINDS,
  INTEGRATION_TASKS,
  resetUpsTokens,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = {
  clientId: "cid",
  clientSecret: "csecret",
  accountNumber: "A1B2C3",
  environment: "test",
  fromName: "Acme Depo",
  fromStreet1: "Bağdat Cad. 1",
  fromCity: "İstanbul",
  fromZip: "34710",
  fromCountry: "TR",
  fromPhone: "5551112233",
  weightUnit: "KGS",
  lengthUnit: "CM",
};

const ROW = {
  id: "f1",
  ship_to_name: "Ahmet Aslan",
  ship_to_street: "Atatürk Bul. 5",
  ship_to_city: "Ankara",
  ship_to_state: "",
  ship_to_zip: 6510,
  ship_to_country: "tr",
  ship_to_phone: "5559998877",
  parcel_kg: 2.5,
  parcel_len: 30,
  parcel_wid: 20,
  parcel_hei: 10,
  carrier_shipment_id: "1Z0000000000000000",
};

const BOOK_SETTINGS = {
  service: "11",
  packaging: "02",
  toNameField: "ship_to_name",
  toStreet1Field: "ship_to_street",
  toCityField: "ship_to_city",
  toStateField: "ship_to_state",
  toZipField: "ship_to_zip",
  toCountryField: "ship_to_country",
  toPhoneField: "ship_to_phone",
  weightField: "parcel_kg",
  lengthField: "parcel_len",
  widthField: "parcel_wid",
  heightField: "parcel_hei",
  labelFormat: "PDF",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** The token exchange every run begins with, unless a spec says otherwise. */
const TOKEN = { body: { access_token: "tok-1", expires_in: "3600" } };

const recorder = (responses: { status?: number; body: unknown }[]) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const next = responses[i++] ?? { body: {} };
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
};

const runTask = (
  task: string,
  opts: {
    fetchImpl: any;
    row?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    config?: Record<string, unknown>;
    idempotencyKey?: string;
  },
) =>
  runIntegrationTask(
    "ups",
    task,
    {
      config: opts.config ?? CONFIG,
      settings: opts.settings ?? {},
      row: opts.row ?? ROW,
      idempotencyKey: opts.idempotencyKey ?? "run-1:abc",
    },
    opts.fetchImpl,
  );

beforeEach(() => {
  // The cache is per-isolate and would otherwise leak a token between specs,
  // hiding the exchange the next test is about to assert on.
  resetUpsTokens();
});

const booked = (label = btoa("%PDF-1.4 fake")) => ({
  body: {
    ShipmentResponse: {
      Response: { ResponseStatus: { Code: "1", Description: "Success" } },
      ShipmentResults: {
        ShipmentIdentificationNumber: "1Z0000000000000000",
        BillingWeight: { UnitOfMeasurement: { Code: "KGS" }, Weight: "3.0" },
        ShipmentCharges: { TotalCharges: { CurrencyCode: "TRY", MonetaryValue: "184.50" } },
        // One package answers as an OBJECT, not a one-element array.
        PackageResults: {
          TrackingNumber: "1Z0000000000000001",
          ShippingLabel: { ImageFormat: { Code: "PDF" }, GraphicImage: label },
        },
      },
    },
  },
});

describe("what UPS declares", () => {
  test("it is a registered carrier with three tasks, and only tracking repeats", () => {
    expect(INTEGRATION_KINDS).toContain("ups");
    expect(INTEGRATION_TASKS.ups?.map((t) => t.id)).toEqual([
      "book_shipment",
      "refresh_tracking",
      "cancel_shipment",
    ]);
    expect(INTEGRATION_TASKS.ups?.filter((t) => t.repeatable).map((t) => t.id)).toEqual(["refresh_tracking"]);
  });

  test("it reuses EasyPost's address keys verbatim — they are a stored contract", () => {
    const book = INTEGRATION_TASKS.ups?.find((t) => t.id === "book_shipment");
    const keys = new Set((book?.settingFields ?? []).map((f) => f.key));
    // Renaming one of these would silently blank a configured field on somebody's
    // running flow, which is the whole reason the shape was lifted rather than
    // re-invented.
    for (const k of ["toNameField", "toStreet1Field", "toZipField", "toCountryField", "weightField", "heightField"]) {
      expect(keys.has(k)).toBe(true);
    }
    expect(book?.outputs.find((o) => o.artifact)?.key).toBe("labelKey");
  });
});

describe("minting and reusing the token", () => {
  test("the first call exchanges the credentials, and the second reuses the token", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, booked(), booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const token = calls[0]!;
    expect(token.url).toBe("https://wwwcie.ups.com/security/v1/oauth/token");
    expect(token.method).toBe("POST");
    expect(token.headers.Authorization).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(token.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(token.body).toBe("grant_type=client_credentials");

    // Three calls, not four: token, ship, ship.
    expect(calls.length).toBe(3);
    expect(calls[1]!.headers.Authorization).toBe("Bearer tok-1");
    expect(calls[2]!.headers.Authorization).toBe("Bearer tok-1");
  });

  test("a rotated secret mints a new token instead of serving the old one", async () => {
    const { calls, fetchImpl } = recorder([
      TOKEN,
      booked(),
      { body: { access_token: "tok-2", expires_in: "3600" } },
      booked(),
    ]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    await runTask("book_shipment", {
      fetchImpl,
      settings: BOOK_SETTINGS,
      config: { ...CONFIG, clientSecret: "rotated" },
    });

    // The cache is keyed by the credential PAIR, so the rotation is a miss.
    expect(calls.length).toBe(4);
    expect(calls[2]!.url).toContain("/oauth/token");
    expect(calls[3]!.headers.Authorization).toBe("Bearer tok-2");
  });

  test("an expiry UPS did not give is treated as short, never as forever", async () => {
    const { calls, fetchImpl } = recorder([{ body: { access_token: "tok-1" } }, booked(), booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    // Still cached for the fallback window — the point is that it has an end at
    // all, because a token cached past its death 401s until the isolate recycles.
    expect(calls.length).toBe(3);
  });

  test("the environment picker chooses the host", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, booked()]);
    await runTask("book_shipment", {
      fetchImpl,
      settings: BOOK_SETTINGS,
      config: { ...CONFIG, environment: "production" },
    });
    expect(calls[0]!.url.startsWith("https://onlinetools.ups.com/")).toBe(true);
    expect(calls[1]!.url.startsWith("https://onlinetools.ups.com/")).toBe(true);
  });
});

describe("booking a shipment", () => {
  test("the request carries the two required headers and the account twice", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const ship = calls[1]!;
    expect(ship.url).toBe("https://wwwcie.ups.com/api/shipments/v2409/ship");
    // Both are required on every UPS endpoint.
    expect(ship.headers.transId).toBe("run-1abc");
    expect(ship.headers.transactionSrc).toBe("backlex");

    const sent = JSON.parse(ship.body).ShipmentRequest;
    // UPS wants the account as the shipper's number AND in the payment
    // instruction — omitting either is a rejection about billing.
    expect(sent.Shipment.Shipper.ShipperNumber).toBe("A1B2C3");
    expect(sent.Shipment.PaymentInformation.ShipmentCharge.BillShipper.AccountNumber).toBe("A1B2C3");
    expect(sent.Shipment.Service.Code).toBe("11");
    expect(sent.LabelSpecification.LabelImageFormat.Code).toBe("PDF");
  });

  test("the shared address shape reaches UPS's own field names", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const to = JSON.parse(calls[1]!.body).ShipmentRequest.Shipment.ShipTo;
    expect(to.AttentionName).toBe("Ahmet Aslan");
    // The street is an AddressLine array here and `street1` at EasyPost — the
    // translation is each provider's, which is what keeps the shared module a
    // description of an address rather than a union of two wire formats.
    expect(to.Address.AddressLine).toEqual(["Atatürk Bul. 5"]);
    expect(to.Address.City).toBe("Ankara");
    // A numeric postcode column is still a postcode.
    expect(to.Address.PostalCode).toBe("6510");
    // Upper-cased from the row's "tr".
    expect(to.Address.CountryCode).toBe("TR");
    expect(to.Phone.Number).toBe("5559998877");
    // An empty state must not travel as an empty string.
    expect(to.Address.StateProvinceCode).toBeUndefined();

    const from = JSON.parse(calls[1]!.body).ShipmentRequest.Shipment.Shipper;
    expect(from.AttentionName).toBe("Acme Depo");
    expect(from.Address.CountryCode).toBe("TR");
  });

  test("every measure carries the unit the connection chose", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const pkg = JSON.parse(calls[1]!.body).ShipmentRequest.Shipment.Package;
    expect(pkg.Packaging.Code).toBe("02");
    // This is the one real difference from EasyPost, where ounces and inches are
    // implied — here the same numbers mean what the operator said they mean.
    expect(pkg.PackageWeight).toEqual({ UnitOfMeasurement: { Code: "KGS" }, Weight: "2.5" });
    expect(pkg.Dimensions).toEqual({
      UnitOfMeasurement: { Code: "CM" },
      Length: "30",
      Width: "20",
      Height: "10",
    });
  });

  test("a partial dimension set is sent as none at all", async () => {
    // UPS rejects two of three, and the rejection names the box rather than the
    // column nobody mapped.
    const { calls, fetchImpl } = recorder([TOKEN, booked()]);
    await runTask("book_shipment", {
      fetchImpl,
      settings: { ...BOOK_SETTINGS, heightField: undefined },
    });
    const pkg = JSON.parse(calls[1]!.body).ShipmentRequest.Shipment.Package;
    expect(pkg.Dimensions).toBeUndefined();
    expect(pkg.PackageWeight.Weight).toBe("2.5");
  });

  test("the label is decoded from base64 and stored under the format that was asked for", async () => {
    const { fetchImpl } = recorder([TOKEN, booked()]);
    const result = await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    expect(result.outputs.shipmentId).toBe("1Z0000000000000000");
    // Read out of the OBJECT form of PackageResults.
    expect(result.outputs.trackingNumber).toBe("1Z0000000000000001");
    expect(result.outputs.rate).toBe("184.50");
    expect(result.outputs.currency).toBe("TRY");
    expect(result.outputs.billingWeight).toBe("3.0");

    expect(result.artifact?.outputKey).toBe("labelKey");
    expect(result.artifact?.filename).toBe("1Z0000000000000001.pdf");
    expect(result.artifact?.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(result.artifact!.bytes)).toBe("%PDF-1.4 fake");
  });

  test("a printer-language label is stored under its own extension, not sniffed as text", async () => {
    const { fetchImpl } = recorder([TOKEN, booked(btoa("^XA^FO50,50^XZ"))]);
    const result = await runTask("book_shipment", {
      fetchImpl,
      settings: { ...BOOK_SETTINGS, labelFormat: "ZPL" },
    });
    // ZPL looks like plain text; a stored `.txt` a warehouse cannot send to its
    // printer is a label nobody can use.
    expect(result.artifact?.filename).toBe("1Z0000000000000001.zpl");
  });

  test("a label that cannot be decoded does NOT fail a run whose postage is already paid", async () => {
    // Failing here would roll the run back to `failed`, which the queue retries,
    // which books a SECOND shipment. A missing label is a nuisance; a second
    // consignment is money and a confused courier.
    const { fetchImpl } = recorder([TOKEN, booked("!!! not base64 !!!")]);
    const result = await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    expect(result.outputs.trackingNumber).toBe("1Z0000000000000001");
    expect(result.artifact).toBeUndefined();
  });

  test("an accepted shipment with no tracking number is a failure, not an empty column", async () => {
    const { fetchImpl } = recorder([
      TOKEN,
      { body: { ShipmentResponse: { ShipmentResults: { ShipmentIdentificationNumber: "1Z…" } } } },
    ]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /no tracking number/,
    );
  });
});

describe("asking where a parcel is", () => {
  const tracked = {
    body: {
      trackResponse: {
        // An object for one shipment, an array for several — throughout.
        shipment: {
          inquiryNumber: "1Z0000000000000000",
          package: {
            trackingNumber: "1Z0000000000000000",
            packageCount: 1,
            service: { code: "011", description: "UPS Standard" },
            currentStatus: { statusCode: "011", description: "Delivered", type: "D" },
            // Documented as most-recent FIRST, unlike DHL where no order is promised.
            activity: [
              {
                date: "20260810",
                time: "142233",
                location: { address: { city: "Ankara", countryCode: "TR" } },
                status: { statusCode: "011", description: "Delivered", type: "D" },
              },
              {
                date: "20260808",
                time: "071356",
                location: { address: { city: "İstanbul" } },
                status: { statusCode: "005", description: "In transit", type: "I" },
              },
            ],
            deliveryDate: [
              { date: "20260809", type: "SDD" },
              { date: "20260810", type: "RDD" },
              { date: "20260810", type: "DEL" },
            ],
          },
        },
      },
    },
  };

  test("it reads the head of the activity list and UPS's own words beside it", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, tracked]);
    const result = await runTask("refresh_tracking", {
      fetchImpl,
      settings: { trackingNumberField: "carrier_shipment_id" },
    });

    expect(calls[1]!.url).toBe("https://wwwcie.ups.com/api/track/v1/details/1Z0000000000000000");
    expect(calls[1]!.method).toBe("GET");

    expect(result.outputs.shipmentStatus).toBe("011");
    expect(result.outputs.statusDescription).toBe("Delivered");
    // YYYYMMDD + HHMMSS, neither of which has a separator on the wire.
    expect(result.outputs.statusAt).toBe("2026-08-10 14:22:33");
    expect(result.outputs.statusLocation).toBe("Ankara");
    expect(result.outputs.service).toBe("UPS Standard");
  });

  test("a rescheduled delivery date supersedes the scheduled one", async () => {
    const { fetchImpl } = recorder([TOKEN, tracked]);
    const result = await runTask("refresh_tracking", {
      fetchImpl,
      settings: { trackingNumberField: "carrier_shipment_id" },
    });
    // SDD said the 9th; RDD moved it to the 10th, and DEL is when it landed.
    expect(result.outputs.estimatedDeliveryAt).toBe("2026-08-10");
    expect(result.outputs.deliveredAt).toBe("2026-08-10");
  });

  test("a tracking number UPS has never seen is said so", async () => {
    const { fetchImpl } = recorder([TOKEN, { body: { trackResponse: { shipment: [] } } }]);
    await expect(
      runTask("refresh_tracking", { fetchImpl, settings: { trackingNumberField: "carrier_shipment_id" } }),
    ).rejects.toThrow(/no shipment "1Z0000000000000000"/);
  });
});

describe("voiding", () => {
  test("it deletes by the shipment id, not the tracking number", async () => {
    const { calls, fetchImpl } = recorder([
      TOKEN,
      { body: { VoidShipmentResponse: { SummaryResult: { Status: { Code: "1", Description: "Voided" } } } } },
    ]);
    const result = await runTask("cancel_shipment", {
      fetchImpl,
      settings: { shipmentIdField: "carrier_shipment_id" },
    });

    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe("https://wwwcie.ups.com/api/shipments/v2409/void/cancel/1Z0000000000000000");
    expect(result.outputs.shipmentStatus).toBe("cancelled");
    expect(result.outputs.resultMessage).toBe("Voided");
  });
});

describe("the refusals", () => {
  test("a credential with a newline is refused before it can be masked by base64", async () => {
    const { calls, fetchImpl } = recorder([TOKEN, booked()]);
    await expect(
      runTask("book_shipment", {
        fetchImpl,
        settings: BOOK_SETTINGS,
        config: { ...CONFIG, clientId: "cid\r\nX-Evil: 1" },
      }),
    ).rejects.toThrow(/printable ASCII/);
    expect(calls.length).toBe(0);
  });

  test("UPS's error envelope reaches the operator, and 401 says what to check", async () => {
    const bad = recorder([
      { status: 401, body: { response: { errors: [{ code: "10401", message: "Invalid Access License number" }] } } },
    ]);
    await expect(runTask("book_shipment", { fetchImpl: bad.fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /rejected the credentials/,
    );

    const rejected = recorder([
      TOKEN,
      { status: 400, body: { response: { errors: [{ code: "120100", message: "Missing or invalid shipper number" }] } } },
    ]);
    await expect(
      runTask("book_shipment", { fetchImpl: rejected.fetchImpl, settings: BOOK_SETTINGS }),
    ).rejects.toThrow(/Missing or invalid shipper number/);
  });

  test("a country column holding a display name names the column, not the country field", async () => {
    const { fetchImpl } = recorder([TOKEN, booked()]);
    await expect(
      runTask("book_shipment", {
        fetchImpl,
        settings: BOOK_SETTINGS,
        row: { ...ROW, ship_to_country: "Türkiye" },
      }),
    ).rejects.toThrow(/is not a country code/);
  });

  test("a row with no weight says which setting to point at", async () => {
    const { fetchImpl } = recorder([TOKEN, booked()]);
    await expect(
      runTask("book_shipment", { fetchImpl, settings: { ...BOOK_SETTINGS, weightField: undefined } }),
    ).rejects.toThrow(/no parcel weight/);
  });
});
