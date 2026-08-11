/**
 * The little bit of SOAP this engine needs, and nothing more.
 *
 * Every provider that shipped before this one speaks JSON. The national Turkish
 * couriers do not: Aras and Yurtiçi both publish a WSDL and expect an XML
 * envelope, and that is not a quirk one provider can absorb — it is a second
 * wire format. Two providers needing it is the point at which it belongs here
 * rather than being written twice and drifting.
 *
 * What this is NOT is a SOAP client. There is no WSDL parsing, no schema
 * validation, no code generation and no type mapping. A provider knows the
 * operation it wants and the fields it carries; this turns that into a request
 * and turns the answer into something a provider can read fields off. Anything
 * cleverer would be a dependency, and this package is deliberately dependency
 * free so it runs unchanged on Workers and on Bun.
 *
 * ## The parser refuses to be clever, on purpose
 *
 * XML parsing is where XML gets dangerous, and every one of those dangers comes
 * from a feature this parser does not have:
 *
 * - **No DOCTYPE processing.** A `<!DOCTYPE …>` is skipped as a token, never
 *   read. That is what makes XXE — an entity that resolves to a local file or a
 *   URL — structurally impossible rather than merely unlikely.
 * - **No custom entities.** Only the five XML predefines and numeric character
 *   references are expanded, so the billion-laughs expansion has nothing to
 *   recurse through.
 * - **No external anything.** No schema fetch, no import, no include.
 *
 * A hostile response therefore costs a parse that returns nonsense, which every
 * caller already has to handle, rather than a request from inside the worker.
 */

import type { FetchLike } from "./provider";

/**
 * A parsed element.
 *
 * Deliberately plain: attributes on `@`, text on `#`, and children under their
 * own names. A name that appears more than once becomes an array — which is
 * what makes a single-item list and a many-item list read differently, so
 * {@link nodeList} exists to paper over exactly that.
 *
 * Namespace prefixes are STRIPPED from names. `soap:Envelope`, `s:Envelope` and
 * `SOAP-ENV:Envelope` are the same element to every caller here, and carrying
 * the prefix would mean every provider guessing which one its courier picked
 * today.
 */
export interface XmlNode {
  /** Attributes, without their prefixes. Absent when the element had none. */
  "@"?: Record<string, string>;
  /** The element's own text, trimmed. Absent when it had none. */
  "#"?: string;
  [child: string]: XmlNode | XmlNode[] | Record<string, string> | string | undefined;
}

/** Escape a value for an XML text node or attribute. */
export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * The five predefined entities and numeric references, and nothing else.
 *
 * An unknown entity is left EXACTLY as it was rather than dropped or expanded.
 * Dropping it would quietly corrupt a value; expanding it is the vulnerability.
 * Leaving it visible is the only answer that is neither.
 */
const unescapeXml = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X") ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      // Anything outside Unicode, or a surrogate half, is not a character —
      // `fromCodePoint` would throw, and a throw here is a parse that fails on
      // data rather than on structure.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] ?? whole;
  });

/** A name without its namespace prefix. `tns:createShipment` → `createShipment`. */
const localName = (name: string): string => {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
};

/**
 * Parse an XML document into a tree of {@link XmlNode}.
 *
 * Returns the ROOT element's node. A document that does not parse returns an
 * empty node rather than throwing: a courier answering HTML from a gateway is
 * an ordinary failure, and the caller's own "the field I wanted is missing"
 * check is a better error than a parser's.
 */
export const parseXml = (xml: string): XmlNode => {
  const root: XmlNode = {};
  const stack: XmlNode[] = [root];
  let i = 0;

  const push = (parent: XmlNode, name: string, node: XmlNode): void => {
    const existing = parent[name];
    if (existing === undefined) parent[name] = node;
    else if (Array.isArray(existing)) existing.push(node);
    else parent[name] = [existing as XmlNode, node];
  };

  while (i < xml.length) {
    const open = xml.indexOf("<", i);
    if (open < 0) break;

    // Text between elements belongs to whatever is currently open.
    if (open > i) {
      const text = unescapeXml(xml.slice(i, open)).trim();
      if (text) {
        const top = stack[stack.length - 1];
        if (top) top["#"] = (top["#"] ?? "") + text;
      }
    }

    // The three things that are markup but not elements. A DOCTYPE is SKIPPED
    // as an opaque token and never interpreted — that is the whole XXE defence.
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open);
      const raw = xml.slice(open + 9, end < 0 ? xml.length : end);
      const top = stack[stack.length - 1];
      // CDATA is literal by definition — no entity expansion, which is also why
      // it cannot smuggle one.
      if (top && raw.trim()) top["#"] = (top["#"] ?? "") + raw.trim();
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<!", open) || xml.startsWith("<?", open)) {
      const end = skipDeclaration(xml, open);
      i = end;
      continue;
    }

    const close = xml.indexOf(">", open);
    if (close < 0) break;
    const inner = xml.slice(open + 1, close);

    if (inner.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      i = close + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const source = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = source.search(/[\s/]/);
    const name = localName(nameEnd < 0 ? source : source.slice(0, nameEnd));
    if (!name) {
      i = close + 1;
      continue;
    }

    const node: XmlNode = {};
    const attrs = nameEnd < 0 ? "" : source.slice(nameEnd);
    const parsedAttrs = parseAttributes(attrs);
    if (parsedAttrs) node["@"] = parsedAttrs;

    const parent = stack[stack.length - 1];
    if (parent) push(parent, name, node);
    if (!selfClosing) stack.push(node);
    i = close + 1;
  }

  // The root wrapper holds exactly one child for a well-formed document.
  const first = Object.keys(root)[0];
  const value = first === undefined ? undefined : root[first];
  if (value === undefined) return {};
  return Array.isArray(value) ? (value[0] ?? {}) : (value as XmlNode);
};

/**
 * Skip a `<!…>` or `<?…?>` token whole.
 *
 * A DOCTYPE may carry an internal subset in brackets, and that subset can
 * contain `>` — so nesting is tracked rather than scanning for the first one.
 * Getting this wrong would end the token early and let the rest of a
 * declaration be parsed as elements.
 */
const skipDeclaration = (xml: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  return xml.length;
};

const parseAttributes = (source: string): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  let found = false;
  const re = /([\w.:-]+)\s*=\s*"([^"]*)"|([\w.:-]+)\s*=\s*'([^']*)'/g;
  let m = re.exec(source);
  while (m !== null) {
    const name = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    if (name !== undefined && value !== undefined) {
      // Namespace declarations are the parser's business, not a provider's, and
      // the parser has already stripped prefixes.
      if (name !== "xmlns" && !name.startsWith("xmlns:")) {
        out[localName(name)] = unescapeXml(value);
        found = true;
      }
    }
    m = re.exec(source);
  }
  return found ? out : undefined;
};

// ── Reading a parsed tree ────────────────────────────────────────────────────

/**
 * Walk a path of child names and return the node at the end, or `null`.
 *
 * Where a name repeats, the FIRST is taken — a path is a way of naming one
 * thing, and a caller that wants all of them wants {@link nodeList}.
 */
export const node = (from: XmlNode | null | undefined, ...path: string[]): XmlNode | null => {
  let current: XmlNode | null = from ?? null;
  for (const step of path) {
    if (!current) return null;
    const next = current[step];
    if (next === undefined) return null;
    current = (Array.isArray(next) ? next[0] : next) as XmlNode;
  }
  return current ?? null;
};

/**
 * Every child under a name, as a list.
 *
 * The reason this exists: an element that occurs once parses to a node and the
 * same element occurring twice parses to an array. A provider iterating one
 * shipment's pieces must not behave differently because there was only one.
 */
export const nodeList = (from: XmlNode | null | undefined, name: string): XmlNode[] => {
  const value = from?.[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as XmlNode[];
};

/** The text at the end of a path, or `null` when it is absent or empty. */
export const xmlText = (from: XmlNode | null | undefined, ...path: string[]): string | null => {
  const found = node(from, ...path);
  const text = found?.["#"];
  return typeof text === "string" && text.trim() ? text.trim() : null;
};

/**
 * Find the first element with this name ANYWHERE beneath a node.
 *
 * A concession to reality rather than a convenience. A .NET service wraps its
 * answer in a result element whose own name is generated, and two couriers nest
 * the same payload at different depths; pinning an exact path against that
 * means a provider breaks on a wrapper nobody documented. Bounded by depth so a
 * pathological document cannot make it run away.
 */
export const findNode = (from: XmlNode | null | undefined, name: string, maxDepth = 12): XmlNode | null => {
  if (!from || maxDepth < 0) return null;
  const direct = from[name];
  if (direct !== undefined) return (Array.isArray(direct) ? direct[0] : direct) as XmlNode;
  for (const [key, value] of Object.entries(from)) {
    if (key === "@" || key === "#") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const found = findNode(child as XmlNode, name, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
};

// ── Building a request ───────────────────────────────────────────────────────

/**
 * A value on its way into an envelope.
 *
 * `null` and `undefined` are OMITTED rather than sent as empty elements, which
 * matters: a courier reading an empty `<phone/>` as "clear the phone" is a
 * different thing from never being told about it.
 */
export type SoapValue = string | number | boolean | null | undefined | SoapValue[] | { [key: string]: SoapValue };

const buildValue = (name: string, value: SoapValue): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => buildValue(name, v)).join("");
  if (typeof value === "object") {
    const inner = Object.entries(value)
      .map(([k, v]) => buildValue(k, v))
      .join("");
    return `<${name}>${inner}</${name}>`;
  }
  return `<${name}>${escapeXml(String(value))}</${name}>`;
};

/** Serialise a body object into elements, in the order its keys were written. */
export const buildBody = (body: Record<string, SoapValue>): string =>
  Object.entries(body)
    .map(([k, v]) => buildValue(k, v))
    .join("");

export interface SoapRequest {
  /** The operation element's namespace, from the WSDL's targetNamespace. */
  namespace: string;
  /** The operation element's name, e.g. `createShipment`. */
  operation: string;
  /** The operation's arguments, in the order the schema declares them. */
  body: Record<string, SoapValue>;
  /**
   * SOAP 1.1 wants a `SOAPAction` header and some services check it. Pass the
   * value the WSDL binding gives; omit it and the header is sent empty, which
   * is what SOAP 1.1 says an unknown action looks like.
   */
  action?: string;
  /** SOAP 1.2 uses a different envelope namespace and no SOAPAction header. */
  version?: "1.1" | "1.2";
}

const ENVELOPE_NS = {
  "1.1": "http://schemas.xmlsoap.org/soap/envelope/",
  "1.2": "http://www.w3.org/2003/05/soap-envelope",
} as const;

/** Wrap an operation and its arguments in an envelope. */
export const buildEnvelope = (req: SoapRequest): string => {
  const version = req.version ?? "1.1";
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="${ENVELOPE_NS[version]}">` +
    "<soap:Body>" +
    `<op:${req.operation} xmlns:op="${escapeXml(req.namespace)}">` +
    buildBody(req.body) +
    `</op:${req.operation}>` +
    "</soap:Body></soap:Envelope>"
  );
};

/**
 * A fault the service returned, as an error a person can act on.
 *
 * Distinguished from a transport failure because they mean different things: a
 * 500 with a fault inside it is the service saying no, and retrying it will get
 * the same no.
 */
export class SoapFault extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "SoapFault";
    this.code = code;
  }
}

/**
 * Send an envelope and hand back the parsed BODY.
 *
 * A SOAP fault throws {@link SoapFault} whatever the HTTP status, because
 * services disagree about whether a fault is a 200 or a 500 and a provider
 * should not have to care. A non-2xx with no fault in it throws an ordinary
 * error carrying the truncated body — the same shape every JSON provider here
 * already produces.
 */
export const soapCall = async (
  fetchLike: FetchLike,
  url: string,
  req: SoapRequest,
  extraHeaders?: Record<string, string>,
): Promise<XmlNode> => {
  const version = req.version ?? "1.1";
  const headers: Record<string, string> =
    version === "1.1"
      ? { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${req.action ?? ""}"`, ...extraHeaders }
      : { "Content-Type": "application/soap+xml; charset=utf-8", ...extraHeaders };

  const res = await fetchLike(url, { method: "POST", headers, body: buildEnvelope(req) });
  const raw = await res.text();
  const envelope = parseXml(raw);
  const body = node(envelope, "Body") ?? envelope;

  const fault = findNode(body, "Fault");
  if (fault) {
    // SOAP 1.1 names them faultstring/faultcode; 1.2 uses Reason/Text and
    // Code/Value. Both are read, because a provider should not have to know
    // which version its courier picked.
    const message =
      xmlText(fault, "faultstring") ??
      xmlText(fault, "Reason", "Text") ??
      xmlText(fault, "detail") ??
      "the service returned a fault";
    const code = xmlText(fault, "faultcode") ?? xmlText(fault, "Code", "Value");
    throw new SoapFault(message, code);
  }

  if (!res.ok) {
    throw new Error(`the service responded ${res.status}${raw ? `: ${raw.slice(0, 160)}` : ""}`);
  }
  return body;
};
