/**
 * Aras Kargo — the third carrier and the second over SOAP, which is the point
 * of it: the helper written for Yurtiçi carried straight across.
 *
 * What is Aras's own and worth pinning: it wants the credentials twice and
 * spells them two ways, its refusals arrive as a field inside a 200, a retried
 * booking must re-book the same consignment, and the cash-on-delivery flag and
 * amount must travel together or not at all.
 */
import { describe, expect, test } from "bun:test";
import { INTEGRATION_TASKS, runIntegrationTask } from "@backlex/integrations";
import { parseXml } from "@backlex/integrations/soap";

const CONFIG = { userName: "user", password: "pass" };

const ROW = {
  id: "o1",
  shipping_name: "Ahmet Aslan",
  shipping_address: "Bağdat Cad. No 1",
  shipping_city: "İstanbul",
  shipping_town: "Kadıköy",
  shipping_neighbourhood: "Caferağa",
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
  quarterField: "shipping_neighbourhood",
  phoneField: "shipping_phone",
  invoiceNumberField: "order_number",
  volumetricWeightField: "parcel_desi",
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

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

const booked = (code = "0", message = "Başarılı") => ({
  body:
    "<SetOrderResponse><SetOrderResult><OrderResultInfo>" +
    `<ResultCode>${code}</ResultCode><ResultMessage>${message}</ResultMessage>` +
    "<InvoiceKey>INV-77</InvoiceKey></OrderResultInfo></SetOrderResult></SetOrderResponse>",
});

const runTask = (
  task: string,
  opts: { fetchImpl: any; row?: Record<string, unknown>; settings?: Record<string, unknown>; idempotencyKey?: string },
) =>
  runIntegrationTask(
    "aras",
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
  const body = parseXml(call.body).Body as Record<string, unknown>;
  return Object.values(body)[0] as any;
};

describe("the tasks Aras actually supports", () => {
  test("book, track and cancel — and only tracking repeats", () => {
    // Tracking arrived late and for a specific reason: five of Aras's
    // consignment-query operations answer with an untyped .NET DataSet whose
    // columns are not in the WSDL, and declaring guessed names is how a row
    // ends up permanently empty while the run reports success. But
    // `GetDeliveryInfodocID` is not one of them — it returns a typed
    // `ArrayOfDeliveryInfo`, so the names below are read rather than guessed.
    expect(INTEGRATION_TASKS.aras?.map((t) => t.id)).toEqual([
      "book_shipment",
      "refresh_tracking",
      "cancel_shipment",
    ]);
    // Booking twice puts two consignments on a manifest and cancelling twice
    // errors on one already gone. Reading where a parcel is has no side effect
    // and its whole value is that the answer moves.
    expect(INTEGRATION_TASKS.aras?.filter((t) => t.repeatable).map((t) => t.id)).toEqual([
      "refresh_tracking",
    ]);
  });
});

describe("refreshing tracking", () => {
  const TRACK_SETTINGS = { docIdField: "carrier_shipment_id" };

  /** One `DeliveryInfo`, with the field names taken from the published WSDL. */
  const delivered = (over: Record<string, string> = {}) => {
    const f: Record<string, string> = {
      DocID: "DOC-9",
      DeliveryStatus: "Teslim Edildi",
      DeliveryAddressStatus: "Adres Doğru",
      StatusFlag: "1",
      DeliveryDate: "2026-08-18",
      DeliveryTime: "14:32",
      DeliveryPerson: "Ayşe Yılmaz",
      DeliveryUnitName: "Kadıköy Şube",
      ArrivalDate: "2026-08-17",
      NotDeliveredReason: "",
      ...over,
    };
    const inner = Object.entries(f).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    return {
      body: `<GetDeliveryInfodocIDResponse><GetDeliveryInfodocIDResult><DeliveryInfo>${inner}</DeliveryInfo></GetDeliveryInfodocIDResult></GetDeliveryInfodocIDResponse>`,
    };
  };

  test("asks by document id, as an ArrayOfString even for one", async () => {
    // The WSDL takes `ArrayOfString`; a bare string is answered with a fault
    // about the element type.
    const { calls, fetchImpl } = recorder([delivered()]);
    await runTask("refresh_tracking", { fetchImpl, settings: TRACK_SETTINGS });
    // Asserted on the wire rather than through the parser: the point is the
    // `<string>` wrapper, and a parser that unwraps single text nodes would
    // hide exactly the thing under test.
    expect(calls[0]!.body).toContain("<docID><string>run1abc</string></docID>");
    // Quoted, as SOAP 1.1 requires — ASP.NET checks it.
    expect(calls[0]!.headers.SOAPAction).toBe('"http://tempuri.org/GetDeliveryInfodocID"');
  });

  test("maps the typed fields Aras publishes", async () => {
    const { fetchImpl } = recorder([delivered()]);
    const res = await runTask("refresh_tracking", { fetchImpl, settings: TRACK_SETTINGS });
    expect(res.outputs).toMatchObject({
      shipmentStatus: "Teslim Edildi",
      statusDetail: "Adres Doğru",
      statusFlag: "1",
      receivedBy: "Ayşe Yılmaz",
      deliveryUnit: "Kadıköy Şube",
      arrivedAt: "2026-08-17",
      docId: "DOC-9",
    });
  });

  test("date and time are joined — apart they are not an instant", async () => {
    const { fetchImpl } = recorder([delivered()]);
    const res = await runTask("refresh_tracking", { fetchImpl, settings: TRACK_SETTINGS });
    expect(res.outputs.deliveredAt).toBe("2026-08-18 14:32");
  });

  test("a consignment with no delivery date reports no instant rather than a half one", async () => {
    const { fetchImpl } = recorder([delivered({ DeliveryDate: "", DeliveryTime: "" })]);
    const res = await runTask("refresh_tracking", { fetchImpl, settings: TRACK_SETTINGS });
    expect(res.outputs.deliveredAt).toBeNull();
  });

  test("an EMPTY answer is not a failure — it is a parcel Aras has not moved yet", async () => {
    // The ordinary case immediately after booking. Throwing here would turn a
    // cron poll over undelivered consignments into a wall of failed runs.
    const { fetchImpl } = recorder([
      { body: "<GetDeliveryInfodocIDResponse><GetDeliveryInfodocIDResult /></GetDeliveryInfodocIDResponse>" },
    ]);
    const res = await runTask("refresh_tracking", { fetchImpl, settings: TRACK_SETTINGS });
    expect(res.outputs).toEqual({ shipmentStatus: "unknown", docId: "run1abc" });
  });

  test("a row with no document id is refused before the call", async () => {
    const { calls, fetchImpl } = recorder([delivered()]);
    await expect(
      runTask("refresh_tracking", { fetchImpl, settings: TRACK_SETTINGS, row: { id: "r1" } }),
    ).rejects.toThrow(/holds no Aras document id/);
    expect(calls).toHaveLength(0);
  });

  test("no `docIdField` setting names itself", async () => {
    const { fetchImpl } = recorder([delivered()]);
    await expect(runTask("refresh_tracking", { fetchImpl, settings: {} })).rejects.toThrow(
      /row field holding the document id/,
    );
  });
});

describe("booking a consignment", () => {
  test("the envelope carries the credentials twice, and the SOAPAction ASP.NET checks", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    const result = await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const call = calls[0]!;
    expect(call.url).toBe("https://customerws.araskargo.com.tr/arascargoservice.asmx");
    // Getting this wrong is answered with a fault about an operation nobody
    // asked for.
    expect(call.headers.SOAPAction).toBe('"http://tempuri.org/SetOrder"');
    expect(call.body).toContain('xmlns:op="http://tempuri.org/"');

    const sent = sentBody(call);
    expect(sent.userName["#"]).toBe("user");
    expect(sent.password["#"]).toBe("pass");

    const order = sent.orderInfo.Order;
    // Aras wants them inside the order too, not only as arguments.
    expect(order.UserName["#"]).toBe("user");
    expect(order.Password["#"]).toBe("pass");

    expect(order.ReceiverName["#"]).toBe("Ahmet Aslan");
    expect(order.ReceiverCityName["#"]).toBe("İstanbul");
    expect(order.ReceiverTownName["#"]).toBe("Kadıköy");
    // The mahalle arrives complete from the marketplace sources and must leave
    // complete too.
    expect(order.ReceiverQuarterName["#"]).toBe("Caferağa");
    // Aras types every measure as a string.
    expect(order.VolumetricWeight["#"]).toBe("3");
    expect(order.PieceCount["#"]).toBe("1");

    // Derived from the idempotency key, keeping the characters a key field
    // takes — hyphens survive, the separator does not.
    expect(result.outputs.integrationCode).toBe("run-1abc");
    expect(order.IntegrationCode["#"]).toBe("run-1abc");
    expect(result.outputs.invoiceKey).toBe("INV-77");
    expect(result.outputs.shipmentStatus).toBe("booked");
  });

  test("an optional field nobody mapped is omitted, not sent empty", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });
    const order = sentBody(calls[0]!).orderInfo.Order;
    expect(order.Weight).toBeUndefined();
    expect(order.Description).toBeUndefined();
  });

  test("the cash-on-delivery flag and amount travel together or not at all", async () => {
    const withCod = recorder([booked()]);
    await runTask("book_shipment", {
      fetchImpl: withCod.fetchImpl,
      settings: { ...BOOK_SETTINGS, codAmountField: "cod_amount" },
      row: { ...ROW, cod_amount: 250 },
    });
    const order = sentBody(withCod.calls[0]!).orderInfo.Order;
    // An amount with no flag is silently not collected — the one failure mode
    // here that costs the seller money.
    expect(order.IsCod["#"]).toBe("1");
    expect(order.CodAmount["#"]).toBe("250");

    const none = recorder([booked()]);
    await runTask("book_shipment", {
      fetchImpl: none.fetchImpl,
      settings: { ...BOOK_SETTINGS, codAmountField: "cod_amount" },
      row: { ...ROW, cod_amount: 0 },
    });
    const plain = sentBody(none.calls[0]!).orderInfo.Order;
    expect(plain.IsCod).toBeUndefined();
    expect(plain.CodAmount).toBeUndefined();
  });

  test("a retry re-books the SAME consignment rather than a second one", async () => {
    const a = recorder([booked()]);
    const b = recorder([booked()]);
    await runTask("book_shipment", { fetchImpl: a.fetchImpl, settings: BOOK_SETTINGS, idempotencyKey: "run-9:zz" });
    await runTask("book_shipment", { fetchImpl: b.fetchImpl, settings: BOOK_SETTINGS, idempotencyKey: "run-9:zz" });

    const codeOf = (r: typeof a) => sentBody(r.calls[0]!).orderInfo.Order.IntegrationCode["#"];
    expect(codeOf(a)).toBe(codeOf(b));
    expect(codeOf(a)).toMatch(/^[A-Za-z0-9-]{1,40}$/);
  });

  test("a refusal arrives as a field inside a 200 and still fails the run", async () => {
    const { fetchImpl } = recorder([booked("13", "Alıcı ilçe bulunamadı")]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /Alıcı ilçe bulunamadı/,
    );
  });

  test("an answer with no result at all is a refusal too", async () => {
    const { fetchImpl } = recorder([{ body: "<SetOrderResponse/>" }]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /returned no result/,
    );
  });

  test("a SOAP fault reads as the courier's refusal, not a transport failure", async () => {
    const { fetchImpl } = recorder([
      { status: 500, body: "<soap:Fault><faultstring>Kullanıcı adı hatalı</faultstring></soap:Fault>" },
    ]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /Aras refused the request: Kullanıcı adı hatalı/,
    );
  });

  test("a missing address field is named before anything is sent", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await expect(
      runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS, row: { ...ROW, shipping_town: "" } }),
    ).rejects.toThrow(/town/);
    expect(calls).toHaveLength(0);
  });

  test("a value that looks like markup is escaped rather than injected", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await runTask("book_shipment", {
      fetchImpl,
      settings: BOOK_SETTINGS,
      row: { ...ROW, shipping_name: "</ReceiverName><IsCod>1</IsCod><ReceiverName>" },
    });
    const order = sentBody(calls[0]!).orderInfo.Order;
    expect(order.ReceiverName["#"]).toBe("</ReceiverName><IsCod>1</IsCod><ReceiverName>");
    // It did NOT become a cash-on-delivery consignment.
    expect(order.IsCod).toBeUndefined();
  });

  test("a credential with a control character never reaches an envelope", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await expect(
      runIntegrationTask(
        "aras",
        "book_shipment",
        {
          config: { ...CONFIG, password: "pass\r\nevil" },
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

describe("cancelling", () => {
  test("the consignment is addressed by the key the booking chose", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body:
          "<CancelDispatchResponse><CancelDispatchResult><ResultCode>0</ResultCode>" +
          "<ResultMessage>İptal edildi</ResultMessage><CargoKey>CK-1</CargoKey>" +
          "</CancelDispatchResult></CancelDispatchResponse>",
      },
    ]);
    const result = await runTask("cancel_shipment", {
      fetchImpl,
      settings: { integrationCodeField: "carrier_shipment_id" },
    });

    expect(calls[0]!.headers.SOAPAction).toBe('"http://tempuri.org/CancelDispatch"');
    expect(sentBody(calls[0]!).integrationCode["#"]).toBe("run1abc");
    expect(result.outputs.cargoKey).toBe("CK-1");
    expect(result.outputs.shipmentStatus).toBe("cancelled");
  });

  test("a consignment already gone is a refusal the operator can read", async () => {
    const { fetchImpl } = recorder([
      {
        body:
          "<CancelDispatchResponse><CancelDispatchResult><ResultCode>7</ResultCode>" +
          "<ResultMessage>Gönderi bulunamadı</ResultMessage></CancelDispatchResult></CancelDispatchResponse>",
      },
    ]);
    await expect(
      runTask("cancel_shipment", { fetchImpl, settings: { integrationCodeField: "carrier_shipment_id" } }),
    ).rejects.toThrow(/Gönderi bulunamadı/);
  });

  test("a row with no key never reaches the wire", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      runTask("cancel_shipment", {
        fetchImpl,
        settings: { integrationCodeField: "carrier_shipment_id" },
        row: { id: "o1" },
      }),
    ).rejects.toThrow(/consignment key/);
    expect(calls).toHaveLength(0);
  });
});
