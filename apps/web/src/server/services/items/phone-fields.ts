import {
  callingCodeFor,
  type FieldDef,
  type PhoneSpec,
  parsePhoneForField,
} from "@backlex/db";

/**
 * The write edge of a phone field: turning whatever a human typed into the
 * canonical E.164 the column holds.
 *
 * There is deliberately no matching READ edge, and the asymmetry with `money` is
 * the point. An amount is meaningless without a currency that may live in a
 * sibling column, so reading one needs the row — which is why `deserializeField`
 * exists. A canonical phone number carries its own country code, so a phone cell
 * decodes to itself: `deserialize` returns the string, and no read path needed
 * changing.
 *
 * This runs on the PAYLOAD, right after validation, for the reason `geo` paid
 * for and `money` inherited (see ./geo-fields): `performCreate` builds its 201
 * body, its realtime event, its activity row and its FTS/embed text out of the
 * in-memory payload, not out of the row it wrote. Canonicalizing only inside
 * `serialize` would fix the column and leave every one of those echoing back the
 * `0532 111 22 33` the caller sent, which then replicates through the changefeed
 * into an offline store as a number no SMS provider will accept.
 */

/** Every `phone` field on a collection. */
export const phoneFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => f.type === "phone");

/** True when this collection has any phone field — the cheap guard that keeps
 *  every other collection on exactly its old code path. */
export const hasPhoneFields = (fields: FieldDef[]): boolean =>
  fields.some((f) => f.type === "phone");

/**
 * The region a national-form number on THIS row should be read in.
 *
 * With `spec.regionField` the sibling column decides — from the payload first
 * (the write may be setting it), then from the row being patched, then from the
 * sibling's own DDL default. A blank or unrecognised value falls back to
 * `spec.region`, which is the difference from money's currency: a wrong region
 * is a wrong number, but a MISSING one is recoverable when the field also names
 * a default, so there is no reason to fail the write.
 */
export const resolveRowRegion = (
  spec: PhoneSpec | undefined,
  fields: FieldDef[],
  data: Record<string, unknown> | null,
  existing: Record<string, unknown> | null,
  keyOf: (f: FieldDef) => string = (f) => f.name,
): string | null => {
  const sibling = spec?.regionField;
  if (sibling) {
    const siblingField = fields.find((f) => f.name === sibling);
    const key = siblingField ? keyOf(siblingField) : sibling;
    const candidates = [
      data?.[key],
      existing?.[sibling],
      typeof siblingField?.default === "string" ? siblingField.default : undefined,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim() !== "" && callingCodeFor(c)) {
        return c.trim().toUpperCase();
      }
    }
  }
  return spec?.region ?? null;
};

/**
 * Rewrite every present phone value in a write payload to canonical E.164, in
 * place.
 *
 * An empty value clears the column rather than failing — "this customer has no
 * number" is an ordinary thing to say. Anything else is parsed, and a value that
 * cannot be parsed is a 422 naming the field: a phone column that holds a
 * non-number is precisely the situation the type exists to end, and letting one
 * through would put the collection back where it started with no way to tell
 * which rows were affected.
 *
 * @throws Error prefixed with the field name, for the caller to map to a 422.
 *   The message never quotes the value — these reach activity rows and logs, and
 *   the value is a real person's phone number.
 */
export const canonicalizePhoneFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  options: {
    /** The row a patch is being applied to, for its region. */
    existing?: Record<string, unknown> | null;
    /** Payload key for a field — GraphQL names them in camelCase. */
    keyOf?: (f: FieldDef) => string;
  } = {},
): void => {
  const keyOf = options.keyOf ?? ((f: FieldDef) => f.name);
  for (const f of fields) {
    if (f.type !== "phone") continue;
    const key = keyOf(f);
    const value = data[key];
    if (value === undefined) continue;
    if (value === null || value === "") {
      data[key] = null;
      continue;
    }
    const region = resolveRowRegion(f.phone, fields, data, options.existing ?? null, keyOf);
    try {
      // The canonical STRING, not the parsed object — the payload is what the
      // 201 body, the realtime event and the activity row are built from, so it
      // has to hold exactly what a subsequent GET returns. This is also why
      // there is no `serializeField` branch for `phone`: by the time serialize
      // sees the value it is already the string the column takes.
      data[key] = parsePhoneForField(value, {
        ...f.phone,
        region: region ?? undefined,
      }).e164;
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}`);
    }
  }
};

/**
 * Comparison operators whose operand on a phone column IS a phone number, and
 * therefore has to be canonicalized the same way a stored value was.
 *
 * `_contains` / `_starts_with` / `_ends_with` are deliberately absent and
 * deliberately still allowed: a fragment is not a number, so parsing it would
 * fail on every useful query ("the ones ending 2233"), and passing it through
 * untouched matches the canonical text exactly as the caller intends. This is
 * the split money could not make — an amount has no meaningful substring, so
 * `money` rejects those operators outright.
 */
const PHONE_EXACT_OPS = new Set(["_eq", "_neq"]);
/** …and the ones whose operand is a LIST of phone numbers. */
const PHONE_LIST_OPS = new Set(["_in", "_nin"]);

/**
 * Canonicalize one filter operand, or leave it exactly as it came.
 *
 * The fallback is not laziness. An operand that does not parse cannot be equal
 * to any canonical value in the column, so comparing it literally is the only
 * reading that means anything — and it is the one that lets an operator find the
 * rows a normalization pass has not reached yet, by searching for the raw string
 * still sitting in them.
 */
const phoneOperand = (operand: unknown, field: FieldDef): unknown => {
  if (typeof operand !== "string" && typeof operand !== "number") return operand;
  try {
    return parsePhoneForField(operand, field.phone).e164;
  } catch {
    return operand;
  }
};

/**
 * Rewrite the phone operands in a filter tree into the canonical form the column
 * holds.
 *
 * Without this the feature only half lands: values go in canonical and queries
 * come in as typed, so `?filter={"phone":{"_eq":"0532 111 22 33"}}` matches
 * nothing at all — which looks exactly like "that customer does not exist".
 *
 * A per-row region (`phone.regionField`) is NOT consulted: a filter is evaluated
 * against many rows with potentially different regions, so there is no row to
 * read one from. A field that keeps its region per row should be queried with
 * international-form numbers, and the field's own `region` still serves as the
 * default when it has one.
 *
 * Returns a NEW tree; the caller's parsed filter is left alone.
 */
export const normalizePhoneOperands = <T>(cond: T, fields: FieldDef[]): T => {
  if (!hasPhoneFields(fields)) return cond;
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
      if (!field || field.type !== "phone") {
        out[key] = cmp;
        continue;
      }
      if (cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        // Shorthand equality — `{"phone": "0532 111 22 33"}`.
        out[key] = phoneOperand(cmp, field);
        continue;
      }
      const nextCmp: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        if (PHONE_EXACT_OPS.has(op)) {
          nextCmp[op] = phoneOperand(operand, field);
        } else if (PHONE_LIST_OPS.has(op) && Array.isArray(operand)) {
          nextCmp[op] = operand.map((v) => phoneOperand(v, field));
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
