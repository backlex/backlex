import {
  currencyExponent,
  type FieldDef,
  fromMinorUnits,
  isDecimalStorage,
  type MoneySpec,
  type MoneyValue,
  normalizeCurrency,
  parseMoneyInput,
  toMinorUnits,
} from "@backlex/db";

/**
 * The two edges of a money field: turning what a caller wrote into the integer
 * the column holds, and turning that integer back into an amount that says what
 * it is denominated in.
 *
 * Both live here rather than in `serialize`/`deserialize` because neither is a
 * function of the VALUE alone. A money field's currency may come from a sibling
 * column, so reading one needs the row and writing one needs the payload (and,
 * on a patch, the row it is being applied to). `serialize` sees a value and a
 * type, which is exactly the information that is not enough.
 *
 * The write half runs on the PAYLOAD, right after validation — the lesson `geo`
 * paid for (see ./geo-fields): `performCreate` builds its 201 body, its realtime
 * event, its activity row and its FTS/embed text out of the in-memory payload,
 * not out of the row it wrote. Normalizing only inside `serialize` would fix the
 * column and leave every one of those carrying the caller's original shape.
 */

/** Every `money` field on a collection. */
export const moneyFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => f.type === "money");

/** True when this collection has any money field at all — the cheap guard that
 *  keeps every non-money collection on exactly its old code path. */
export const hasMoneyFields = (fields: FieldDef[]): boolean =>
  fields.some((f) => f.type === "money");

/**
 * The currency a money field is denominated in for one particular row.
 *
 * With a fixed `spec.currency` this ignores the row entirely. With
 * `spec.currencyField` it reads the sibling column — from the payload first
 * (the write may be setting it), then from the row being patched, then from the
 * sibling's own DDL default, which is the value the database would have
 * supplied for a create that omitted it.
 *
 * Returns null when a per-row currency cannot be determined; callers turn that
 * into an error naming the sibling column, because storing minor units nobody
 * can scale is how a price list ends up out by a factor of a hundred.
 */
export const resolveRowCurrency = (
  field: FieldDef,
  fields: FieldDef[],
  data: Record<string, unknown> | null,
  existing: Record<string, unknown> | null,
  keyOf: (f: FieldDef) => string = (f) => f.name,
): string | null => {
  const spec = field.money;
  if (spec?.currency) return normalizeCurrency(spec.currency);
  const sibling = spec?.currencyField;
  if (!sibling) return null;
  const siblingField = fields.find((f) => f.name === sibling);
  const key = siblingField ? keyOf(siblingField) : sibling;
  const candidates = [
    data?.[key],
    existing?.[sibling],
    typeof siblingField?.default === "string" ? siblingField.default : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") {
      try {
        return normalizeCurrency(c);
      } catch {
        // A malformed code in the sibling column is reported by the caller
        // against the money field, which is where it actually breaks.
        return null;
      }
    }
  }
  return null;
};

/** The canonical `{ amount, currency }` for `value`, given the row's currency. */
const canonicalValue = (
  value: unknown,
  spec: MoneySpec | undefined,
  currency: string,
): MoneyValue => {
  const exponent = currencyExponent(currency, spec);
  const parsed = parseMoneyInput(value, () => exponent);
  if (parsed.currency && parsed.currency !== currency) {
    throw new Error(
      `is in ${parsed.currency}, but this field is denominated in ${currency}`,
    );
  }
  // Round-tripping through minor units is not a detour — it is what quantizes
  // the amount to the currency's exponent, so `19.999` is refused (or its
  // floating-point noise dropped) before anything downstream sees it.
  return { amount: fromMinorUnits(parsed.minor, exponent), currency };
};

/**
 * Rewrite every present money value in a write payload to the canonical
 * `{ amount, currency }`, in place.
 *
 * Note what this does NOT do: it does not convert to the integer the column
 * holds. That happens in `serializeField`, one step later, and the split is
 * deliberate. `performCreate` builds its 201 body, its realtime event, its
 * activity row and its FTS/embed text out of this payload — so what it holds
 * has to be what a READ of the same row returns, not what the column stores.
 * Canonicalizing to minor units here would have answered every create with a
 * bare `1999` and then handed back `{ amount: 19.99, currency: "USD" }` on the
 * next GET, which is the shape drift `geo` had to fix after the fact.
 *
 * Accepts everything `parseMoneyInput` does. A value that names a currency is
 * checked against the field's — `{ amount: 10, currency: "EUR" }` written to a
 * USD column is a 422 rather than ten dollars, because the two differ by
 * whatever the exchange rate is and nothing here knows it.
 *
 * @throws Error prefixed with the field name, for the caller to map to a 422.
 */
export const canonicalizeMoneyFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  options: {
    /** The row a patch is being applied to, for its currency. */
    existing?: Record<string, unknown> | null;
    /** Payload key for a field — GraphQL names them in camelCase. */
    keyOf?: (f: FieldDef) => string;
  } = {},
): void => {
  const keyOf = options.keyOf ?? ((f: FieldDef) => f.name);
  for (const f of fields) {
    if (f.type !== "money") continue;
    const key = keyOf(f);
    const value = data[key];
    if (value === undefined) continue;
    if (value === null || value === "") {
      data[key] = null;
      continue;
    }
    const currency = resolveRowCurrency(f, fields, data, options.existing ?? null, keyOf);
    if (!currency) {
      throw new Error(
        `${f.name}: no currency for this row — set "${f.money?.currencyField}" to an ISO code in the same write`,
      );
    }
    try {
      data[key] = canonicalValue(value, f.money, currency);
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}`);
    }
  }
};

/**
 * Refuse a patch that changes a row's currency to one with a different number
 * of decimals without restating the amounts denominated in it.
 *
 * The column holds minor units. Re-labelling `1999` from USD to JPY does not
 * convert nineteen dollars ninety-nine into yen — it reads the same integer
 * through a different exponent and turns it into one thousand nine hundred and
 * ninety-nine yen, a hundredfold error with no write to blame it on. When the
 * exponent is unchanged the relabel is left alone: `19.99 USD` becoming
 * `19.99 EUR` is a decision an operator can legitimately make, and refusing it
 * would be this module inventing a currency-conversion policy.
 *
 * @throws Error naming both the sibling and the amount, for a 422.
 */
export const assertCurrencyChangeIsSafe = (
  patch: Record<string, unknown>,
  fields: FieldDef[],
  existing: Record<string, unknown>,
  keyOf: (f: FieldDef) => string = (f) => f.name,
): void => {
  for (const f of fields) {
    if (f.type !== "money" || isDecimalStorage(f.money)) continue;
    const sibling = f.money?.currencyField;
    if (!sibling) continue;
    const siblingField = fields.find((o) => o.name === sibling);
    const siblingKey = siblingField ? keyOf(siblingField) : sibling;
    const next = patch[siblingKey];
    if (typeof next !== "string" || next.trim() === "") continue;
    const before = existing[sibling];
    if (typeof before !== "string" || before.trim() === "") continue;
    let from: string;
    let to: string;
    try {
      from = normalizeCurrency(before);
      to = normalizeCurrency(next);
    } catch {
      continue;
    }
    if (from === to) continue;
    if (currencyExponent(from, f.money) === currencyExponent(to, f.money)) continue;
    // Restating the amount in the same write is the escape hatch, and the
    // correct thing to do anyway.
    if (patch[keyOf(f)] !== undefined) continue;
    if (existing[f.name] === null || existing[f.name] === undefined) continue;
    throw new Error(
      `${sibling}: changing this row from ${from} to ${to} changes how many decimals "${f.name}" has — restate "${f.name}" in the same write`,
    );
  }
};

/**
 * Read a stored money column back into `{ amount, currency }`.
 *
 * Returns null for a NULL column, and — deliberately — also for a row whose
 * currency cannot be resolved: an amount printed without a currency is the
 * thing this type exists to abolish, and inventing one for the display would
 * put the wrong symbol on a real number. An adopted column holding something
 * that is not a number reads back as-is, for the same reason `geo` parses
 * leniently: a row the platform never wrote should not take the page down.
 */
export const moneyValueOf = (
  raw: unknown,
  field: FieldDef,
  fields: FieldDef[],
  row: Record<string, unknown>,
): MoneyValue | null | unknown => {
  if (raw === null || raw === undefined) return null;
  const currency = resolveRowCurrency(field, fields, null, row);
  if (!currency) return null;
  const exponent = currencyExponent(currency, field.money);
  // SQLite hands back an integer; Postgres hands back `bigint` as a string
  // through postgres-js, and an adopted `numeric` column as a decimal string.
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return raw;
  return {
    amount: isDecimalStorage(field.money)
      ? Number(n.toFixed(exponent))
      : fromMinorUnits(n, exponent),
    currency,
  };
};

/**
 * The value a filter operand compares against, in the column's own units.
 *
 * A bare number in a filter is major units, like everywhere else — `price_gt:
 * 100` is a hundred lira, not one. On a per-row-currency field the operand MUST
 * name its currency, because minor units are only comparable inside one: `100`
 * is a dollar and also a hundred yen, and a filter that silently compared them
 * would return a page of rows nobody asked for. The currency it names is
 * returned so the compiler can add `AND <currencyField> = ?` — see
 * `docs/money.md § Filtering`.
 *
 * @throws Error suitable for a 422.
 */
export const moneyFilterOperand = (
  operand: unknown,
  field: FieldDef,
): { stored: number; currency: string | null } => {
  const spec = field.money;
  const fixed = spec?.currency ? normalizeCurrency(spec.currency) : null;
  const parsed = parseMoneyInput(operand, (code) => currencyExponent(code ?? fixed, spec));
  if (fixed) {
    if (parsed.currency && parsed.currency !== fixed) {
      throw new Error(
        `${field.name} is denominated in ${fixed}; a ${parsed.currency} amount cannot be compared against it`,
      );
    }
    const exponent = currencyExponent(fixed, spec);
    return {
      stored: isDecimalStorage(spec) ? fromMinorUnits(parsed.minor, exponent) : parsed.minor,
      currency: null,
    };
  }
  if (!parsed.currency) {
    throw new Error(
      `${field.name} holds a different currency per row, so a comparison must say which one — send { "amount": 100, "currency": "USD" } or "100 USD"`,
    );
  }
  const exponent = currencyExponent(parsed.currency, spec);
  return {
    stored: isDecimalStorage(spec) ? fromMinorUnits(parsed.minor, exponent) : parsed.minor,
    currency: parsed.currency,
  };
};

/** Comparison operators whose operand on a money column is an amount. */
const MONEY_VALUE_OPS = new Set(["_eq", "_neq", "_gt", "_gte", "_lt", "_lte"]);
/** …and the ones whose operand is a list / pair of amounts. */
const MONEY_LIST_OPS = new Set(["_in", "_nin", "_between"]);
/**
 * Operators a money column can answer without an amount at all. Everything
 * outside these three sets is a string test (`_contains`, `_starts_with`, …)
 * that would match on the digits of a stored integer — noise dressed as a
 * filter.
 */
const MONEY_PLAIN_OPS = new Set(["_null", "_empty", "_nempty"]);

/**
 * Rewrite the money operands in a filter tree into the units the column holds,
 * and pin the currency when the field keeps one per row.
 *
 * Two things happen here, and the second is the load-bearing one:
 *
 *  - `price_gte: 100` means a hundred lira, not a hundred kuruş — filters are
 *    written in the same major units reads and writes use, so the operand is
 *    scaled exactly like a value on the way in.
 *  - On a per-row-currency field, `{ "amount": 100, "currency": "USD" }`
 *    compiles to `amount >= 10000 AND currency = 'USD'`. Without that second
 *    clause the comparison would range across denominations, where `10000`
 *    minor units is a hundred dollars and also a hundred yen — a page of rows
 *    the caller did not ask for, with nothing in the response to show it.
 *
 * Returns a NEW tree; the caller's parsed filter is left alone.
 *
 * @throws Error suitable for a 422.
 */
export const normalizeMoneyOperands = <T>(cond: T, fields: FieldDef[]): T => {
  if (!hasMoneyFields(fields)) return cond;
  const byName = new Map(fields.map((f) => [f.name, f]));
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    const c = node as Record<string, unknown>;
    if (Array.isArray(c.$and)) return { $and: (c.$and as unknown[]).map(walk) };
    if (Array.isArray(c.$or)) return { $or: (c.$or as unknown[]).map(walk) };
    if (c.$not !== undefined) return { $not: walk(c.$not) };
    const parts: Record<string, unknown>[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, cmp] of Object.entries(c)) {
      const field = byName.get(key);
      if (!field || field.type !== "money") {
        out[key] = cmp;
        continue;
      }
      if (cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        // Shorthand equality — `{"price": 100}`.
        const { stored, currency } = moneyFilterOperand(cmp, field);
        out[key] = stored;
        if (currency && field.money?.currencyField) {
          parts.push({ [field.money.currencyField]: { _eq: currency } });
        }
        continue;
      }
      const nextCmp: Record<string, unknown> = {};
      const pinned = new Set<string>();
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        if (MONEY_PLAIN_OPS.has(op)) {
          nextCmp[op] = operand;
          continue;
        }
        if (MONEY_VALUE_OPS.has(op)) {
          const { stored, currency } = moneyFilterOperand(operand, field);
          nextCmp[op] = stored;
          if (currency) pinned.add(currency);
          continue;
        }
        if (MONEY_LIST_OPS.has(op)) {
          if (!Array.isArray(operand)) {
            throw new Error(`${key}: "${op}" needs a list of amounts`);
          }
          nextCmp[op] = operand.map((v) => {
            const { stored, currency } = moneyFilterOperand(v, field);
            if (currency) pinned.add(currency);
            return stored;
          });
          continue;
        }
        throw new Error(
          `${key}: "${op}" cannot be used on a money field — it holds an amount, not text`,
        );
      }
      if (pinned.size > 1) {
        // Two currencies in one comparison would need two different scalings of
        // the same column, which no single predicate can express.
        throw new Error(
          `${key}: a single comparison cannot mix ${[...pinned].join(" and ")} — filter one currency at a time`,
        );
      }
      out[key] = nextCmp;
      const currency = [...pinned][0];
      if (currency && field.money?.currencyField) {
        parts.push({ [field.money.currencyField]: { _eq: currency } });
      }
    }
    if (parts.length === 0) return out;
    return { $and: [out, ...parts] };
  };
  return walk(cond) as T;
};

/**
 * Turn a canonical money value into the number its column holds.
 *
 * The currency comes from the VALUE, which `canonicalizeMoneyFields` has
 * already resolved and stamped on — so this needs neither the row nor the
 * sibling column, and a write path that skipped canonicalization gets an error
 * naming the field rather than an integer that means something else.
 *
 * @throws Error when the value is not canonical.
 */
export const toStoredMoney = (value: unknown, field: FieldDef): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const spec = field.money;
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Partial<MoneyValue>;
    if (typeof v.amount === "number" && typeof v.currency === "string") {
      const currency = normalizeCurrency(v.currency);
      const exponent = currencyExponent(currency, spec);
      const minor = toMinorUnits(v.amount, exponent);
      return isDecimalStorage(spec) ? fromMinorUnits(minor, exponent) : minor;
    }
  }
  // A fixed-currency field can still interpret a bare number, which is what a
  // backup restore and a template seed hand over. A per-row-currency field
  // cannot, and saying so beats storing an unscaled integer.
  if (spec?.currency) {
    const currency = normalizeCurrency(spec.currency);
    const exponent = currencyExponent(currency, spec);
    const parsed = parseMoneyInput(value, () => exponent);
    if (parsed.currency && parsed.currency !== currency) {
      throw new Error(
        `${field.name}: is in ${parsed.currency}, but this field is denominated in ${currency}`,
      );
    }
    return isDecimalStorage(spec)
      ? fromMinorUnits(parsed.minor, exponent)
      : parsed.minor;
  }
  throw new Error(
    `${field.name}: a money value needs its currency — send { "amount": …, "currency": "…" }`,
  );
};

/** Convert a stored column value to the major-unit number a CSV cell carries. */
export const majorUnitsOf = (
  raw: unknown,
  field: FieldDef,
  currency: string | null,
): number | null => {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const exponent = currencyExponent(currency, field.money);
  return isDecimalStorage(field.money) ? Number(n.toFixed(exponent)) : fromMinorUnits(n, exponent);
};
