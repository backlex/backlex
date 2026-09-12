/**
 * Yurtiçi Kargo — the second carrier, the first national one, and the first
 * provider in this engine to speak SOAP.
 *
 * The SOAP helper has its own spec; what is left to prove here is what is
 * Yurtiçi's. Three things, and the first is the one that costs money if it is
 * wrong:
 *
 * - a retried booking re-books the SAME consignment rather than putting a
 *   second one on a courier's manifest;
 * - a refusal arrives as a FIELD inside a 200, so a provider that checked only
 *   the HTTP status would report every refusal as a clean booking;
 * - the credentials travel in the body, and a value that looks like markup is
 *   escaped rather than injected into the envelope.
 */
import { describe, expect, test } from "bun:test";
import { INTEGRATION_TASKS, runIntegrationTask } from "@backlex/integrations";
import { parseXml, xmlText } from "@backlex/integrations/soap";

const CONFIG = { wsUserName: "user", wsPassword: "pass", language: "TR" };

const ROW = {
  id: "o1",
  shipping_name: "Ahmet Aslan",
  shipping_address: "Bağdat Cad. No 1",
  shipping_city: "İstanbul",
  shipping_town: "Kadıköy",
  shipping_phone: "5551112233",
  order_number: "10654411111",
  parcel_desi: 3,
  carrier_shipment_id: "run1abc",
};

const BOOK_SETTINGS = {
  receiverNameField: "shipping_name",
  receiverAddressField: "shipping_address",
  cityField: "shipping_city",
  townField: "shipping_town",
  phoneField: "shipping_phone",
  invoiceKeyField: "order_number",
  desiField: "parcel_desi",
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake Yurtiçi that records the envelope it was sent and answers as told. */
const recorder = (responses: { status?: number; body: string }[]) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") });
    const next = responses[i++] ?? { body: "" };
    return new Response(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${next.body}</soap:Body></soap:Envelope>`,
      { status: next.status ?? 200 },
    );
  };
  return { calls, fetchImpl };
};

const booked = (errCode = 0, errMessage = "") => ({
  body:
    "<ns:createShipmentResponse><ShippingOrderResultVO><count>1</count><jobId>77</jobId>" +
    `<shippingOrderDetailVO><cargoKey>run1abc</cargoKey><invoiceKey>10654411111</invoiceKey>` +
    `<errCode>${errCode}</errCode><errMessage>${errMessage}</errMessage></shippingOrderDetailVO>` +
    "</ShippingOrderResultVO></ns:createShipmentResponse>",
});

const runTask = (
  task: string,
  opts: { fetchImpl: any; row?: Record<string, unknown>; settings?: Record<string, unknown>; idempotencyKey?: string },
) =>
  runIntegrationTask(
    "yurtici",
    task,
    {
      config: CONFIG,
      settings: opts.settings ?? {},
      row: opts.row ?? ROW,
      idempotencyKey: opts.idempotencyKey ?? "run-1:abc",
    },
    opts.fetchImpl,
  );

/** The operation's arguments, parsed back out of the envelope that was sent. */
const sentBody = (call: Call) => {
  const envelope = parseXml(call.body);
  const body = envelope.Body as Record<string, unknown>;
  const operation = Object.values(body)[0];
  return operation as any;
};

describe("the three tasks a carrier has", () => {
  test("the contract is book, ask, cancel — and only the ask is repeatable", () => {
    expect(INTEGRATION_TASKS.yurtici?.map((t) => t.id)).toEqual([
      "book_shipment",
      "refresh_tracking",
      "cancel_shipment",
    ]);
    // Booking twice puts two consignments on a manifest; asking twice is a read
    // whose whole point is that the answer moves.
    expect(INTEGRATION_TASKS.yurtici?.filter((t) => t.repeatable).map((t) => t.id)).toEqual(["refresh_tracking"]);
  });
});

describe("booking a consignment", () => {
  test("the envelope carries the credentials, the address and one piece", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    const result = await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const call = calls[0]!;
    expect(call.url).toBe(
      "https://webservices.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices",
    );
    expect(call.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(call.body).toContain('xmlns:op="http://yurticikargo.com.tr/ShippingOrderDispatcherServices"');

    const sent = sentBody(call);
    // The credentials are arguments, not a header. That is Yurtiçi's design.
    expect(sent.wsUserName["#"]).toBe("user");
    expect(sent.wsPassword["#"]).toBe("pass");
    expect(sent.userLanguage["#"]).toBe("TR");

    const order = sent.ShippingOrderVO;
    expect(order.receiverCustName["#"]).toBe("Ahmet Aslan");
    // il / ilçe by NAME, which is what the marketplace sources in this engine
    // already carry — no lookup table in between.
    expect(order.cityName["#"]).toBe("İstanbul");
    expect(order.townName["#"]).toBe("Kadıköy");
    expect(order.desi["#"]).toBe("3");
    // Every parcel this engine books is at least one piece; leaving it out
    // would make the courier guess.
    expect(order.cargoCount["#"]).toBe("1");

    expect(result.outputs.cargoKey).toBe("run1abc");
    expect(result.outputs.invoiceKey).toBe("10654411111");
    expect(result.outputs.jobId).toBe("77");
    expect(result.outputs.shipmentStatus).toBe("booked");
  });

  test("an optional field nobody mapped is omitted, not sent empty", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    const order = sentBody(calls[0]!).ShippingOrderVO;
    // A courier reading an empty <emailAddress/> as "clear it" is a different
    // thing from never being told about it.
    expect(order.emailAddress).toBeUndefined();
    expect(order.kg).toBeUndefined();
  });

  test("a retry re-books the SAME consignment rather than a second one", async () => {
    const a = recorder([booked()]);
    const b = recorder([booked()]);
    await runTask("book_shipment", { fetchImpl: a.fetchImpl, settings: BOOK_SETTINGS, idempotencyKey: "run-9:zz" });
    await runTask("book_shipment", { fetchImpl: b.fetchImpl, settings: BOOK_SETTINGS, idempotencyKey: "run-9:zz" });

    const keyOf = (r: typeof a) => sentBody(r.calls[0]!).ShippingOrderVO.cargoKey["#"];
    // There is no idempotency header here to fall back on, so this is the guard
    // that matters: a duplicate consignment is a courier arriving twice.
    expect(keyOf(a)).toBe(keyOf(b));
    expect(keyOf(a)).toMatch(/^[A-Za-z0-9-]{1,40}$/);
  });

  test("a refusal arrives as a field inside a 200 and still fails the run", async () => {
    // A provider that checked only the HTTP status would report this as a
    // clean booking and mark an order shipped against nothing.
    const { fetchImpl } = recorder([booked(21, "Alıcı adresi bulunamadı")]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /Alıcı adresi bulunamadı/,
    );
  });

  test("an answer with no result at all is a refusal too", async () => {
    const { fetchImpl } = recorder([{ body: "<ns:createShipmentResponse/>" }]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /returned no result/,
    );
  });

  test("a SOAP fault reads as the courier's refusal, not a transport failure", async () => {
    const { fetchImpl } = recorder([
      { status: 500, body: "<soap:Fault><faultstring>Kullanıcı yetkisiz</faultstring></soap:Fault>" },
    ]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /Yurtiçi refused the request: Kullanıcı yetkisiz/,
    );
  });

  test("a missing address field is named before anything is sent", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await expect(
      runTask("book_shipment", {
        fetchImpl,
        settings: BOOK_SETTINGS,
        row: { ...ROW, shipping_city: "" },
      }),
    ).rejects.toThrow(/city/);
    expect(calls).toHaveLength(0);
  });

  test("a value that looks like markup is escaped rather than injected", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await runTask("book_shipment", {
      fetchImpl,
      settings: BOOK_SETTINGS,
      row: { ...ROW, shipping_name: '</receiverCustName><desi>999</desi><receiverCustName>' },
    });
    const order = sentBody(calls[0]!).ShippingOrderVO;
    // It survives as the text it was, and it did NOT become a desi of 999.
    expect(order.receiverCustName["#"]).toBe("</receiverCustName><desi>999</desi><receiverCustName>");
    expect(order.desi["#"]).toBe("3");
  });

  test("a credential with a control character never reaches an envelope", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await expect(
      runIntegrationTask(
        "yurtici",
        "book_shipment",
        {
          config: { ...CONFIG, wsUserName: "user\r\nevil" },
          settings: BOOK_SETTINGS,
          row: ROW,
          idempotencyKey: "run-1:abc",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/control characters/);
    expect(calls).toHaveLength(0);
  });
});

describe("asking where it is", () => {
  const tracked = (over = "") => ({
    body:
      "<ns:queryShipmentResponse><ShippingDeliveryVO><shippingDeliveryDetailVO><errCode>0</errCode>" +
      "<shippingDeliveryItemDetailVO><cargoKey>run1abc</cargoKey><waybillNo>WB-1</waybillNo>" +
      "<docId>994411</docId><trackingUrl>https://track/1</trackingUrl>" +
      "<cargoEventExplanation>Teslim Edildi</cargoEventExplanation>" +
      "<deliveryDate>24.06.2026</deliveryDate><deliveryTime>14:35</deliveryTime>" +
      `<receiverInfo>Ahmet Aslan</receiverInfo><totalDesi>3</totalDesi>${over}` +
      "</shippingDeliveryItemDetailVO></shippingDeliveryDetailVO></ShippingDeliveryVO></ns:queryShipmentResponse>",
  });

  test("the answer keeps Yurtiçi's own vocabulary rather than an invented one", async () => {
    const { calls, fetchImpl } = recorder([tracked()]);
    const result = await runTask("refresh_tracking", {
      fetchImpl,
      settings: { cargoKeyField: "carrier_shipment_id" },
    });

    const sent = sentBody(calls[0]!);
    expect(sent.keys["#"]).toBe("run1abc");
    // Free text with a documented default, because the WSDL types it as an int
    // and does not enumerate it — a dropdown built from a guess is worse.
    expect(sent.keyType["#"]).toBe("0");

    expect(result.outputs.shipmentStatus).toBe("Teslim Edildi");
    expect(result.outputs.waybillNo).toBe("WB-1");
    expect(result.outputs.trackingUrl).toBe("https://track/1");
    // The date and the time arrive in two fields and land in one column.
    expect(result.outputs.deliveredAt).toBe("24.06.2026 14:35");
    expect(result.outputs.receivedBy).toBe("Ahmet Aslan");
  });

  test("an operator's own key type is honoured, and nonsense falls back", async () => {
    const a = recorder([tracked()]);
    await runTask("refresh_tracking", {
      fetchImpl: a.fetchImpl,
      settings: { cargoKeyField: "carrier_shipment_id", keyType: "1" },
    });
    expect(sentBody(a.calls[0]!).keyType["#"]).toBe("1");

    const b = recorder([tracked()]);
    await runTask("refresh_tracking", {
      fetchImpl: b.fetchImpl,
      settings: { cargoKeyField: "carrier_shipment_id", keyType: "not-a-number" },
    });
    expect(sentBody(b.calls[0]!).keyType["#"]).toBe("0");
  });

  test("a consignment the courier has never heard of is named", async () => {
    const { fetchImpl } = recorder([
      { body: "<ns:queryShipmentResponse><ShippingDeliveryVO><shippingDeliveryDetailVO><errCode>0</errCode></shippingDeliveryDetailVO></ShippingDeliveryVO></ns:queryShipmentResponse>" },
    ]);
    await expect(
      runTask("refresh_tracking", { fetchImpl, settings: { cargoKeyField: "carrier_shipment_id" } }),
    ).rejects.toThrow(/no consignment/);
  });

  test("a row with no key never reaches the wire", async () => {
    const { calls, fetchImpl } = recorder([tracked()]);
    await expect(
      runTask("refresh_tracking", {
        fetchImpl,
        settings: { cargoKeyField: "carrier_shipment_id" },
        row: { id: "o1" },
      }),
    ).rejects.toThrow(/consignment key/);
    expect(calls).toHaveLength(0);
  });
});

describe("cancelling", () => {
  test("one row means a list of one on the wire", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body:
          "<ns:cancelShipmentResponse><ShippingOrderResultVO><shippingCancelDetailVO>" +
          "<cargoKey>run1abc</cargoKey><errCode>0</errCode><operationStatus>OK</operationStatus>" +
          "</shippingCancelDetailVO></ShippingOrderResultVO></ns:cancelShipmentResponse>",
      },
    ]);
    const result = await runTask("cancel_shipment", {
      fetchImpl,
      settings: { cargoKeyField: "carrier_shipment_id" },
    });
    expect(sentBody(calls[0]!).cargoKeys["#"]).toBe("run1abc");
    expect(result.outputs.shipmentStatus).toBe("cancelled");
    expect(typeof result.outputs.cancelledAt).toBe("number");
  });

  test("a consignment already gone is a refusal the operator can read", async () => {
    const { fetchImpl } = recorder([
      {
        body:
          "<ns:cancelShipmentResponse><ShippingOrderResultVO><shippingCancelDetailVO>" +
          "<errCode>14</errCode><errMessage>Gönderi zaten iptal edilmiş</errMessage>" +
          "</shippingCancelDetailVO></ShippingOrderResultVO></ns:cancelShipmentResponse>",
      },
    ]);
    await expect(
      runTask("cancel_shipment", { fetchImpl, settings: { cargoKeyField: "carrier_shipment_id" } }),
    ).rejects.toThrow(/zaten iptal edilmiş/);
  });
});

describe("the envelope itself", () => {
  test("it parses back to what a courier's stack would see", () => {
    const tree = parseXml(
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
        '<op:createShipment xmlns:op="urn:x"><wsUserName>u</wsUserName></op:createShipment>' +
        "</soap:Body></soap:Envelope>",
    );
    expect(xmlText(tree, "Body", "createShipment", "wsUserName")).toBe("u");
  });
});
