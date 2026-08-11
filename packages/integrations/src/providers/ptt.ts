import { defineProvider } from "../provider";
import { findNode, nodeList, soapCall, SoapFault, xmlText, type SoapValue, type XmlNode } from "../soap";

/**
 * PTT Kargo — book a consignment, print its label, ask where it is, cancel it.
 *
 * The fifth carrier, the third over SOAP, and the most complete of them: it is
 * the first national courier here that answers all four questions, and the
 * first since EasyPost to hand back a label.
 *
 * Its whole surface comes from two published WSDLs, readable without any
 * credential:
 *
 * - **Acceptance** — `pttws.ptt.gov.tr/PttVeriYukleme/services/Sorgu?wsdl`,
 *   namespace `http://kabul.ptt.gov.tr`, Axis2, `soapAction: urn:<operation>`.
 *   `kabulEkle2` books, `etiketGetir` returns the label, `barkodVeriSil` and
 *   `referansVeriSil` cancel.
 * - **Tracking** — `pttws.ptt.gov.tr/GonderiTakip/services/Sorgu?wsdl`,
 *   namespace `http://takip.ptt.gov.tr`, Axis 1.4, **empty soapAction**.
 *   `gonderiSorgu` answers with the parcel's whole event history.
 *
 * The credentials themselves come from a PTT İl Müdürlüğü. The contracts do
 * not — which is what unblocked this file, exactly as it unblocked Yurtiçi and
 * Aras before it.
 *
 * ## Four things the code depends on, three of them verified live
 *
 * **A refusal is a field inside a 200.** Probed against the real service with
 * deliberately wrong credentials, `etiketGetir` answers HTTP 200 carrying
 * `<hataKodu>-1</hataKodu><aciklama>Kullanıcı Şifre Hatalı</aciklama>`. A
 * provider that only checked the HTTP status would report every refusal here as
 * a clean booking. See {@link readOutcome}. Tracking spells the same idea
 * `sonucKodu` / `sonucAciklama`, and a booking says it a second time per parcel
 * in `dongu.donguHataKodu`.
 *
 * **The three credentials travel in different combinations per operation, and
 * that is the WSDL rather than a transcription error.** `kabulEkle2` wants
 * `kullanici` + `sifre` + `musteriId`; `etiketGetir` and `barkodVeriSil` want
 * `musteriId` + `sifre` and no username at all; `gonderiSorgu` wants
 * `kullanici` + `sifre` and no customer id. This is why {@link credentials}
 * hands back the three values rather than a ready-made argument object — each
 * call site names the subset its operation declares.
 *
 * **We choose the reference, PTT chooses the barcode.** `musteriReferansNo` is
 * ours, derived from the engine's idempotency key, so a retry that gets past
 * the once-only guard re-books the SAME consignment rather than putting a
 * second one on a courier's manifest. The barcode comes back in the answer and
 * is what every other operation here addresses — the label, the tracking and
 * the cancel all take `barkodNo`, so one row field serves all three. PTT also
 * publishes `referansVeriSil`, which cancels by our reference instead; it is
 * the door to use if a booking's answer was lost before the barcode reached the
 * row.
 *
 * **Unprefixed child elements are accepted**, even though both schemas declare
 * `elementFormDefault="qualified"`. Probed both ways against the live
 * acceptance service: identical answers. That is what lets this file use the
 * shared envelope builder unchanged.
 *
 * ## Why the tracking task ships even though it cannot be called yet
 *
 * `/GonderiTakip/` sits behind a Layer 7 gateway that serves the WSDL to
 * anybody and refuses every POST to it with `Policy Falsified — Service Not
 * Found`, whatever the body. That is a routing policy opened per customer, not
 * a fault in the request: the acceptance service on the same host answers
 * normally.
 *
 * This is the opposite of Aras's missing tracking task and the reason the two
 * decisions differ. Aras's tracking operations return an untyped .NET DataSet,
 * so the field names cannot be known and the task cannot be *written*. PTT's
 * are fully typed in a published WSDL, so the task is written correctly and the
 * only open question is whether a given customer's account is routed. Withholding
 * it would mean withholding working code that is one provisioning step away —
 * so it ships, and {@link call} turns the gateway's refusal into a sentence
 * saying which office to ask rather than a raw SOAP fault.
 */

/** The acceptance service: booking, labels, cancellation. Axis2. */
const KABUL_ENDPOINT = "https://pttws.ptt.gov.tr/PttVeriYukleme/services/Sorgu";
const KABUL_NAMESPACE = "http://kabul.ptt.gov.tr";

/** The tracking service. A different host path, namespace and SOAPAction. */
const TAKIP_ENDPOINT = "https://pttws.ptt.gov.tr/GonderiTakip/services/Sorgu";
const TAKIP_NAMESPACE = "http://takip.ptt.gov.tr";

export const ptt = defineProvider({
  id: "ptt",
  label: "PTT Kargo",
  category: "carrier",
  capabilities: ["task"],
  /**
   * No published quota. Paced modestly anyway, as every courier here is: these
   * are per-row operations an operator or a flow triggers, so nothing walks
   * pages, and a state courier's integration endpoint is not a service to
   * hammer.
   */
  limits: { rps: 5, burst: 10 },
  configFields: [
    {
      key: "musteriId",
      label: "Customer id (müşteri no)",
      placeholder: "the numeric customer id from your PTT integration document",
    },
    { key: "kullanici", label: "Web service username", secret: true },
    { key: "sifre", label: "Web service password", secret: true },
  ],
  tasks: [
    {
      id: "book_shipment",
      label: "Book a consignment",
      /**
       * Deliberately NOT repeatable: booking twice puts two consignments on a
       * courier's manifest and someone turns up to collect a parcel that does
       * not exist. The engine's task-run row is the first guard and
       * {@link consignmentReference} is the second — a retry that gets past the
       * first re-books the same reference.
       */
      settingFields: [
        rowField("receiverNameField", "Receiver name field", "e.g. shipping_name"),
        rowField("addressField", "Receiver address field", "e.g. shipping_address"),
        rowField("cityField", "City (il) field", "e.g. shipping_city"),
        rowField("townField", "Town (ilçe) field", "e.g. shipping_town"),
        rowField("phoneField", "Receiver phone field", "e.g. shipping_phone"),
        rowField("emailField", "Receiver email field (optional)", "e.g. customer_email"),
        rowField("smsField", "Receiver SMS number field (optional)", "e.g. shipping_phone"),
        rowField("weightField", "Weight field (optional)", "whole number, in the unit your PTT document gives"),
        rowField("desiField", "Volumetric weight (desi) field (optional)", "e.g. parcel_desi"),
        rowField("valueField", "Declared value field (optional)", "e.g. order_total"),
        rowField("barcodeField", "Barcode field (optional)", "only if PTT issued you a barcode range"),
        /**
         * Free text rather than pickers, unlike every other closed choice in
         * this engine. PTT's WSDL types all four as plain strings and
         * enumerates none of them — the accepted values are in the integration
         * document handed over with the credentials, and a dropdown built from
         * a guess reads as a promise the code cannot keep. The same call
         * Yurtiçi's `keyType` made, for the same reason.
         */
        rowField("gonderiTip", "Consignment type (gönderi tipi)", "the code from your PTT integration document"),
        rowField("gonderiTur", "Consignment kind (gönderi türü)", "the code from your PTT integration document"),
        rowField("odemesekli", "Payment method (ödeme şekli) (optional)", "the code from your PTT document"),
        rowField("teslimTip", "Delivery type (teslim tipi) (optional)", "the code from your PTT document"),
        rowField("ekhizmet", "Extra service (ek hizmet) (optional)", "the code from your PTT document"),
      ],
      outputs: [
        { key: "barcode", label: "Barcode" },
        { key: "referenceNo", label: "Our reference" },
        { key: "resultMessage", label: "Carrier message" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "bookedAt", label: "Booked at" },
      ],
      async run(ctx) {
        const creds = credentials(ctx);
        const referenceNo = consignmentReference(ctx.idempotencyKey);

        const parcel: Record<string, SoapValue> = {
          aliciAdi: requiredRowValue(ctx, "receiverNameField", "receiver name"),
          aAdres: requiredRowValue(ctx, "addressField", "receiver address"),
          aliciIlAdi: requiredRowValue(ctx, "cityField", "city"),
          aliciIlceAdi: requiredRowValue(ctx, "townField", "town"),
          aliciTel: requiredRowValue(ctx, "phoneField", "receiver phone"),
          aliciEmail: optionalRowValue(ctx, "emailField"),
          aliciSms: optionalRowValue(ctx, "smsField"),
          agirlik: optionalRowInteger(ctx, "weightField"),
          desi: optionalRowNumber(ctx, "desiField"),
          deger_ucreti: optionalRowNumber(ctx, "valueField"),
          // Ours, and the whole retry story. `referansVeriSil` addresses it.
          musteriReferansNo: referenceNo,
          // Only sent when PTT issued the seller a barcode range; left out
          // otherwise so PTT assigns one and returns it.
          barkodNo: optionalRowValue(ctx, "barcodeField"),
          odemesekli: ctx.setting("odemesekli"),
          teslim_tip: ctx.setting("teslimTip"),
          ekhizmet: ctx.setting("ekhizmet"),
        };

        const body = await call(ctx, "kabul", "kabulEkle2", {
          input: {
            kullanici: creds.kullanici,
            sifre: creds.sifre,
            musteriId: creds.musteriId,
            // The batch's name. Derived from the idempotency key like the
            // reference, so a retry names the same batch rather than piling up
            // one file per attempt in PTT's own records.
            dosyaAdi: referenceNo,
            gonderiTip: requiredSetting(ctx, "gonderiTip", "consignment type"),
            gonderiTur: requiredSetting(ctx, "gonderiTur", "consignment kind"),
            dongu: parcel,
          },
        });

        const answer = findNode(body, "return");
        readOutcome(answer, "book the consignment");

        // The batch answers once for itself and again per parcel. A task books
        // one, so there is exactly one — but it is read as a list because that
        // is what the schema says, and a single-element list must not read
        // differently from a longer one.
        const first = nodeList(answer, "dongu")[0] ?? findNode(answer, "dongu");
        readParcelOutcome(first);

        const barcode = xmlText(first, "barkod");
        // PTT accepted the batch but named no parcel — which would leave the
        // row with nothing to track, label or cancel by. Saying so beats a
        // successful run and an empty column.
        if (!barcode) throw new Error("PTT accepted the consignment but returned no barcode");

        return {
          outputs: {
            barcode,
            referenceNo,
            resultMessage: xmlText(first, "donguAciklama") ?? xmlText(answer, "aciklama"),
            shipmentStatus: "booked",
            bookedAt: Date.now(),
          },
        };
      },
    },
    {
      id: "fetch_label",
      label: "Fetch the shipping label",
      /**
       * NOT repeatable, and it is the one task here where that is a judgement
       * rather than an obvious call. Asking PTT to render a label again has no
       * effect on the parcel — but it DOES write a new artifact into storage
       * every time, and a repeatable task on a cron would fill a bucket with
       * copies of one label. Re-run it deliberately when a label is genuinely
       * needed again.
       */
      settingFields: [rowField("barcodeField", "Barcode field", "the row field book_shipment wrote, e.g. carrier_shipment_id")],
      outputs: [
        /**
         * The label is stored and the row is given its storage key, not a URL —
         * the same way every other stored file on this platform is held. A
         * signed URL expires, and a column full of dead links is worse than one
         * the reader signs on demand.
         */
        { key: "label", label: "Label file", artifact: true },
        { key: "resultMessage", label: "Carrier message" },
      ],
      async run(ctx) {
        const creds = credentials(ctx);
        const barcode = readBarcode(ctx);

        const body = await call(ctx, "kabul", "etiketGetir", {
          // No username on this operation. That is the WSDL, not an omission.
          input: { barkodNo: barcode, musteriId: creds.musteriId, sifre: creds.sifre },
        });

        const answer = findNode(body, "return");
        readOutcome(answer, "fetch the label");

        const epl = xmlText(answer, "epl_format");
        if (!epl) throw new Error(`PTT returned no label for barcode "${barcode}"`);

        return {
          outputs: { resultMessage: xmlText(answer, "aciklama") },
          artifact: {
            outputKey: "label",
            filename: `${barcode}.epl`,
            /**
             * EPL is Eltron's printer language: the bytes a thermal label
             * printer consumes, not a document. Stored as the text it is rather
             * than dressed up as a PDF — a warehouse sends this straight to the
             * printer, and converting it would mean re-rendering somebody
             * else's label layout.
             */
            contentType: "text/plain; charset=utf-8",
            bytes: new TextEncoder().encode(epl),
          },
        };
      },
    },
    {
      id: "refresh_tracking",
      label: "Refresh tracking",
      /**
       * The read half, and genuinely repeatable: where a parcel is has no side
       * effect at PTT and the whole value of the answer is that it moves. Under
       * the once-only guard the row would keep whatever the first poll said.
       * Put it on a cron flow over the consignments that are not delivered yet.
       *
       * Note this is the one task whose service sits behind a gateway opened
       * per customer — see the header. A run that fails with "did not route the
       * request" is a provisioning answer, not a bug in the mapping.
       */
      repeatable: true,
      settingFields: [rowField("barcodeField", "Barcode field", "the row field book_shipment wrote, e.g. carrier_shipment_id")],
      outputs: [
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "statusAt", label: "Status reported at" },
        { key: "statusLocation", label: "Last known office" },
        { key: "destinationOffice", label: "Destination office" },
        { key: "deliveredTo", label: "Received by" },
        { key: "receiverName", label: "Receiver" },
        { key: "senderName", label: "Sender" },
        { key: "weight", label: "Weight" },
        { key: "acceptedAt", label: "Accepted at" },
      ],
      async run(ctx) {
        const creds = credentials(ctx);
        const barcode = readBarcode(ctx);

        const body = await call(ctx, "takip", "gonderiSorgu", {
          // No customer id on this operation, and the outcome field is spelled
          // differently too. Both are the WSDL's doing.
          input: { barkod: barcode, kullanici: creds.kullanici, sifre: creds.sifre },
        });

        const answer = findNode(body, "gonderiSorguReturn") ?? findNode(body, "return");
        readTrackingOutcome(answer, barcode);

        const latest = latestEvent(answer);
        return {
          outputs: {
            // PTT's own words for what happened, kept rather than remapped onto
            // an invented neutral set: a second status list is a second thing to
            // keep in step, and the operator's panel shows these words.
            shipmentStatus: xmlText(latest, "ISLEM"),
            statusAt: xmlText(latest, "ITARIH"),
            statusLocation: xmlText(latest, "IMERK"),
            destinationOffice: xmlText(answer, "VMERK"),
            // Present only once somebody has signed for the parcel, which makes
            // it the most reliable "is it delivered" signal in the answer.
            deliveredTo: xmlText(answer, "TESALAN"),
            receiverName: xmlText(answer, "ALICI"),
            senderName: xmlText(answer, "GONDEREN"),
            weight: xmlText(answer, "GR"),
            acceptedAt: xmlText(answer, "ITARIH"),
          },
        };
      },
    },
    {
      id: "cancel_shipment",
      label: "Cancel a consignment",
      /**
       * NOT repeatable. Cancelling is a request to a courier, and asking twice
       * is asking twice — the second is answered with an error about a
       * consignment that is already gone, which reaches an operator as a failed
       * run they did not cause.
       *
       * Addressed by barcode rather than by our reference, though PTT publishes
       * both doors. The barcode is what PTT itself keys the parcel by and what
       * the label and tracking tasks already take, so one row field serves all
       * three instead of the row having to carry two keys.
       */
      settingFields: [rowField("barcodeField", "Barcode field", "the row field book_shipment wrote, e.g. carrier_shipment_id")],
      outputs: [
        { key: "resultMessage", label: "Carrier message" },
        { key: "shipmentStatus", label: "Carrier status" },
        { key: "cancelledAt", label: "Cancelled at" },
      ],
      async run(ctx) {
        const creds = credentials(ctx);
        const barcode = readBarcode(ctx);

        const body = await call(ctx, "kabul", "barkodVeriSil", {
          inpDelete: {
            barcode,
            musteriId: creds.musteriId,
            sifre: creds.sifre,
            dosyaAdi: consignmentReference(ctx.idempotencyKey),
          },
        });

        const answer = findNode(body, "return");
        readOutcome(answer, "cancel the consignment");

        return {
          outputs: {
            resultMessage: xmlText(answer, "aciklama"),
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
 * The three credentials, handed back separately.
 *
 * Separately rather than as a ready-made argument object because PTT's four
 * operations want three different subsets of them: booking takes all three,
 * the label and the cancel take the customer id and password with no username,
 * and tracking takes the username and password with no customer id. Each call
 * site names what its own operation declares.
 *
 * They reach an XML body rather than a header, so the injection risk is markup
 * rather than a newline — and the envelope builder escapes it. The
 * control-character check is still worth having for the reason it is everywhere
 * else in this engine: a credential with one in it is a paste that went wrong,
 * and saying so beats an authentication refusal nobody can act on.
 */
const credentials = (ctx: {
  str(k: string): string | null;
}): { musteriId: number; kullanici: string; sifre: string } => {
  const kullanici = ctx.str("kullanici");
  const sifre = ctx.str("sifre");
  if (!kullanici || !sifre) throw new Error("PTT task has no web service username and password");
  if (/[\p{Cc}]/u.test(`${kullanici}${sifre}`)) {
    throw new Error("PTT username and password must not contain control characters — check for a bad paste");
  }

  // Typed `xs:int` in both schemas, so it is sent as a number rather than as
  // whatever the operator pasted — a customer id with a stray space in it would
  // otherwise reach PTT as an unparseable element.
  const raw = ctx.str("musteriId");
  const musteriId = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(musteriId) || musteriId < 0) {
    throw new Error("PTT customer id must be a whole number — it is the müşteri no from your integration document");
  }

  return { musteriId, kullanici, sifre };
};

/**
 * Send an operation to one of PTT's two services.
 *
 * The two differ in more than their address: the acceptance service is Axis2
 * and checks a `urn:`-prefixed SOAPAction, while tracking is Axis 1.4 and
 * declares an empty one. Sending the wrong one is answered with a fault about
 * an operation nobody asked for.
 */
const call = (
  ctx: { fetch: (u: string, i?: RequestInit) => Promise<Response> },
  service: "kabul" | "takip",
  operation: string,
  body: Record<string, SoapValue>,
): Promise<XmlNode> =>
  soapCall(ctx.fetch, service === "kabul" ? KABUL_ENDPOINT : TAKIP_ENDPOINT, {
    namespace: service === "kabul" ? KABUL_NAMESPACE : TAKIP_NAMESPACE,
    operation,
    body,
    action: service === "kabul" ? `urn:${operation}` : "",
  }).catch((e: unknown) => {
    if (e instanceof SoapFault) {
      // PTT's tracking service sits behind a gateway that refuses to route a
      // request from an account it has not been told about, whatever the body
      // says. Its own words — "Policy Falsified" — read like a bug in the
      // request, so they are translated into the thing an operator can actually
      // go and do.
      if (/policy falsified|service not found/i.test(e.message)) {
        throw new Error(
          "PTT's gateway did not route the request — that service is opened per customer, so ask your PTT İl Müdürlüğü to enable it for this account",
        );
      }
      throw new Error(`PTT refused the request: ${e.message.slice(0, 160)}`);
    }
    throw e;
  });

/**
 * Our reference for this consignment.
 *
 * Derived from the engine's idempotency key, which is stable for this
 * (integration, task, row) and identical across every retry — so a retry that
 * gets past the once-only guard re-books the SAME consignment rather than
 * putting a second one on a courier's manifest. There is no idempotency header
 * here to fall back on, which is what makes this the guard that matters.
 */
const consignmentReference = (idempotencyKey: string): string =>
  idempotencyKey.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "backlex";

// ── Outcomes ─────────────────────────────────────────────────────────────────

/**
 * Turn the acceptance service's outcome fields into a thrown error, or nothing.
 *
 * This is why a provider cannot just check the HTTP status. Verified against
 * the live service with wrong credentials: it answers **HTTP 200** carrying
 * `<hataKodu>-1</hataKodu><aciklama>Kullanıcı Şifre Hatalı</aciklama>`, so a
 * refusal looks exactly like a success until this reads the field. Zero is no
 * error; an answer with no return element at all is a refusal too, because it
 * means the operation returned nothing to be the outcome of.
 */
const readOutcome = (answer: XmlNode | null, what: string): void => {
  if (!answer) throw new Error(`PTT returned no result and could not ${what}`);
  const code = xmlText(answer, "hataKodu");
  if (code === null || code === "0") return;
  const message = xmlText(answer, "aciklama");
  throw new Error(`PTT could not ${what} (${code})${message ? `: ${message.slice(0, 160)}` : ""}`);
};

/**
 * The same check again, one level down.
 *
 * A booking is a batch, and PTT reports on the batch AND on each parcel in it.
 * The batch can succeed while the only parcel in it is rejected — a bad ilçe,
 * say — so reading only the outer code would write a barcode-less success onto
 * the row. `donguSonuc` is the boolean it states the same verdict in.
 */
const readParcelOutcome = (parcel: XmlNode | null): void => {
  if (!parcel) throw new Error("PTT accepted the batch but reported on no parcel in it");
  const code = xmlText(parcel, "donguHataKodu");
  const ok = xmlText(parcel, "donguSonuc");
  if ((code === null || code === "0") && ok !== "false") return;
  const message = xmlText(parcel, "donguAciklama");
  throw new Error(`PTT refused the consignment${code ? ` (${code})` : ""}${message ? `: ${message.slice(0, 160)}` : ""}`);
};

/** Tracking spells the same idea with different field names. */
const readTrackingOutcome = (answer: XmlNode | null, barcode: string): void => {
  if (!answer) throw new Error("PTT returned no result and could not read the tracking");
  const code = xmlText(answer, "sonucKodu");
  if (code !== null && code !== "0") {
    const message = xmlText(answer, "sonucAciklama");
    throw new Error(`PTT could not read the tracking (${code})${message ? `: ${message.slice(0, 160)}` : ""}`);
  }
  if (!findNode(answer, "dongu") && !xmlText(answer, "BARNO")) {
    throw new Error(`PTT has no consignment "${barcode}"`);
  }
};

/**
 * The most recent movement in the parcel's history.
 *
 * `siraNo` is the schema's own sequence number, so unlike every other carrier
 * here the order IS part of the published contract and does not have to be
 * guessed from the transport's whim. The highest one is the latest; an entry
 * without one sorts below every entry that has one rather than being dropped,
 * because a movement PTT recorded is still a movement.
 */
const latestEvent = (answer: XmlNode | null): XmlNode | null => {
  const events = nodeList(answer, "dongu");
  if (events.length === 0) return null;
  let best = events[0] ?? null;
  let bestNo = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const raw = xmlText(event, "siraNo");
    const no = raw === null ? Number.NEGATIVE_INFINITY : Number(raw);
    if (Number.isFinite(no) && no > bestNo) {
      bestNo = no;
      best = event;
    }
  }
  return best;
};

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * One row-field setting.
 *
 * A function rather than shared constants so the four tasks cannot end up
 * holding one object between them — the descriptor is spread into the catalog,
 * and a frozen instance shared across tasks is an unpleasant surprise the day
 * anything mutates it.
 */
function rowField(key: string, label: string, placeholder: string) {
  return { key, label, placeholder };
}

const readBarcode = (ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null }): string => {
  const field = ctx.setting("barcodeField");
  if (!field) throw new Error("PTT task needs the row field holding the barcode");
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no PTT barcode`);
  return value;
};

const requiredSetting = (ctx: { setting(k: string): string | null }, key: string, what: string): string => {
  const value = ctx.setting(key);
  if (!value) throw new Error(`PTT booking needs the ${what} from your integration document`);
  return value;
};

const requiredRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
  what: string,
): string => {
  const field = ctx.setting(settingKey);
  if (!field) throw new Error(`PTT booking needs the row field holding the ${what}`);
  const value = text(ctx.row[field]);
  if (!value) throw new Error(`Row field "${field}" holds no ${what} to send to PTT`);
  return value;
};

const optionalRowValue = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): string | null => {
  const field = ctx.setting(settingKey);
  return field ? text(ctx.row[field]) : null;
};

const optionalRowNumber = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): number | null => {
  const field = ctx.setting(settingKey);
  return field ? num(ctx.row[field]) : null;
};

/** `agirlik`, `en`, `boy` and `yukseklik` are typed `xs:int` — never a decimal. */
const optionalRowInteger = (
  ctx: { row: Readonly<Record<string, unknown>>; setting(k: string): string | null },
  settingKey: string,
): number | null => {
  const n = optionalRowNumber(ctx, settingKey);
  return n === null ? null : Math.round(n);
};

// ── Shared ───────────────────────────────────────────────────────────────────

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Re-exported so the tests and the docs read one source for the wire addresses. */
export const PTT_KABUL_ENDPOINT = KABUL_ENDPOINT;
export const PTT_TAKIP_ENDPOINT = TAKIP_ENDPOINT;
