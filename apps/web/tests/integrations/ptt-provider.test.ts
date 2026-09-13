/**
 * PTT Kargo — the fifth carrier, the third over SOAP, and the most complete of
 * them: book, label, track, cancel.
 *
 * What is PTT's own and worth pinning: its three credentials travel in three
 * different combinations across four operations, a booking reports its verdict
 * twice (once for the batch and once per parcel), the label comes back as
 * printer text rather than a document, its event history carries its own
 * sequence number so ordering is contract rather than luck, and the tracking
 * service sits behind a gateway whose refusal must not read like a bad request.
 *
 * The response bodies below are the live service's shape. The credential
 * refusal in particular is quoted verbatim from a probe against the real
 * acceptance endpoint with deliberately wrong credentials — it arrives as
 * HTTP 200.
 */
import { describe, expect, test } from "bun:test";
import { INTEGRATION_KINDS, INTEGRATION_TASKS, runIntegrationTask } from "@backlex/integrations";
import { parseXml } from "@backlex/integrations/soap";

const CONFIG = { musteriId: "12345", kullanici: "user", sifre: "pass" };

const ROW = {
  id: "f1",
  shipping_name: "Ahmet Aslan",
  shipping_address: "Bağdat Cad. No 1",
  shipping_city: "İstanbul",
  shipping_town: "Kadıköy",
  shipping_phone: "5551112233",
  customer_email: "ahmet@example.com",
  parcel_desi: 3,
  parcel_grams: 1250.4,
  carrier_shipment_id: "PTT0000001234",
};

const BOOK_SETTINGS = {
  receiverNameField: "shipping_name",
  addressField: "shipping_address",
  cityField: "shipping_city",
  townField: "shipping_town",
  phoneField: "shipping_phone",
  emailField: "customer_email",
  desiField: "parcel_desi",
  weightField: "parcel_grams",
  gonderiTip: "1",
  gonderiTur: "2",
};

const BARCODE_SETTINGS = { barcodeField: "carrier_shipment_id" };

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
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${next.body}</soapenv:Body></soapenv:Envelope>`,
      { status: next.status ?? 200 },
    );
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
    "ptt",
    task,
    {
      config: opts.config ?? CONFIG,
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

const booked = (barcode = "PTT0000001234") => ({
  body:
    "<ns:kabulEkle2Response><ns:return>" +
    "<ax21:aciklama>İşlem başarılı</ax21:aciklama><ax21:hataKodu>0</ax21:hataKodu>" +
    `<ax21:dongu><ax21:barkod>${barcode}</ax21:barkod><ax21:donguAciklama>OK</ax21:donguAciklama>` +
    "<ax21:donguHataKodu>0</ax21:donguHataKodu><ax21:donguSonuc>true</ax21:donguSonuc></ax21:dongu>" +
    "</ns:return></ns:kabulEkle2Response>",
});

describe("what PTT ships", () => {
  test("it is a registered carrier answering all four questions, and only tracking repeats", () => {
    expect(INTEGRATION_KINDS).toContain("ptt");
    expect(INTEGRATION_TASKS.ptt?.map((t) => t.id)).toEqual([
      "book_shipment",
      "fetch_label",
      "refresh_tracking",
      "cancel_shipment",
    ]);
    // Booking, labelling and cancelling all have an effect somewhere — the last
    // one writes a fresh artifact into storage every run. Reading does not.
    expect(INTEGRATION_TASKS.ptt?.filter((t) => t.repeatable).map((t) => t.id)).toEqual(["refresh_tracking"]);
  });

  test("the label is declared as a stored artifact, not a URL column", () => {
    const label = INTEGRATION_TASKS.ptt?.find((t) => t.id === "fetch_label");
    expect(label?.outputs.find((o) => o.artifact)?.key).toBe("label");
  });
});

describe("booking a consignment", () => {
  test("it goes to the acceptance service with the urn SOAPAction Axis2 checks", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const call = calls[0]!;
    expect(call.url).toBe("https://pttws.ptt.gov.tr/PttVeriYukleme/services/Sorgu");
    expect(call.headers.SOAPAction).toBe('"urn:kabulEkle2"');
    expect(call.body).toContain('xmlns:op="http://kabul.ptt.gov.tr"');
  });

  test("the booking carries all three credentials and the address as il/ilçe names", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    const result = await runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS });

    const input = sentBody(calls[0]!).input;
    expect(input.kullanici["#"]).toBe("user");
    expect(input.sifre["#"]).toBe("pass");
    // Typed xs:int in the schema, so it is sent as a number rather than as
    // whatever the operator pasted.
    expect(input.musteriId["#"]).toBe("12345");
    expect(input.gonderiTip["#"]).toBe("1");
    expect(input.gonderiTur["#"]).toBe("2");

    const parcel = input.dongu;
    expect(parcel.aliciAdi["#"]).toBe("Ahmet Aslan");
    expect(parcel.aliciIlAdi["#"]).toBe("İstanbul");
    expect(parcel.aliciIlceAdi["#"]).toBe("Kadıköy");
    expect(parcel.aliciTel["#"]).toBe("5551112233");
    expect(parcel.aliciEmail["#"]).toBe("ahmet@example.com");
    expect(parcel.desi["#"]).toBe("3");
    // agirlik is typed xs:int — a decimal on the row must not reach the wire.
    expect(parcel.agirlik["#"]).toBe("1250");

    expect(result.outputs.barcode).toBe("PTT0000001234");
    expect(result.outputs.shipmentStatus).toBe("booked");
  });

  test("an optional field nobody mapped is omitted, not sent empty", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await runTask("book_shipment", {
      fetchImpl,
      settings: { ...BOOK_SETTINGS, emailField: undefined, desiField: undefined, weightField: undefined },
    });
    const parcel = sentBody(calls[0]!).input.dongu;
    expect(parcel.aliciEmail).toBeUndefined();
    expect(parcel.desi).toBeUndefined();
    expect(parcel.agirlik).toBeUndefined();
    // No barcode range issued means PTT assigns one and returns it.
    expect(parcel.barkodNo).toBeUndefined();
  });

  test("a retry re-books the SAME consignment rather than a second one", async () => {
    const a = recorder([booked()]);
    const b = recorder([booked()]);
    await runTask("book_shipment", { fetchImpl: a.fetchImpl, settings: BOOK_SETTINGS, idempotencyKey: "run-9:zz" });
    await runTask("book_shipment", { fetchImpl: b.fetchImpl, settings: BOOK_SETTINGS, idempotencyKey: "run-9:zz" });

    const refOf = (r: typeof a) => sentBody(r.calls[0]!).input.dongu.musteriReferansNo["#"];
    expect(refOf(a)).toBe(refOf(b));
    expect(refOf(a)).toMatch(/^[A-Za-z0-9-]{1,40}$/);
    // The batch is named from the same key, so a retry does not pile up one
    // file per attempt in PTT's own records.
    expect(sentBody(a.calls[0]!).input.dosyaAdi["#"]).toBe(refOf(a));
  });

  test("a refusal arrives as a field inside a 200 and still fails the run", async () => {
    // Quoted from a live probe against the real service with wrong credentials.
    const { fetchImpl } = recorder([
      {
        body:
          "<ns:kabulEkle2Response><ns:return>" +
          "<ax21:aciklama>Kullanıcı Şifre Hatalı</ax21:aciklama><ax21:hataKodu>-1</ax21:hataKodu>" +
          "</ns:return></ns:kabulEkle2Response>",
      },
    ]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /Kullanıcı Şifre Hatalı/,
    );
  });

  test("a batch that succeeded with the only parcel in it rejected is still a failure", async () => {
    // Reading only the outer code would write a barcode-less success onto the
    // row and report the run green.
    const { fetchImpl } = recorder([
      {
        body:
          "<ns:kabulEkle2Response><ns:return><ax21:hataKodu>0</ax21:hataKodu>" +
          "<ax21:dongu><ax21:donguHataKodu>27</ax21:donguHataKodu><ax21:donguSonuc>false</ax21:donguSonuc>" +
          "<ax21:donguAciklama>Alıcı ilçe bulunamadı</ax21:donguAciklama></ax21:dongu>" +
          "</ns:return></ns:kabulEkle2Response>",
      },
    ]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(
      /Alıcı ilçe bulunamadı/,
    );
  });

  test("an accepted batch that named no parcel is a failure, not an empty column", async () => {
    const { fetchImpl } = recorder([
      {
        body:
          "<ns:kabulEkle2Response><ns:return><ax21:hataKodu>0</ax21:hataKodu>" +
          "<ax21:dongu><ax21:donguHataKodu>0</ax21:donguHataKodu></ax21:dongu>" +
          "</ns:return></ns:kabulEkle2Response>",
      },
    ]);
    await expect(runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS })).rejects.toThrow(/no barcode/);
  });

  test("the codes PTT does not publish are demanded rather than guessed", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await expect(
      runTask("book_shipment", { fetchImpl, settings: { ...BOOK_SETTINGS, gonderiTip: undefined } }),
    ).rejects.toThrow(/consignment type/);
    expect(calls.length).toBe(0);
  });
});

describe("fetching the label", () => {
  test("it sends the customer id and password and NO username, and stores printer text", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body:
          "<ns:etiketGetirResponse><ns:return><ax21:aciklama>OK</ax21:aciklama>" +
          "<ax21:epl_format>N\nA50,50,0,3,1,1,N,&quot;PTT&quot;\nP1</ax21:epl_format>" +
          "<ax21:hataKodu>0</ax21:hataKodu></ns:return></ns:etiketGetirResponse>",
      },
    ]);
    const result = await runTask("fetch_label", { fetchImpl, settings: BARCODE_SETTINGS });

    const input = sentBody(calls[0]!).input;
    expect(input.musteriId["#"]).toBe("12345");
    expect(input.sifre["#"]).toBe("pass");
    // The WSDL declares no username on this operation. Sending one anyway would
    // be inventing an argument.
    expect(input.kullanici).toBeUndefined();
    expect(input.barkodNo["#"]).toBe("PTT0000001234");

    expect(result.artifact?.outputKey).toBe("label");
    expect(result.artifact?.filename).toBe("PTT0000001234.epl");
    // EPL is what a thermal printer consumes, so it is stored as the text it is
    // rather than dressed up as a document.
    expect(result.artifact?.contentType).toContain("text/plain");
    expect(new TextDecoder().decode(result.artifact!.bytes)).toContain("A50,50");
  });

  test("a label PTT would not render fails the run rather than storing nothing", async () => {
    const { fetchImpl } = recorder([
      {
        body:
          "<ns:etiketGetirResponse><ns:return><ax21:aciklama>OK</ax21:aciklama>" +
          '<ax21:epl_format xsi:nil="true"/><ax21:hataKodu>0</ax21:hataKodu>' +
          "</ns:return></ns:etiketGetirResponse>",
      },
    ]);
    await expect(runTask("fetch_label", { fetchImpl, settings: BARCODE_SETTINGS })).rejects.toThrow(/no label/);
  });
});

describe("asking where a parcel is", () => {
  const history = (events: string) => ({
    body:
      "<gonderiSorguReturn><sonucKodu>0</sonucKodu><BARNO>PTT0000001234</BARNO>" +
      "<ALICI>Ahmet Aslan</ALICI><GONDEREN>Acme</GONDEREN><GR>1250</GR>" +
      "<VMERK>KADIKÖY ŞUBESİ</VMERK><TESALAN>AHMET ASLAN</TESALAN><ITARIH>2026-08-05 09:00</ITARIH>" +
      events +
      "</gonderiSorguReturn>",
  });

  test("it goes to the tracking service with an EMPTY SOAPAction and no customer id", async () => {
    const { calls, fetchImpl } = recorder([history("<dongu><siraNo>1</siraNo><ISLEM>KABUL</ISLEM></dongu>")]);
    await runTask("refresh_tracking", { fetchImpl, settings: BARCODE_SETTINGS });

    const call = calls[0]!;
    // A different path, a different namespace and a different SOAPAction from
    // the acceptance service on the same host.
    expect(call.url).toBe("https://pttws.ptt.gov.tr/GonderiTakip/services/Sorgu");
    expect(call.headers.SOAPAction).toBe('""');
    expect(call.body).toContain('xmlns:op="http://takip.ptt.gov.tr"');

    const input = sentBody(call).input;
    expect(input.kullanici["#"]).toBe("user");
    expect(input.musteriId).toBeUndefined();
  });

  test("the latest movement is the highest siraNo, whatever order they arrive in", async () => {
    // siraNo is the schema's own sequence number, so unlike every other carrier
    // here the ordering is contract rather than luck — and the transport is
    // free to hand them over shuffled.
    const { fetchImpl } = recorder([
      history(
        "<dongu><siraNo>2</siraNo><ISLEM>DAĞITIMA ÇIKTI</ISLEM><ITARIH>2026-08-07 08:10</ITARIH><IMERK>KADIKÖY</IMERK></dongu>" +
          "<dongu><siraNo>4</siraNo><ISLEM>TESLİM EDİLDİ</ISLEM><ITARIH>2026-08-07 14:22</ITARIH><IMERK>KADIKÖY</IMERK></dongu>" +
          "<dongu><siraNo>1</siraNo><ISLEM>KABUL</ISLEM><ITARIH>2026-08-05 09:00</ITARIH><IMERK>ŞİŞLİ</IMERK></dongu>",
      ),
    ]);
    const result = await runTask("refresh_tracking", { fetchImpl, settings: BARCODE_SETTINGS });

    expect(result.outputs.shipmentStatus).toBe("TESLİM EDİLDİ");
    expect(result.outputs.statusAt).toBe("2026-08-07 14:22");
    expect(result.outputs.statusLocation).toBe("KADIKÖY");
    expect(result.outputs.destinationOffice).toBe("KADIKÖY ŞUBESİ");
    // Present only once somebody has signed for it, which makes it the most
    // reliable "is it delivered" signal in the answer.
    expect(result.outputs.deliveredTo).toBe("AHMET ASLAN");
    expect(result.outputs.receiverName).toBe("Ahmet Aslan");
  });

  test("a barcode PTT has never seen is said so, not written as an empty status", async () => {
    const { fetchImpl } = recorder([{ body: "<gonderiSorguReturn><sonucKodu>0</sonucKodu></gonderiSorguReturn>" }]);
    await expect(runTask("refresh_tracking", { fetchImpl, settings: BARCODE_SETTINGS })).rejects.toThrow(
      /no consignment "PTT0000001234"/,
    );
  });

  test("the gateway's refusal reads as a provisioning step, not as a bad request", async () => {
    // /GonderiTakip/ sits behind a Layer 7 gateway that serves the WSDL to
    // anybody and refuses every POST from an account it has not been told
    // about. Its own words read like a fault in the request.
    const { fetchImpl } = recorder([
      {
        status: 500,
        body:
          "<soapenv:Fault><faultcode>soapenv:Server</faultcode>" +
          "<faultstring>Policy Falsified</faultstring></soapenv:Fault>",
      },
    ]);
    await expect(runTask("refresh_tracking", { fetchImpl, settings: BARCODE_SETTINGS })).rejects.toThrow(
      /İl Müdürlüğü/,
    );
  });
});

describe("cancelling", () => {
  test("it addresses the barcode, with the customer id and password and no username", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body:
          "<ns:barkodVeriSilResponse><ns:return><ax21:aciklama>Silindi</ax21:aciklama>" +
          "<ax21:hataKodu>0</ax21:hataKodu></ns:return></ns:barkodVeriSilResponse>",
      },
    ]);
    const result = await runTask("cancel_shipment", { fetchImpl, settings: BARCODE_SETTINGS });

    const input = sentBody(calls[0]!).inpDelete;
    expect(input.barcode["#"]).toBe("PTT0000001234");
    expect(input.musteriId["#"]).toBe("12345");
    expect(input.kullanici).toBeUndefined();
    expect(result.outputs.shipmentStatus).toBe("cancelled");
    expect(result.outputs.resultMessage).toBe("Silindi");
  });

  test("a consignment already gone fails the run with PTT's own words", async () => {
    const { fetchImpl } = recorder([
      {
        body:
          "<ns:barkodVeriSilResponse><ns:return><ax21:aciklama>Barkod bulunamadı</ax21:aciklama>" +
          "<ax21:hataKodu>-1</ax21:hataKodu></ns:return></ns:barkodVeriSilResponse>",
      },
    ]);
    await expect(runTask("cancel_shipment", { fetchImpl, settings: BARCODE_SETTINGS })).rejects.toThrow(
      /Barkod bulunamadı/,
    );
  });
});

describe("the refusals every task shares", () => {
  test("a customer id that is not a whole number is refused before the request", async () => {
    const { calls, fetchImpl } = recorder([booked()]);
    await expect(
      runTask("book_shipment", { fetchImpl, settings: BOOK_SETTINGS, config: { ...CONFIG, musteriId: "12 345" } }),
    ).rejects.toThrow(/whole number/);
    expect(calls.length).toBe(0);
  });

  test("an unmapped or empty barcode says which field", async () => {
    const { fetchImpl } = recorder([booked()]);
    await expect(runTask("cancel_shipment", { fetchImpl, settings: {} })).rejects.toThrow(
      /needs the row field holding the barcode/,
    );

    const empty = recorder([booked()]);
    await expect(
      runTask("cancel_shipment", {
        fetchImpl: empty.fetchImpl,
        settings: BARCODE_SETTINGS,
        row: { ...ROW, carrier_shipment_id: "  " },
      }),
    ).rejects.toThrow(/holds no PTT barcode/);
  });
});
