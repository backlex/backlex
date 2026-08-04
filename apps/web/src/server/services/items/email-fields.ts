import {
  domainToAscii,
  EMAIL_MAX_LENGTH,
  type EmailSpec,
  type FieldDef,
  parseEmailForField,
} from "@backlex/db";

/**
 * The write edge of an email field: turning whatever a human typed or pasted
 * into the canonical address the column holds.
 *
 * There is deliberately no matching READ edge, for the same reason `phone` has
 * none and `money` needs one: a canonical address is self-describing, so an
 * email cell decodes to itself. `deserialize` returns the string and no read
 * path needed changing. (The admin's `unicode` display is a RENDERING of that
 * same stored value, applied in the cell — not a decode the API performs.)
 *
 * This runs on the PAYLOAD, right after validation, for the reason `geo` paid
 * for and `money` and `phone` inherited (see ./geo-fields): `performCreate`
 * builds its 201 body, its realtime event, its activity row and its FTS/embed
 * text out of the in-memory payload, not out of the row it wrote.
 * Canonicalizing only inside `serialize` would fix the column and leave every
 * one of those echoing back the `  Ada@Example.COM ` the caller sent, which then
 * replicates through the changefeed into an offline store as an address that
 * will not match the row it came from.
 */

/** Every `email` field on a collection. */
export const emailFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => f.type === "email");

/** True when this collection has any email field — the cheap guard that keeps
 *  every other collection on exactly its old code path. */
export const hasEmailFields = (fields: FieldDef[]): boolean =>
  fields.some((f) => f.type === "email");

/**
 * Rewrite every present email value in a write payload to its canonical form, in
 * place.
 *
 * An empty value clears the column rather than failing — "this supplier has no
 * address on file" is an ordinary thing to say. Anything else is parsed, and a
 * value that cannot be parsed is a 422 naming the field: an email column that
 * holds a non-address is precisely the situation the type exists to end, and
 * letting one through would put the collection back where it started with no way
 * to tell which rows were affected.
 *
 * @throws Error prefixed with the field name, for the caller to map to a 422.
 *   The message never quotes the value — these reach activity rows and logs, and
 *   an address identifies a real person.
 */
export const canonicalizeEmailFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  options: {
    /** Payload key for a field — GraphQL names them in camelCase. */
    keyOf?: (f: FieldDef) => string;
  } = {},
): void => {
  const keyOf = options.keyOf ?? ((f: FieldDef) => f.name);
  for (const f of fields) {
    if (f.type !== "email") continue;
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
      // there is no `serializeField` branch for `email`: by the time serialize
      // sees the value it is already the string the column takes.
      data[key] = parseEmailForField(value, f.email).email;
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}`);
    }
  }
};

/**
 * Comparison operators whose operand on an email column IS a whole address, and
 * therefore has to be folded the same way a stored value was.
 */
const EMAIL_EXACT_OPS = new Set(["_eq", "_neq"]);
/** …and the ones whose operand is a LIST of addresses. */
const EMAIL_LIST_OPS = new Set(["_in", "_nin"]);
/**
 * …and the ones whose operand is a FRAGMENT of one.
 *
 * These are where email parts company with `phone`, which passes its substring
 * operators through untouched. It can afford to: a canonical E.164 number has no
 * case, so a fragment of one needs no folding. A canonical address is folded
 * text, and `_ends_with: "@Example.com"` — "everyone at this customer" is the
 * single most useful query anyone writes against one of these columns — would
 * match nothing at all against a lowercased column, which looks exactly like
 * "that company has no contacts".
 *
 * So a fragment IS folded, but only when the field folds the whole value (see
 * {@link foldFragment}); parsing it is not an option, because a fragment is not
 * an address and every useful query would throw.
 */
const EMAIL_FRAGMENT_OPS = new Set(["_contains", "_starts_with", "_ends_with"]);
/**
 * `_icontains` is deliberately NOT in that set.
 *
 * It already compares case-insensitively, so folding its operand would change
 * nothing — and an operator listed here that cannot affect the result is worse
 * than an omission, because the next person has to work out whether it was meant
 * to do something. (`_ncontains` is not here either, for the plainer reason that
 * the DSL has no such operator; it was in an earlier draft of this set and did
 * nothing at all.)
 */

/**
 * Fold a fragment operand the way the column was folded — or leave it alone.
 *
 * When the field lowercases the local part (the default) the entire stored value
 * is lowercase, so lowercasing any fragment of it is exactly right. When
 * `caseSensitiveLocal` is on it is NOT: the fragment could be from either half,
 * and folding it would defeat the case-sensitive lookup the field opted into.
 * There is no way to tell the halves apart in a substring, so nothing is guessed.
 */
const foldFragment = (operand: unknown, spec: EmailSpec | undefined): unknown => {
  if (typeof operand !== "string" || spec?.caseSensitiveLocal) return operand;
  const lowered = operand.toLowerCase();
  // A fragment that starts with `@` is a WHOLE domain, so it can be encoded the
  // way the column was. That matters for exactly the query the type exists to
  // serve — "everyone at this customer" — in a workspace whose addresses are
  // international: the admin renders `ada@örnek.com` under `display: "unicode"`,
  // and searching the string it just showed you has to find the row that is
  // sitting there as `ada@xn--rnek-4qa.com`.
  //
  // A fragment that is NOT anchored at the `@` is left as it is, on purpose.
  // Punycode encodes a whole label, not a substring of one, so there is no
  // conversion of `örnek` that could match — `_contains: "örnek"` has no right
  // answer against a punycoded column, and inventing one would return rows that
  // merely look related.
  //
  // The length is checked BEFORE the encoder runs, the same way the parser
  // checks it before any regex does: this operand arrives straight off the
  // request, and Punycode encoding is superlinear in the length of one label. A
  // fragment longer than a whole address cannot match a column that refuses to
  // store one anyway, so there is nothing to lose by declining it.
  if (!lowered.startsWith("@") || lowered.length > EMAIL_MAX_LENGTH) return lowered;
  try {
    return `@${domainToAscii(lowered.slice(1))}`;
  } catch {
    return lowered;
  }
};

/**
 * Canonicalize one whole-address operand, or leave it exactly as it came.
 *
 * The fallback is not laziness. An operand that does not parse cannot be equal
 * to any canonical value in the column, so comparing it literally is the only
 * reading that means anything — and it is the one that lets an operator find the
 * rows a normalization pass has not reached yet, by searching for the raw string
 * still sitting in them.
 */
const emailOperand = (operand: unknown, field: FieldDef): unknown => {
  if (typeof operand !== "string") return operand;
  try {
    // The field's own `allowedDomains` is deliberately NOT applied — that rule
    // governs what may be STORED. Refusing to look up an address outside it
    // would hide the very rows a tightened allow-list left behind.
    return parseEmailForField(operand, { ...field.email, allowedDomains: undefined }).email;
  } catch {
    return operand;
  }
};

/**
 * Rewrite the email operands in a filter tree into the canonical form the column
 * holds.
 *
 * Without this the feature only half lands: values go in folded and queries come
 * in as typed, so `?filter={"email":{"_eq":"Ada@Example.com"}}` matches nothing
 * at all — which looks exactly like "that customer does not exist", and is the
 * bug every consumer in this repo was already working around by hand.
 *
 * Returns a NEW tree; the caller's parsed filter is left alone.
 */
export const normalizeEmailOperands = <T>(cond: T, fields: FieldDef[]): T => {
  if (!hasEmailFields(fields)) return cond;
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
      if (!field || field.type !== "email") {
        out[key] = cmp;
        continue;
      }
      if (cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        // Shorthand equality — `{"email": "Ada@Example.com"}`.
        out[key] = emailOperand(cmp, field);
        continue;
      }
      const nextCmp: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        if (EMAIL_EXACT_OPS.has(op)) {
          nextCmp[op] = emailOperand(operand, field);
        } else if (EMAIL_LIST_OPS.has(op) && Array.isArray(operand)) {
          nextCmp[op] = operand.map((v) => emailOperand(v, field));
        } else if (EMAIL_FRAGMENT_OPS.has(op)) {
          nextCmp[op] = foldFragment(operand, field.email);
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
