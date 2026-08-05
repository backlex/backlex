import {
  domainToAscii,
  type FieldDef,
  parseUrlForField,
  URL_HOST_MAX_LENGTH,
  URL_MAX_LENGTH,
  type UrlSpec,
} from "@backlex/db";

/**
 * The write edge of a URL field: turning whatever a human typed or pasted into
 * the canonical address the column holds.
 *
 * There is deliberately no matching READ edge, for the same reason `email` and
 * `phone` have none: a canonical URL is self-describing, so a URL cell decodes
 * to itself. `deserialize` returns the string and no read path needed changing.
 * (The admin's `unicode` display is a RENDERING of that same stored value,
 * applied in the cell — not a decode the API performs.)
 *
 * This runs on the PAYLOAD, right after validation, for the reason `geo` paid
 * for and `money`, `phone` and `email` inherited (see ./geo-fields):
 * `performCreate` builds its 201 body, its realtime event, its activity row and
 * its FTS/embed text out of the in-memory payload, not out of the row it wrote.
 * Canonicalizing only inside `serialize` would fix the column and leave every one
 * of those echoing back the `Acme.COM` the caller sent.
 */

/** Every `url` field on a collection. */
export const urlFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => f.type === "url");

/** True when this collection has any url field — the cheap guard that keeps
 *  every other collection on exactly its old code path. */
export const hasUrlFields = (fields: FieldDef[]): boolean =>
  fields.some((f) => f.type === "url");

/**
 * Rewrite every present URL value in a write payload to its canonical form, in
 * place.
 *
 * An empty value clears the column rather than failing — "this brand has no
 * website on file" is an ordinary thing to say. Anything else is parsed, and a
 * value that cannot be parsed is a 422 naming the field: a URL column that holds
 * a non-URL is precisely the situation the type exists to end.
 *
 * @throws Error prefixed with the field name, for the caller to map to a 422.
 *   The message never quotes the value — these reach activity rows and logs, and
 *   a URL can carry a capability in its path or its query.
 */
export const canonicalizeUrlFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  options: {
    /** Payload key for a field — GraphQL names them in camelCase. */
    keyOf?: (f: FieldDef) => string;
  } = {},
): void => {
  const keyOf = options.keyOf ?? ((f: FieldDef) => f.name);
  for (const f of fields) {
    if (f.type !== "url") continue;
    const key = keyOf(f);
    const value = data[key];
    if (value === undefined) continue;
    if (value === null || value === "") {
      data[key] = null;
      continue;
    }
    try {
      // The canonical STRING, not the parsed object — the payload is what the
      // 201 body, the realtime event and the activity row are built from, so it
      // has to hold exactly what a subsequent GET returns. This is also why
      // there is no `serializeField` branch for `url`: by the time serialize
      // sees the value it is already the string the column takes.
      data[key] = parseUrlForField(value, f.url).url;
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}`);
    }
  }
};

/**
 * Comparison operators whose operand on a URL column IS a whole address, and
 * therefore has to be folded the same way a stored value was.
 */
const URL_EXACT_OPS = new Set(["_eq", "_neq"]);
/** …and the ones whose operand is a LIST of addresses. */
const URL_LIST_OPS = new Set(["_in", "_nin"]);

/**
 * `_starts_with` is the ONLY fragment operator folded here, and the reason it is
 * alone is the one real difference between this type and `email`.
 *
 * A canonical address is lowercase all the way through, so `email` can fold any
 * fragment of one and be exactly right. A canonical URL is NOT: the scheme and
 * host are lowercased, and everything from the path onwards is left verbatim
 * because it is case-sensitive by RFC 3986 §6.2.2.1 and its meaning belongs to
 * the server that defined it. So a fragment is foldable only when it is anchored
 * at the START, where the characters it covers are known to be the scheme and
 * the host.
 *
 * `_contains` and `_ends_with` are therefore deliberately left alone. A fragment
 * in the middle of a URL could be a host or a path segment, there is no way to
 * tell which, and lowercasing a path fragment would silently stop
 * `_contains: "/Invoices/"` matching the rows it should. An operator who wants a
 * case-insensitive search has `_icontains`, which the docs point at for exactly
 * this. Guessing here would return rows that merely look related, which is the
 * failure mode this whole type exists to end.
 */
const URL_PREFIX_OP = "_starts_with";

/**
 * Fold a `_starts_with` operand as far as it is decidable, and no further.
 *
 * Three cases, in order:
 *
 *  - **`form: "host"`** — the whole stored value is a lowercase host, so any
 *    prefix of one folds by lowercasing. The A-label encoding is applied only if
 *    the operand is a complete host, because Punycode encodes a whole label and
 *    not a substring of one (the same refusal `email` makes about `örnek`).
 *  - **A prefix covering a TERMINATED authority** (`https://Acme.COM/inv`) — the
 *    host is complete, so it is lowercased AND encoded, and everything from the
 *    path on is carried through untouched.
 *  - **A prefix stopping INSIDE the authority** (`https://Acme.CO`) — lowercased
 *    only. It is a partial host, so encoding it could not match anything, but
 *    lowercasing is still exactly right because that half of the stored value is
 *    lowercase.
 *
 * The length is checked BEFORE the encoder runs, the same way the parser checks
 * it before any pattern does: this operand arrives straight off the request, and
 * Punycode encoding is superlinear in the length of one label.
 */
const foldPrefix = (operand: unknown, spec: UrlSpec | undefined): unknown => {
  if (typeof operand !== "string" || operand.length > URL_MAX_LENGTH) return operand;

  /**
   * Encode a host-shaped string, or hand it back lowercased.
   *
   * The length is checked against a HOST's maximum, not a URL's, and that is the
   * whole reason this helper exists rather than a bare `domainToAscii` call.
   * Punycode is quadratic in the number of distinct code points in a label, so a
   * 2000-character run of them costs ~20ms of CPU — on the read path, per
   * operand, for any caller who can filter. A string longer than a host cannot
   * be a host or a prefix of one, so declining to encode it loses nothing. The
   * same discipline `email`'s fragment fold applies with its own tighter cap.
   */
  const encodeHost = (lowered: string): string => {
    if (lowered.length > URL_HOST_MAX_LENGTH) return lowered;
    try {
      return domainToAscii(lowered);
    } catch {
      return lowered;
    }
  };

  if (spec?.form === "host") {
    // A complete host has no trailing separator to come; a prefix of one might
    // still grow a label, so a failure leaves it as plain lowercase.
    return encodeHost(operand.toLowerCase());
  }

  const sep = operand.indexOf("://");
  // No scheme yet — the operand is a prefix of `https`/`http` itself, which is
  // already lowercase in the column, so lowercasing is the whole answer.
  if (sep < 0) return operand.toLowerCase();

  const head = operand.slice(0, sep + 3);
  const rest = operand.slice(sep + 3);
  // The authority ends at the first `/`, `?` or `#`. Absent one, the operand
  // stops inside the host.
  const end = rest.search(/[/?#]/);
  if (end < 0) return `${head.toLowerCase()}${rest.toLowerCase()}`;

  const authority = rest.slice(0, end).toLowerCase();
  const tail = rest.slice(end);
  // A port is not a domain — split it off before encoding, or `domainToAscii`
  // sees `acme.com:8443` as a single label set and mangles it.
  const colon = authority.lastIndexOf(":");
  const host = colon > 0 ? authority.slice(0, colon) : authority;
  const port = colon > 0 ? authority.slice(colon) : "";
  return `${head.toLowerCase()}${encodeHost(host)}${port}${tail}`;
};

/**
 * Canonicalize one whole-URL operand, or leave it exactly as it came.
 *
 * The fallback is not laziness. An operand that does not parse cannot be equal
 * to any canonical value in the column, so comparing it literally is the only
 * reading that means anything — and it is the one that lets an operator find the
 * rows a normalization pass has not reached yet, by searching for the raw string
 * still sitting in them.
 */
const urlOperand = (operand: unknown, field: FieldDef): unknown => {
  if (typeof operand !== "string") return operand;
  try {
    // The field's own `allowedHosts` is deliberately NOT applied, and neither is
    // its `schemes` — both govern what may be STORED. Refusing to look up an
    // address outside them would hide the very rows a tightened rule left
    // behind, which is exactly when an operator needs to find them.
    return parseUrlForField(operand, {
      ...field.url,
      allowedHosts: undefined,
      schemes: undefined,
    }).url;
  } catch {
    return operand;
  }
};

/**
 * Rewrite the URL operands in a filter tree into the canonical form the column
 * holds.
 *
 * Without this the feature only half lands: values go in folded and queries come
 * in as typed, so `?filter={"website":{"_eq":"acme.com"}}` matches nothing at
 * all — which looks exactly like "that brand has no site on file".
 *
 * Returns a NEW tree; the caller's parsed filter is left alone.
 */
export const normalizeUrlOperands = <T>(cond: T, fields: FieldDef[]): T => {
  if (!hasUrlFields(fields)) return cond;
  const byName = new Map(fields.map((f) => [f.name, f]));
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    const c = node as Record<string, unknown>;
    if (Array.isArray(c.$and)) return { $and: (c.$and as unknown[]).map(walk) };
    if (Array.isArray(c.$or)) return { $or: (c.$or as unknown[]).map(walk) };
    if (c.$not !== undefined) return { $not: walk(c.$not) };
    const out: Record<string, unknown> = {};
    for (const [key, cmp] of Object.entries(c)) {
      const field = byName.get(key);
      if (!field || field.type !== "url") {
        out[key] = cmp;
        continue;
      }
      if (cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        // Shorthand equality — `{"website": "Acme.COM"}`.
        out[key] = urlOperand(cmp, field);
        continue;
      }
      const nextCmp: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        if (URL_EXACT_OPS.has(op)) {
          nextCmp[op] = urlOperand(operand, field);
        } else if (URL_LIST_OPS.has(op) && Array.isArray(operand)) {
          nextCmp[op] = operand.map((v) => urlOperand(v, field));
        } else if (op === URL_PREFIX_OP) {
          nextCmp[op] = foldPrefix(operand, field.url);
        } else {
          nextCmp[op] = operand;
        }
      }
      out[key] = nextCmp;
    }
    return out;
  };
  return walk(cond) as T;
};
