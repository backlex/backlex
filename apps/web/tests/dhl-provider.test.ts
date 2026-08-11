/**
 * DHL — the fourth carrier, and the first that ships as half a carrier.
 *
 * What is DHL's own and worth pinning: the service is required even though the
 * API treats it as optional, the answer is a list only one entry of which
 * belongs to the row, and nothing may depend on the order of `events` — the
 * live API returns them newest-first, which is the opposite of every other
 * carrier here and is promised by neither.
 *
 * The response bodies below are the live API's shape, taken from a probe with
 * the published demo key, trimmed to the fields this provider reads.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  INTEGRATION_KINDS,
  INTEGRATION_TASKS,
  resetThrottleState,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = { apiKey: "key-1" };

const ROW = {
  id: "f1",
  carrier_shipment_id: "00340434292135100186",
  shipping_postcode: "34710",
};

const SETTINGS = {
  trackingNumberField: "carrier_shipment_id",
  service: "ecommerce-tr",
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

const recorder = (responses: { status?: number; body: unknown; contentType?: string }[]) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses[i++] ?? { body: {} };
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": next.contentType ?? "application/json" },
    });
  };
  return { calls, fetchImpl };
};

const runTask = (opts: {
  fetchImpl: any;
  row?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) =>
  runIntegrationTask(
    "dhl",
    "refresh_tracking",
    {
      config: opts.config ?? CONFIG,
      settings: opts.settings ?? SETTINGS,
      row: opts.row ?? ROW,
      idempotencyKey: "run-1:abc",
    },
    opts.fetchImpl,
  );

/**
 * DHL's free tier is one call every five seconds, and the provider paces itself
 * to it. Without this each test after the first would sit out that interval for
 * real — the pacing is the subject of its own spec, not of this one.
 */
beforeEach(() => {
  resetThrottleState();
});

/** The query the provider actually asked. */
const queryOf = (call: Call) => new URL(call.url).searchParams;

const DELIVERED = {
  shipments: [
    {
      id: "00340434292135100186",
      service: "ecommerce",
      origin: { address: { countryCode: "TR", addressLocality: "İSTANBUL" } },
      destination: { address: { countryCode: "TR", addressLocality: "ANKARA" } },
      status: {
        timestamp: "2026-08-08T10:37:00",
        location: { address: { countryCode: "TR", postalCode: "06510", addressLocality: "Çankaya, TR" } },
        statusCode: "delivered",
        status: "DELIVERED",
        description: "TESLİM EDİLDİ - KAPIDA",
      },
      details: { product: { productName: "DHL eCommerce Standart" }, weight: { value: 1.35, unitText: "KG" } },
      serviceUrl: "https://www.dhl.com/tr-tr/home/tracking.html",
      estimatedTimeOfDelivery: "2026-08-08T18:00:00",
      // Newest first, exactly as the live API answers.
      events: [
        { timestamp: "2026-08-08T10:37:00", statusCode: "delivered", status: "DELIVERED" },
        { timestamp: "2026-08-07T06:10:00", statusCode: "transit", status: "OUT FOR DELIVERY" },
        { timestamp: "2026-08-05T14:11:21", statusCode: "pre-transit", status: "LABEL CREATED" },
      ],
    },
  ],
};

describe("what DHL ships, and what it deliberately does not", () => {
  test("it is a registered carrier with exactly one task, and that task is repeatable", () => {
    expect(INTEGRATION_KINDS).toContain("dhl");
    // Booking for Türkiye is still behind a login-gated portal whose request
    // bodies cannot be read, so it is absent rather than guessed at.
    expect(INTEGRATION_TASKS.dhl?.map((t) => t.id)).toEqual(["refresh_tracking"]);
    // Where a parcel is has no side effect and its whole value is that the
    // answer moves; under the once-only guard the row would keep `pre-transit`.
    expect(INTEGRATION_TASKS.dhl?.[0]?.repeatable).toBe(true);
  });

  test("the service is a closed picker whose Turkish entry names MNG Kargo", () => {
    const field = INTEGRATION_TASKS.dhl?.[0]?.settingFields?.find((f) => f.key === "service");
    const tr = field?.options?.find((o) => o.value === "ecommerce-tr");
    // The brand changed in 2025 and an operator still looks for the old name.
    expect(tr?.label).toContain("MNG Kargo");
    // Deprecated, and its queries are rerouted to `svb`, which is listed.
    expect(field?.options?.some((o) => o.value === "post-de")).toBe(false);
    expect(field?.options?.some((o) => o.value === "svb")).toBe(true);
  });
});

describe("asking where a parcel is", () => {
  test("the key travels in a header and the service in the query", async () => {
    const { calls, fetchImpl } = recorder([{ body: DELIVERED }]);
    await runTask({ fetchImpl });

    const call = calls[0]!;
    expect(call.url.startsWith("https://api-eu.dhl.com/track/shipments?")).toBe(true);
    expect(call.headers["DHL-API-Key"]).toBe("key-1");
    const q = queryOf(call);
    expect(q.get("trackingNumber")).toBe("00340434292135100186");
    expect(q.get("service")).toBe("ecommerce-tr");
  });

  test("it writes DHL's coarse code, its own words, and the moment beside them", async () => {
    const { fetchImpl } = recorder([{ body: DELIVERED }]);
    const result = await runTask({ fetchImpl });

    expect(result.outputs.shipmentStatus).toBe("delivered");
    // The division's own wording, kept rather than remapped onto a second list.
    expect(result.outputs.statusDescription).toBe("TESLİM EDİLDİ - KAPIDA");
    expect(result.outputs.statusLocation).toBe("Çankaya, TR");
    expect(result.outputs.statusAt).toBe(Date.parse("2026-08-08T10:37:00"));
    expect(result.outputs.deliveredAt).toBe(Date.parse("2026-08-08T10:37:00"));
    expect(result.outputs.estimatedDeliveryAt).toBe(Date.parse("2026-08-08T18:00:00"));
    expect(result.outputs.trackingNumber).toBe("00340434292135100186");
    expect(result.outputs.trackingUrl).toBe("https://www.dhl.com/tr-tr/home/tracking.html");
    expect(result.outputs.productName).toBe("DHL eCommerce Standart");
    // Which division actually answered — how an operator finds out the parcel
    // they thought was ex-MNG was handed on somewhere along the way.
    expect(result.outputs.carrierService).toBe("ecommerce");
  });

  test("a status DHL has no code for is written as unknown, not passed through", async () => {
    const { fetchImpl } = recorder([
      { body: { shipments: [{ id: ROW.carrier_shipment_id, status: { statusCode: "in-a-van", status: "MOVING" } }] } },
    ]);
    const result = await runTask({ fetchImpl });
    // The column is a select; a value outside its choices renders as a blank
    // chip with nothing to say why.
    expect(result.outputs.shipmentStatus).toBe("unknown");
    expect(result.outputs.statusDescription).toBe("MOVING");
  });

  test("nothing depends on the order of events — a returned parcel still reports when it was delivered", async () => {
    // The parcel has moved PAST delivery, so `status` no longer carries the
    // moment. `events` does, and here it arrives OLDEST-first — the opposite of
    // the live API's order, which is the point: neither order is promised.
    const { fetchImpl } = recorder([
      {
        body: {
          shipments: [
            {
              id: ROW.carrier_shipment_id,
              status: { timestamp: "2026-08-10T09:00:00", statusCode: "failure", status: "RETURNED TO SENDER" },
              events: [
                { timestamp: "2026-08-05T14:11:21", statusCode: "pre-transit", status: "LABEL CREATED" },
                { timestamp: "2026-08-08T10:37:00", statusCode: "delivered", status: "DELIVERED" },
                { timestamp: "2026-08-10T09:00:00", statusCode: "failure", status: "RETURNED TO SENDER" },
              ],
            },
          ],
        },
      },
    ]);
    const result = await runTask({ fetchImpl });
    expect(result.outputs.shipmentStatus).toBe("failure");
    expect(result.outputs.deliveredAt).toBe(Date.parse("2026-08-08T10:37:00"));
  });

  test("only the entry whose id was asked for is the row's", async () => {
    // A tracking number is unique only WITHIN a division, which is what the
    // response's `possibleAdditionalShipmentsUrl` admits. Taking the first
    // entry blindly would write somebody else's delivery date onto this row.
    const { fetchImpl } = recorder([
      {
        body: {
          shipments: [
            { id: "99999999999999999999", status: { statusCode: "transit", status: "SOMEBODY ELSE'S" } },
            { id: ROW.carrier_shipment_id, status: { statusCode: "delivered", status: "OURS" } },
          ],
        },
      },
    ]);
    const result = await runTask({ fetchImpl });
    expect(result.outputs.statusDescription).toBe("OURS");
    expect(result.outputs.shipmentStatus).toBe("delivered");
  });

  test("a postcode is sent when the row has one and omitted when it does not", async () => {
    const withCode = recorder([{ body: DELIVERED }]);
    await runTask({
      fetchImpl: withCode.fetchImpl,
      settings: { ...SETTINGS, recipientPostalCodeField: "shipping_postcode" },
    });
    expect(queryOf(withCode.calls[0]!).get("recipientPostalCode")).toBe("34710");

    // An empty value is answered with a 400 rather than ignored, so a row
    // without one must leave the parameter out entirely.
    resetThrottleState(); // the pair shares one five-second bucket
    const without = recorder([{ body: DELIVERED }]);
    await runTask({
      fetchImpl: without.fetchImpl,
      settings: { ...SETTINGS, recipientPostalCodeField: "shipping_postcode" },
      row: { ...ROW, shipping_postcode: "" },
    });
    expect(queryOf(without.calls[0]!).has("recipientPostalCode")).toBe(false);
    // Same for the language nobody set.
    expect(queryOf(without.calls[0]!).has("language")).toBe(false);
  });

  test("a language on the connection reaches the query", async () => {
    const { calls, fetchImpl } = recorder([{ body: DELIVERED }]);
    await runTask({ fetchImpl, config: { ...CONFIG, language: "tr" } });
    expect(queryOf(calls[0]!).get("language")).toBe("tr");
  });
});

describe("the refusals", () => {
  test("no service chosen refuses to run rather than letting DHL guess", async () => {
    const { calls, fetchImpl } = recorder([{ body: DELIVERED }]);
    // DHL treats the parameter as optional and guesses across fifteen
    // divisions when it is absent. A guess that returns a real shipment
    // belonging to someone else is a failure nobody would ever look for.
    await expect(runTask({ fetchImpl, settings: { trackingNumberField: "carrier_shipment_id" } })).rejects.toThrow(
      /needs the DHL service/,
    );
    expect(calls.length).toBe(0);
  });

  test("a service outside the published list is refused before the request", async () => {
    const { calls, fetchImpl } = recorder([{ body: DELIVERED }]);
    await expect(runTask({ fetchImpl, settings: { ...SETTINGS, service: "kargom-nerede" } })).rejects.toThrow(
      /not a DHL service/,
    );
    expect(calls.length).toBe(0);
  });

  test("an unmapped or empty tracking field says which field, not which status code", async () => {
    const { fetchImpl } = recorder([{ body: DELIVERED }]);
    await expect(runTask({ fetchImpl, settings: { service: "ecommerce-tr" } })).rejects.toThrow(
      /needs the row field holding the tracking number/,
    );

    const empty = recorder([{ body: DELIVERED }]);
    await expect(runTask({ fetchImpl: empty.fetchImpl, row: { ...ROW, carrier_shipment_id: "  " } })).rejects.toThrow(
      /holds no DHL tracking number/,
    );
  });

  test("a key with a newline in it is refused before it can split the request", async () => {
    const { calls, fetchImpl } = recorder([{ body: DELIVERED }]);
    await expect(runTask({ fetchImpl, config: { apiKey: "key-1\r\nX-Evil: 1" } })).rejects.toThrow(/printable ASCII/);
    expect(calls.length).toBe(0);
  });

  test("DHL's problem+json detail reaches the operator, and 401 says what to check", async () => {
    const unauthorized = recorder([
      {
        status: 401,
        contentType: "application/problem+json",
        // Verified against the live API. On its own this sends an operator
        // looking for a permission problem, hence the branch.
        body: { status: 401, title: "Unauthorized", detail: "Access to the resource is not allowed." },
      },
    ]);
    await expect(runTask({ fetchImpl: unauthorized.fetchImpl })).rejects.toThrow(/rejected the API key/);

    resetThrottleState(); // the pair shares one five-second bucket
    const bad = recorder([
      {
        status: 400,
        contentType: "application/problem+json",
        body: { status: 400, title: "Bad request", detail: "The tracking number is malformed." },
      },
    ]);
    await expect(runTask({ fetchImpl: bad.fetchImpl })).rejects.toThrow(/The tracking number is malformed/);
  });

  test("a 404 and an empty list are the same answer and read the same way", async () => {
    const missing = recorder([{ status: 404, body: { status: 404, title: "Not Found", detail: "No shipment." } }]);
    await expect(runTask({ fetchImpl: missing.fetchImpl })).rejects.toThrow(/has no shipment "00340434292135100186"/);

    // A 200 carrying nothing is DHL saying the same thing in a different way,
    // and writing `unknown` onto the row instead would hide the wrong field
    // being mapped or the wrong division being chosen.
    resetThrottleState(); // the pair shares one five-second bucket
    const none = recorder([{ body: { shipments: [] } }]);
    await expect(runTask({ fetchImpl: none.fetchImpl })).rejects.toThrow(/has no shipment "00340434292135100186"/);
  });

  test("a gateway's HTML failure still shows something an operator can read", async () => {
    const { fetchImpl } = recorder([
      { status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" },
    ]);
    await expect(runTask({ fetchImpl })).rejects.toThrow(/responded 502/);
  });
});
