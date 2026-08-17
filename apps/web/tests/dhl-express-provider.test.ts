/**
 * DHL Express — book a parcel through the MyDHL API and keep its label.
 *
 * The fifth carrier, and the second DHL card: `./dhl` tracks parcels through
 * the Shipment Tracking Unified API on a self-serve consumer key, this books
 * them through MyDHL on Basic auth and a contract account. Different host,
 * different credential, different product.
 *
 * Every request-shape assertion below is read out of DHL's own OpenAPI 3.0.0
 * spec (`dpdhl-express-api-3.3.1.yaml`, v3.3.1, released 2026-06-28) rather
 * than from prose — which matters, because three of the things it pins are
 * exactly the ones a reasonable person would get wrong:
 *
 *   - `plannedShippingDateAndTime` is NOT ISO 8601. `2019-08-04T14:00:31GMT+01:00`
 *     is the format, and `toISOString()` produces something DHL rejects.
 *   - `x-version` is `required: true`, and the spec declares it as a shared
 *     `$ref`'d parameter, so it does not appear beside the operation's own
 *     arguments and is easy to miss.
 *   - the label is found in `documents[]` BY `typeCode`, not by position — the
 *     array also carries invoices and receipts when those were asked for.
 *
 * And the thing this provider deliberately does NOT have: a cancel task. There
 * is no shipment cancel/void/delete anywhere in MyDHL — the sole `delete:` in
 * 22,726 lines cancels a courier PICKUP. A `cancel_shipment` that quietly
 * cancelled a collection would leave the label valid and the parcel travelling.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  INTEGRATION_KINDS,
  INTEGRATION_TASKS,
  resetThrottleState,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = {
  username: "api-user",
  password: "api-pass",
  accountNumber: "123456789",
  environment: "test",
  fromName: "Acme Depo",
  fromCompany: "Acme A.Ş.",
  fromStreet1: "Barbaros Mah. 1",
  fromCity: "İstanbul",
  fromZip: "34746",
  fromCountry: "TR",
  fromPhone: "+902161234567",
};

const SETTINGS = {
  productCode: "D",
  toNameField: "ship_to_name",
  toStreet1Field: "ship_to_street",
  toCityField: "ship_to_city",
  toZipField: "ship_to_zip",
  toCountryField: "ship_to_country",
  toPhoneField: "ship_to_phone",
  weightField: "weight_kg",
};

const ROW = {
  id: "r1",
  ship_to_name: "Jane Doe",
  ship_to_street: "10 Downing Street",
  ship_to_city: "London",
  ship_to_zip: "SW1A 2AA",
  ship_to_country: "GB",
  ship_to_phone: "+442079250918",
  weight_kg: 2.5,
};

/** A one-pixel PDF's worth of bytes, base64'd the way DHL returns a label. */
const LABEL_B64 = btoa("%PDF-1.4 fake");

const CREATED = {
  shipmentTrackingNumber: "1234567890",
  trackingUrl: "https://www.dhl.com/track?id=1234567890",
  dispatchConfirmationNumber: "AMS-0001234",
  packages: [{ referenceNumber: 1, trackingNumber: "JD0000001" }],
  documents: [
    { typeCode: "invoice", imageFormat: "PDF", content: btoa("invoice") },
    { typeCode: "label", imageFormat: "PDF", content: LABEL_B64 },
  ],
};

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
}

const recorder = (respond: () => Response) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return respond();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
};

const ok = () =>
  new Response(JSON.stringify(CREATED), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

const book = (
  respond: () => Response,
  over: { config?: Record<string, unknown>; settings?: Record<string, unknown>; row?: Record<string, unknown> } = {},
) => {
  const { sent, fetchImpl } = recorder(respond);
  return {
    sent,
    run: runIntegrationTask(
      "dhl-express",
      "book_shipment",
      {
        config: { ...CONFIG, ...(over.config ?? {}) },
        settings: { ...SETTINGS, ...(over.settings ?? {}) },
        row: { ...ROW, ...(over.row ?? {}) },
        idempotencyKey: "idem-1",
      },
      fetchImpl,
    ),
  };
};

beforeEach(() => resetThrottleState());

describe("registration", () => {
  test("it is a registered kind with exactly one task", () => {
    expect(INTEGRATION_KINDS).toContain("dhl-express");
    // The pre-existing tracking provider is a DIFFERENT card and stays.
    expect(INTEGRATION_KINDS).toContain("dhl");
    expect(INTEGRATION_TASKS["dhl-express"]?.map((t) => t.id)).toEqual(["book_shipment"]);
  });

  test("there is deliberately no cancel task", () => {
    // MyDHL has no shipment cancel/void/delete. The only `delete:` in the spec
    // cancels a courier PICKUP, which leaves the label valid and the parcel
    // travelling — so a task by that name would be a false promise, not a
    // partial one.
    const ids = INTEGRATION_TASKS["dhl-express"]!.map((t) => t.id);
    expect(ids).not.toContain("cancel_shipment");
    expect(ids).not.toContain("cancel_pickup");
  });
});

describe("the request DHL actually accepts", () => {
  test("it posts to the TEST host when the environment says so", async () => {
    const { sent, run } = book(ok);
    await run;
    expect(sent[0]!.url).toBe("https://express.api.dhl.com/mydhlapi/test/shipments");
  });

  test("production is a different PATH, not a different key", async () => {
    // Unlike EasyPost, where the test mode is the key itself. Getting this
    // wrong is expensive in one direction: a real consignment and a real
    // invoice.
    const { sent, run } = book(ok, { config: { environment: "production" } });
    await run;
    expect(sent[0]!.url).toBe("https://express.api.dhl.com/mydhlapi/shipments");
  });

  test("`x-version` is sent — it is required and easy to miss", async () => {
    const { sent, run } = book(ok);
    await run;
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers["x-version"]).toBe("3.3.1");
  });

  test("auth is Basic, built from the username and password", async () => {
    const { sent, run } = book(ok);
    await run;
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("api-user:api-pass")}`);
  });

  test("the timestamp is DHL's format, not ISO 8601", async () => {
    // `2019-08-04T14:00:31GMT+01:00`. An `…Z` suffix is rejected.
    const { sent, run } = book(ok);
    await run;
    const stamp = sent[0]!.body.plannedShippingDateAndTime as string;
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}GMT[+-]\d{2}:\d{2}$/);
    expect(stamp).not.toContain("Z");
  });

  test("every required member of the body is present", async () => {
    // The spec's own `required` list on the create-shipment request.
    const { sent, run } = book(ok);
    await run;
    for (const key of [
      "plannedShippingDateAndTime",
      "pickup",
      "productCode",
      "accounts",
      "customerDetails",
      "content",
    ]) {
      expect(`${key}: ${key in sent[0]!.body}`).toBe(`${key}: true`);
    }
  });

  test("the addresses carry the four required postal fields and a contact", async () => {
    const { sent, run } = book(ok);
    await run;
    const to = sent[0]!.body.customerDetails.receiverDetails;
    expect(to.postalAddress).toMatchObject({
      postalCode: "SW1A 2AA",
      cityName: "London",
      countryCode: "GB",
      addressLine1: "10 Downing Street",
    });
    // `companyName` is required by the spec and the shared address shape lets
    // a person have none, so the recipient's own name stands in.
    expect(to.contactInformation).toMatchObject({
      fullName: "Jane Doe",
      companyName: "Jane Doe",
      phone: "+442079250918",
    });
    const from = sent[0]!.body.customerDetails.shipperDetails;
    expect(from.contactInformation.companyName).toBe("Acme A.Ş.");
  });

  test("it books the account as shipper, and sends metric", async () => {
    const { sent, run } = book(ok);
    await run;
    expect(sent[0]!.body.accounts).toEqual([{ typeCode: "shipper", number: "123456789" }]);
    expect(sent[0]!.body.content.unitOfMeasurement).toBe("metric");
    expect(sent[0]!.body.content.packages).toEqual([{ weight: 2.5 }]);
  });

  test("it does NOT ask a courier to collect", async () => {
    // Requesting a pickup would schedule a van off the back of a row write.
    const { sent, run } = book(ok);
    await run;
    expect(sent[0]!.body.pickup).toEqual({ isRequested: false });
  });

  test("dimensions ride along only when all three are given", async () => {
    const partial = book(ok, {
      settings: { lengthField: "l", widthField: "w" },
      row: { l: 10, w: 20 },
    });
    await partial.run;
    expect(partial.sent[0]!.body.content.packages[0].dimensions).toBeUndefined();

    const full = book(ok, {
      settings: { lengthField: "l", widthField: "w", heightField: "h" },
      row: { l: 10, w: 20, h: 30 },
    });
    await full.run;
    expect(full.sent[0]!.body.content.packages[0].dimensions).toEqual({
      length: 10,
      width: 20,
      height: 30,
    });
  });
});

describe("what comes back", () => {
  test("the tracking number and pickup reference are surfaced", async () => {
    const { run } = book(ok);
    const res = await run;
    expect(res.outputs).toMatchObject({
      trackingNumber: "1234567890",
      trackingUrl: "https://www.dhl.com/track?id=1234567890",
      dispatchConfirmationNumber: "AMS-0001234",
      packageCount: 1,
    });
  });

  test("the label is found by typeCode, not by position", async () => {
    // `documents[0]` is the invoice here. Taking the first would attach the
    // wrong file, and it would look right until somebody opened it.
    const { run } = book(ok);
    const res = await run;
    expect(res.artifact?.outputKey).toBe("label");
    expect(res.artifact?.filename).toBe("1234567890.pdf");
    expect(res.artifact?.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(res.artifact!.bytes)).toBe("%PDF-1.4 fake");
  });

  test("an unexpected label format cannot reach the storage key", async () => {
    // `imageFormat` is DHL's string and lands in both a filename and a
    // content type. A response naming a path is not a thing a label should be
    // able to do.
    const { run } = book(
      () =>
        new Response(
          JSON.stringify({
            shipmentTrackingNumber: "555",
            documents: [{ typeCode: "label", imageFormat: "../../etc", content: LABEL_B64 }],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await run;
    expect(res.artifact?.filename).toBe("555.pdf");
    expect(res.artifact?.contentType).toBe("application/pdf");
  });

  test("a booking with no label still books", async () => {
    // Rare, but `documents` is not a required member of the response.
    const { run } = book(
      () =>
        new Response(JSON.stringify({ shipmentTrackingNumber: "999" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await run;
    expect(res.outputs.trackingNumber).toBe("999");
    expect(res.artifact).toBeUndefined();
  });

  test("a 201 with no tracking number is an error, not a silent success", async () => {
    const { run } = book(
      () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
    );
    await expect(run).rejects.toThrow(/no tracking number/);
  });
});

describe("failing usefully", () => {
  test("a missing credential is refused before the round-trip", async () => {
    const { sent, run } = book(ok, { config: { password: "" } });
    await expect(run).rejects.toThrow(/username and password/);
    expect(sent).toHaveLength(0);
  });

  test("a missing account number names itself", async () => {
    const { run } = book(ok, { config: { accountNumber: "" } });
    await expect(run).rejects.toThrow(/account number/);
  });

  test("a missing product code names itself", async () => {
    const { run } = book(ok, { settings: { productCode: "" } });
    await expect(run).rejects.toThrow(/product code/);
  });

  test("an address short of city/postcode/country says which", async () => {
    const { sent, run } = book(ok, { row: { ship_to_zip: "", ship_to_country: "" } });
    await expect(run).rejects.toThrow(/postcode, country/);
    expect(sent).toHaveLength(0);
  });

  test("a validation failure surfaces DHL's own pointer, not just its title", async () => {
    // `detail` names the field to go and fix; `title` is "Validation error"
    // and helps nobody.
    const { run } = book(
      () =>
        new Response(
          JSON.stringify({
            title: "Validation error",
            detail: "#/customerDetails/shipperDetails: required key [countryCode] not found",
            status: "998",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(run).rejects.toThrow(/required key \[countryCode\] not found/);
  });

  test("a rejected credential says so rather than echoing a 401", async () => {
    const { run } = book(() => new Response("", { status: 401 }));
    await expect(run).rejects.toThrow(/rejected the credentials/);
  });
});
