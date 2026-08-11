/**
 * EasyPost — the first carrier, and the whole of what a carrier contract is:
 * book a shipment, ask where it is, cancel it.
 *
 * The engine's own specs already prove the machinery — a task runs once, a
 * repeatable one runs again, an artifact is stored before the row names its
 * key. What is left is the part that is EasyPost's and cannot be read off the
 * descriptor:
 *
 *   - it BUYS in one call, and a shipment that came back unbought is a failure
 *     rather than a success with no tracking number
 *   - the label is fetched from a host EasyPost chose, so where it may be
 *     fetched from is an allow-list — and failing that check must not undo a
 *     booking that already cost money
 *   - the three ways a row can be mis-mapped (no recipient, no weight, a
 *     country column holding a display name) are refused with a sentence
 *
 * The pacing state is reset between tests: the provider declares a limit, and a
 * suite that drained the bucket would be slow in a way that gets real limits
 * quietly deleted.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { INTEGRATION_TASKS, resetThrottleState, runIntegrationTask } from "@backlex/integrations";

const CONFIG = {
  apiKey: "EZTKfake",
  fromName: "Warehouse",
  fromStreet1: "417 Montgomery Street",
  fromCity: "San Francisco",
  fromState: "CA",
  fromZip: "94104",
  fromCountry: "US",
  fromPhone: "4153334445",
};

const BOOK_SETTINGS = {
  carrierAccount: "ca_abc123",
  service: "Priority",
  toNameField: "ship_to_name",
  toStreet1Field: "ship_to_street",
  toCityField: "ship_to_city",
  toStateField: "ship_to_state",
  toZipField: "ship_to_zip",
  toCountryField: "ship_to_country",
  toPhoneField: "ship_to_phone",
  weightField: "weight_oz",
  lengthField: "length_in",
};

const ROW = {
  id: "ful_1",
  ship_to_name: "Dr. Steve Brule",
  ship_to_street: "179 N Harbor Dr",
  ship_to_city: "Redondo Beach",
  ship_to_state: "CA",
  ship_to_zip: "90277",
  ship_to_country: "us",
  ship_to_phone: "8573875756",
  weight_oz: 65.9,
  length_in: 20.2,
};

const LABEL_PDF = "%PDF-1.4 pretend label";

/** A bought shipment, as the API hands it back. */
const BOUGHT = {
  id: "shp_abc123",
  tracking_code: "9400100000000000000000",
  selected_rate: { carrier: "USPS", service: "Priority", rate: "7.71", currency: "USD" },
  postage_label: { label_pdf_url: "https://assets.easypost.com/labels/lbl_1.pdf" },
  tracker: {
    status: "pre_transit",
    public_url: "https://track.easypost.com/djE6dHJr",
    est_delivery_date: "2026-08-15T00:00:00Z",
  },
};

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * A fake EasyPost that records every call and answers as told.
 *
 * The label fetch goes through the same `fetch`, so a response for it is just
 * the next entry — which is what makes "the label host is checked" testable
 * without a second seam.
 */
const recorder = (responses: { status?: number; body?: unknown; raw?: string }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url: new URL(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[i++] ?? {};
    const payload = next.raw ?? JSON.stringify(next.body ?? {});
    return new Response(payload, { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

const run = (
  task: string,
  opts: {
    fetchImpl: any;
    settings?: Record<string, unknown>;
    config?: Record<string, unknown>;
    row?: Record<string, unknown>;
  },
) =>
  runIntegrationTask(
    "easypost",
    task,
    {
      config: { ...CONFIG, ...(opts.config ?? {}) },
      settings: opts.settings ?? {},
      row: opts.row ?? ROW,
      idempotencyKey: "run-1",
    },
    opts.fetchImpl,
  );

beforeEach(() => {
  resetThrottleState();
});

describe("what the provider declares", () => {
  test("only refresh_tracking is repeatable", () => {
    // Booking and cancelling both reach a carrier. Reading does not, and that
    // difference is the entire basis for relaxing the once-only guard — so it
    // is worth asserting rather than assuming.
    const tasks = INTEGRATION_TASKS.easypost!;
    const repeatable = tasks.filter((t) => t.repeatable).map((t) => t.id);
    expect(repeatable).toEqual(["refresh_tracking"]);
  });

  test("exactly one output carries the artifact, and it is the label", () => {
    const book = INTEGRATION_TASKS.easypost!.find((t) => t.id === "book_shipment")!;
    const artifacts = book.outputs.filter((o) => o.artifact).map((o) => o.key);
    expect(artifacts).toEqual(["labelKey"]);
  });
});

describe("booking a shipment", () => {
  test("buys in ONE call and answers with the tracking number and the label", async () => {
    const { calls, fetchImpl } = recorder([{ body: BOUGHT }, { raw: LABEL_PDF }]);
    const res = await run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    // One-call buy: service and carrier account travel with the create, so
    // there is no second request to die between.
    expect(calls[0]!.url.pathname).toBe("/v2/shipments");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body.shipment.service).toBe("Priority");
    expect(calls[0]!.body.shipment.carrier_accounts).toEqual(["ca_abc123"]);

    // The key goes in the username half of Basic auth, password empty.
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${btoa("EZTKfake:")}`);

    expect(res.outputs.shipmentId).toBe("shp_abc123");
    expect(res.outputs.trackingCode).toBe("9400100000000000000000");
    expect(res.outputs.carrier).toBe("USPS");
    expect(res.outputs.rate).toBe(7.71);
    expect(res.outputs.shipmentStatus).toBe("pre_transit");
    expect(res.outputs.estimatedDeliveryAt).toBe(Date.parse("2026-08-15T00:00:00Z"));

    expect(res.artifact?.outputKey).toBe("labelKey");
    expect(res.artifact?.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(res.artifact!.bytes)).toBe(LABEL_PDF);
  });

  test("the address it sends carries the row's recipient and the connection's sender", async () => {
    const { calls, fetchImpl } = recorder([{ body: BOUGHT }, { raw: LABEL_PDF }]);
    await run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const { to_address, from_address, parcel } = calls[0]!.body.shipment;
    expect(to_address.name).toBe("Dr. Steve Brule");
    expect(to_address.street1).toBe("179 N Harbor Dr");
    // Upper-cased on the way out — a column holding "us" is not a mapping error.
    expect(to_address.country).toBe("US");
    // The ship-from is the workspace's own, so it comes off the connection and
    // is not re-typed onto every step.
    expect(from_address.street1).toBe("417 Montgomery Street");
    expect(parcel.weight).toBe(65.9);
    expect(parcel.length).toBe(20.2);
    // Absent columns are omitted rather than sent empty: EasyPost validates
    // an empty string and would refuse the address for it.
    expect("street2" in to_address).toBe(false);
    expect("height" in parcel).toBe(false);
  });

  test("a shipment that came back UNBOUGHT is a failure, not a quiet success", async () => {
    // Naming a service the carrier account does not offer leaves the shipment
    // created but unpurchased. Reporting success would mark an order shipped
    // against a parcel no courier has heard of.
    const { fetchImpl } = recorder([{ body: { id: "shp_abc123", tracking_code: null } }]);
    await expect(run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /did not buy it/i,
    );
  });

  test("a label on a host EasyPost does not serve from is skipped, NOT fatal", async () => {
    // The shipment is already bought by this point. Throwing would fail the
    // run, the queue would retry it, and the retry books a second consignment
    // — which is the one outcome worse than a missing PDF.
    const { fetchImpl } = recorder([
      { body: { ...BOUGHT, postage_label: { label_pdf_url: "https://labels.attacker.test/l.pdf" } } },
    ]);
    const res = await run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    expect(res.outputs.trackingCode).toBe("9400100000000000000000");
    expect(res.artifact).toBeUndefined();
  });

  test("a label the host serves but the fetch fails on is skipped the same way", async () => {
    const { fetchImpl } = recorder([{ body: BOUGHT }, { status: 404 }]);
    const res = await run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    expect(res.outputs.shipmentId).toBe("shp_abc123");
    expect(res.artifact).toBeUndefined();
  });
});

describe("what booking refuses before it spends money", () => {
  const refuses = async (
    patch: { settings?: Record<string, unknown>; row?: Record<string, unknown>; config?: Record<string, unknown> },
    match: RegExp,
  ) => {
    const { calls, fetchImpl } = recorder([{ body: BOUGHT }]);
    await expect(
      run("book_shipment", {
        fetchImpl,
        settings: { ...BOOK_SETTINGS, ...(patch.settings ?? {}) },
        row: patch.row,
        config: patch.config,
      }),
    ).rejects.toThrow(match);
    // The point of refusing early: nothing reached the carrier.
    expect(calls).toHaveLength(0);
  };

  test("a row with no recipient name or street", async () => {
    await refuses({ row: { ...ROW, ship_to_name: null } }, /recipient name and street/i);
  });

  test("a row with no parcel weight", async () => {
    await refuses({ row: { ...ROW, weight_oz: null } }, /parcel weight/i);
  });

  test("a country column holding a display name rather than a code", async () => {
    // Sent as-is, EasyPost would reject the address with a message about the
    // country field rather than about the column that filled it.
    await refuses({ row: { ...ROW, ship_to_country: "United States" } }, /ISO alpha-2/i);
  });

  test("a step with no service or carrier account", async () => {
    await refuses({ settings: { service: "" } }, /service level/i);
    await refuses({ settings: { carrierAccount: "" } }, /carrier account/i);
  });

  test("a connection with no ship-from address", async () => {
    await refuses({ config: { fromStreet1: "" } }, /ship-from name and street/i);
  });

  test("an API key that is not plain ASCII", async () => {
    // `btoa` would throw naming a DOM API, which tells an operator nothing
    // about the credential they pasted.
    await refuses({ config: { apiKey: "EZTK–dash" } }, /plain ASCII/i);
  });
});

describe("refreshing tracking", () => {
  const SETTINGS = { shipmentIdField: "carrier_shipment_id" };
  const TRACKED_ROW = { id: "ful_1", carrier_shipment_id: "shp_abc123" };

  test("reads the tracker off the shipment and reports the last scan", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          ...BOUGHT,
          tracker: {
            status: "delivered",
            public_url: "https://track.easypost.com/djE6dHJr",
            est_delivery_date: "2026-08-15T00:00:00Z",
            tracking_details: [
              { status: "in_transit", message: "Departed facility", datetime: "2026-08-13T09:00:00Z" },
              { status: "delivered", message: "Delivered, front porch", datetime: "2026-08-15T14:02:00Z" },
            ],
          },
        },
      },
    ]);
    const res = await run("refresh_tracking", { fetchImpl, settings: SETTINGS, row: TRACKED_ROW });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v2/shipments/shp_abc123");
    expect(res.outputs.shipmentStatus).toBe("delivered");
    expect(res.outputs.lastEvent).toBe("Delivered, front porch");
    expect(res.outputs.deliveredAt).toBe(Date.parse("2026-08-15T14:02:00Z"));
  });

  test("a status outside the declared set becomes `unknown`, never a blank chip", async () => {
    // The column is a select. A value outside its choices renders as a chip
    // with no label and nothing to say why.
    const { fetchImpl } = recorder([{ body: { tracker: { status: "teleported" } } }]);
    const res = await run("refresh_tracking", { fetchImpl, settings: SETTINGS, row: TRACKED_ROW });
    expect(res.outputs.shipmentStatus).toBe("unknown");
  });

  test("a row whose id column holds something else is refused, not looked up", async () => {
    // The id is interpolated into a URL path. A mis-pointed setting saying so
    // beats a 404 from a URL nobody meant to build.
    const { calls, fetchImpl } = recorder([{ body: BOUGHT }]);
    await expect(
      run("refresh_tracking", {
        fetchImpl,
        settings: SETTINGS,
        row: { id: "ful_1", carrier_shipment_id: "../../addresses" },
      }),
    ).rejects.toThrow(/shp_/);
    expect(calls).toHaveLength(0);
  });
});

describe("cancelling a shipment", () => {
  const SETTINGS = { shipmentIdField: "carrier_shipment_id" };
  const TRACKED_ROW = { id: "ful_1", carrier_shipment_id: "shp_abc123" };

  test("refunds the label and writes what was ASKED for, not what was granted", async () => {
    // Carriers take up to a month to answer. The row reading `submitted` for a
    // while is the truth; writing `refunded` on the strength of having asked
    // would not be.
    const { calls, fetchImpl } = recorder([{ body: { ...BOUGHT, refund_status: "submitted" } }]);
    const res = await run("cancel_shipment", { fetchImpl, settings: SETTINGS, row: TRACKED_ROW });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v2/shipments/shp_abc123/refund");
    expect(res.outputs.refundStatus).toBe("submitted");
    expect(res.outputs.shipmentStatus).toBe("cancelled");
  });

  test("a refusal to refund is an error, not a row that reads `not_applicable`", async () => {
    const { fetchImpl } = recorder([{ body: { refund_status: "not_applicable" } }]);
    await expect(
      run("cancel_shipment", { fetchImpl, settings: SETTINGS, row: TRACKED_ROW }),
    ).rejects.toThrow(/will not refund/i);
  });
});

describe("what a failure says", () => {
  test("a rejected key names the key rather than the status code", async () => {
    const { fetchImpl } = recorder([
      { status: 403, body: { error: { code: "APIKEY.INACTIVE", message: "This api key is no longer active." } } },
    ]);
    await expect(run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /rejected the API key/i,
    );
  });

  test("a billing refusal is told apart from a bad request", async () => {
    const { fetchImpl } = recorder([{ status: 402, body: { error: { message: "Insufficient funds" } } }]);
    await expect(run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /billing reasons/i,
    );
  });

  test("a field-level error surfaces the field, not just the status", async () => {
    const { fetchImpl } = recorder([
      {
        status: 422,
        body: {
          error: {
            code: "ADDRESS.VERIFY.FAILURE",
            message: "Unable to verify address.",
            errors: [{ field: "zip", message: "must be present" }],
          },
        },
      },
    ]);
    await expect(run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /zip: must be present/i,
    );
  });

  test("an HTML answer from a gateway still shows something useful", async () => {
    const { fetchImpl } = recorder([{ status: 500, raw: "<html><body>Bad Gateway</body></html>" }]);
    await expect(run("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /responded 500/i,
    );
  });
});
