/**
 * The SOAP helper — the engine's second wire format.
 *
 * It exists because two national couriers need it and writing it twice would
 * mean two copies free to drift. What is worth pinning here is not that it can
 * parse XML: it is the set of things it deliberately REFUSES to do, because
 * every one of those refusals is what makes parsing a third party's XML inside
 * a worker safe.
 */
import { describe, expect, test } from "bun:test";
import {
  buildBody,
  buildEnvelope,
  escapeXml,
  findNode,
  node,
  nodeList,
  parseXml,
  soapCall,
  SoapFault,
  xmlText,
} from "@backlex/integrations/soap";

describe("what the parser refuses to do", () => {
  test("an external entity is never resolved — the DOCTYPE is skipped whole", () => {
    const hostile =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/hostname"> ]>' +
      "<r><a>&xxe;</a></r>";
    const tree = parseXml(hostile);
    // Left exactly as it arrived: not expanded (that is the vulnerability) and
    // not dropped (that would quietly corrupt a value).
    expect(xmlText(tree, "a")).toBe("&xxe;");
  });

  test("a DOCTYPE's internal subset cannot end the token early and leak elements", () => {
    // The subset contains a `>`; a parser scanning for the first one would
    // resume mid-declaration and parse the rest as markup.
    const doc =
      '<!DOCTYPE r [ <!ELEMENT r (#PCDATA)> <!ENTITY e "x"> ]>' + "<r><real>kept</real></r>";
    const tree = parseXml(doc);
    expect(xmlText(tree, "real")).toBe("kept");
    expect(tree.ELEMENT).toBeUndefined();
  });

  test("a nested-entity bomb has nothing to recurse through", () => {
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]>' +
      "<lolz>&lol2;</lolz>";
    const started = Date.now();
    const tree = parseXml(bomb);
    expect(xmlText(tree, "#")).toBeNull();
    expect(tree["#"]).toBe("&lol2;");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("only the five predefined entities and numeric references expand", () => {
    const tree = parseXml("<r><a>a &amp; b &lt;c&gt; &quot;d&quot; &#66; &#x43; &nope;</a></r>");
    expect(xmlText(tree, "a")).toBe('a & b <c> "d" B C &nope;');
  });

  test("a surrogate half or an out-of-range code point is left alone rather than throwing", () => {
    const tree = parseXml("<r><a>&#xD800; &#x110000;</a></r>");
    expect(xmlText(tree, "a")).toBe("&#xD800; &#x110000;");
  });

  test("CDATA is literal, so it cannot smuggle markup or an entity", () => {
    const tree = parseXml("<r><a><![CDATA[<b>not an element</b> &amp; not an entity]]></a></r>");
    expect(xmlText(tree, "a")).toBe("<b>not an element</b> &amp; not an entity");
    expect(node(tree, "a", "b")).toBeNull();
  });

  test("a document that is not XML at all parses to nothing rather than throwing", () => {
    // A gateway answering an HTML error page is an ordinary failure, and the
    // caller's own missing-field check is a better error than a parser's.
    expect(parseXml("<html><body>502 Bad Gateway")).toBeDefined();
    expect(xmlText(parseXml(""), "anything")).toBeNull();
  });
});

describe("reading a parsed tree", () => {
  const tree = parseXml(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
       <soap:Body>
         <ns2:createShipmentResponse xmlns:ns2="http://yurticikargo.com.tr/x">
           <ShippingOrderResultVO>
             <outFlag>0</outFlag>
             <outResult>Başarılı</outResult>
             <shippingOrderDetailVO>
               <cargoKey>ORDER-1</cargoKey>
               <invoiceKey>INV-1</invoiceKey>
             </shippingOrderDetailVO>
           </ShippingOrderResultVO>
         </ns2:createShipmentResponse>
       </soap:Body>
     </soap:Envelope>`,
  );

  test("namespace prefixes are stripped, so a courier's choice of prefix is not a contract", () => {
    // soap:, s:, SOAP-ENV: are the same element to every caller here.
    expect(node(tree, "Body", "createShipmentResponse")).not.toBeNull();
  });

  test("a path names one thing, and text comes back trimmed", () => {
    const result = node(tree, "Body", "createShipmentResponse", "ShippingOrderResultVO");
    expect(xmlText(result, "outFlag")).toBe("0");
    expect(xmlText(result, "outResult")).toBe("Başarılı");
    expect(xmlText(result, "shippingOrderDetailVO", "cargoKey")).toBe("ORDER-1");
    expect(xmlText(result, "missing")).toBeNull();
  });

  test("one child and many children read the same way", () => {
    // The bug this prevents: an element occurring once parses to a node and
    // twice to an array, so a provider would iterate a single parcel's pieces
    // differently from two.
    const one = parseXml("<r><piece><id>1</id></piece></r>");
    const two = parseXml("<r><piece><id>1</id></piece><piece><id>2</id></piece></r>");
    expect(nodeList(one, "piece").map((p) => xmlText(p, "id"))).toEqual(["1"]);
    expect(nodeList(two, "piece").map((p) => xmlText(p, "id"))).toEqual(["1", "2"]);
    expect(nodeList(one, "absent")).toEqual([]);
  });

  test("a wrapper nobody documented does not break a lookup", () => {
    // .NET generates result element names, and two couriers nest the same
    // payload at different depths.
    expect(xmlText(findNode(tree, "cargoKey"), "#")).toBeNull();
    expect(findNode(tree, "cargoKey")?.["#"]).toBe("ORDER-1");
    expect(findNode(tree, "nothingLikeThis")).toBeNull();
  });

  test("attributes are kept, without their prefixes or namespace declarations", () => {
    const attrs = parseXml('<r><a xmlns:x="urn:x" x:code="7" plain="yes"/></r>');
    expect(node(attrs, "a")?.["@"]).toEqual({ code: "7", plain: "yes" });
  });

  test("self-closing elements do not swallow their siblings", () => {
    const t = parseXml("<r><a/><b>kept</b></r>");
    expect(xmlText(t, "b")).toBe("kept");
  });
});

describe("building a request", () => {
  test("an envelope carries the operation in its own namespace", () => {
    const xml = buildEnvelope({
      namespace: "http://yurticikargo.com.tr/ShippingOrderDispatcherServices",
      operation: "createShipment",
      body: { wsUserName: "u", wsPassword: "p" },
    });
    expect(xml).toContain('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">');
    expect(xml).toContain(
      '<op:createShipment xmlns:op="http://yurticikargo.com.tr/ShippingOrderDispatcherServices">',
    );
    expect(xml).toContain("<wsUserName>u</wsUserName>");
  });

  test("null and undefined are omitted, not sent as empty elements", () => {
    // A courier reading an empty <phone/> as "clear the phone" is a different
    // thing from never being told about it.
    expect(buildBody({ a: "1", b: null, c: undefined, d: 0, e: false })).toBe(
      "<a>1</a><d>0</d><e>false</e>",
    );
  });

  test("nested objects and repeated values keep the shape the schema wants", () => {
    expect(buildBody({ order: { id: 1, piece: ["a", "b"] } })).toBe(
      "<order><id>1</id><piece>a</piece><piece>b</piece></order>",
    );
  });

  test("a value that looks like markup is escaped rather than injected", () => {
    const xml = buildBody({ note: '</note><evil>x</evil><note attr="' });
    expect(xml).toBe("<note>&lt;/note&gt;&lt;evil&gt;x&lt;/evil&gt;&lt;note attr=&quot;</note>");
    // …and it survives a round trip as the text it was.
    expect(xmlText(parseXml(`<r>${xml}</r>`), "note")).toBe('</note><evil>x</evil><note attr="');
  });

  test("escaping covers the five characters that matter", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("calling a service", () => {
  const ok = (body: string) =>
    async () =>
      new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`,
      );

  const req = { namespace: "urn:x", operation: "doThing", body: { a: "1" } };

  test("the body comes back parsed, with the envelope already unwrapped", async () => {
    const body = await soapCall(ok("<doThingResponse><out>7</out></doThingResponse>"), "https://x/svc", req);
    expect(xmlText(body, "doThingResponse", "out")).toBe("7");
  });

  test("SOAP 1.1 sends a SOAPAction header and 1.2 does not", async () => {
    const seen: RequestInit[] = [];
    const capture = async (_u: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("<soap:Envelope><soap:Body/></soap:Envelope>");
    };
    await soapCall(capture, "https://x/svc", { ...req, action: "urn:x#doThing" });
    await soapCall(capture, "https://x/svc", { ...req, version: "1.2" });

    const first = seen[0]!.headers as Record<string, string>;
    expect(first["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(first.SOAPAction).toBe('"urn:x#doThing"');
    const second = seen[1]!.headers as Record<string, string>;
    expect(second["Content-Type"]).toBe("application/soap+xml; charset=utf-8");
    expect(second.SOAPAction).toBeUndefined();
  });

  test("a fault throws whatever the HTTP status says", async () => {
    // Services disagree about whether a fault is a 200 or a 500, and a provider
    // should not have to care.
    const fault =
      "<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Müşteri bulunamadı</faultstring></soap:Fault>";
    for (const status of [200, 500]) {
      const call = soapCall(
        async () =>
          new Response(
            `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${fault}</soap:Body></soap:Envelope>`,
            { status },
          ),
        "https://x/svc",
        req,
      );
      await expect(call).rejects.toThrow(SoapFault);
      await expect(call).rejects.toThrow(/Müşteri bulunamadı/);
    }
  });

  test("a SOAP 1.2 fault is read from its own element names", async () => {
    const fault =
      "<Fault><Code><Value>Sender</Value></Code><Reason><Text>bad input</Text></Reason></Fault>";
    await expect(
      soapCall(async () => new Response(`<Envelope><Body>${fault}</Body></Envelope>`), "https://x/svc", req),
    ).rejects.toThrow(/bad input/);
  });

  test("a non-2xx with no fault in it is an ordinary error carrying the body", async () => {
    await expect(
      soapCall(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }), "https://x/svc", req),
    ).rejects.toThrow(/502.*Bad Gateway/s);
  });
});
