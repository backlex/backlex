/**
 * Money fields — an amount that knows what it is denominated in.
 *
 * Everything in this module is PURE: the ISO-4217 minor-unit table, the amount
 * grammar, the exact decimal↔integer conversion, and the formatter. Nothing
 * here imports anything, which is why `@backlex/db/money` is its own package
 * export — reaching it through the package root would drag the migration
 * bundles, and their `*.sql` imports, into the browser build. The admin's list
 * cell, its amount input and the server's write path all format and parse with
 * the same functions, so what an operator types, what is stored, and what is
 * printed cannot drift apart.
 *
 * ## The shape of the problem
 *
 * Two hundred columns across twenty-three of the twenty-seven schema templates
 * are money: `price`, `total`, `subtotal`, `amount_paid`, `salary`, `budget`,
 * `balance_due`. Every one of them was a bare `number`, and thirty-seven `text`
 * columns named `currency` sat next to them with nothing tying the two
 * together. That left three things broken at once:
 *
 *  - **The arithmetic.** `number` is `double precision` on Postgres and `REAL`
 *    on SQLite. `0.1 + 0.2` is not `0.3` in either, and a rollup that sums a
 *    thousand invoice lines accumulates the error into a stored total.
 *  - **The meaning.** A rollup, an aggregate or a dashboard panel would happily
 *    add ₺ to $ and report the sum as a number, because nothing in the schema
 *    said the rows were denominated differently.
 *  - **The rendering.** `Intl.NumberFormat` needs a currency code, and the
 *    admin had nowhere to get one from — so an amount printed as `1234.5`.
 *
 * ## Why amounts are integers
 *
 * A money field stores **minor units** — an integer count of the currency's
 * smallest denomination (cents, kuruş, fils). `19.99 USD` is `1999`; `1000 JPY`
 * is `1000` because the yen has no minor unit; `1.234 KWD` is `1234` because
 * the dinar has three. Integers are exact in both dialects (SQLite `INTEGER` is
 * 64-bit, Postgres `bigint`), they sum exactly, they sort correctly, and every
 * comparison SQL can make on them is the comparison the caller meant.
 *
 * The wire format is major units, because that is what humans, invoices and
 * every other system speak. The conversion happens exactly once on each edge of
 * the API, and it is done on the DECIMAL STRING rather than by multiplying a
 * double — `12.34 * 100` is `1233.9999999999998`, and the naive `Math.round`
 * around it gets `1.005` wrong.
 *
 * An adopted table whose amount column is already a `numeric`/`REAL` of major
 * units keeps that layout with `storage: "decimal"` — see {@link MoneySpec}.
 *
 * @module
 */

/**
 * A money value as it crosses the API — the amount in MAJOR units, and the
 * currency it is denominated in. Both halves are always present on a read: an
 * amount without its currency is the thing this field type exists to abolish.
 */
export interface MoneyValue {
  /** Major units — `19.99`, not `1999`. Exact to the currency's exponent. */
  amount: number;
  /** ISO-4217 alphabetic code, uppercase. */
  currency: string;
}

/**
 * Where a money field's currency comes from, and how the amount is stored.
 *
 * Exactly one of {@link currency} and {@link currencyField} must be set — a
 * money field with neither has no way to interpret its own column, and one with
 * both has two answers that can disagree.
 */
export interface MoneySpec {
  /**
   * A fixed ISO-4217 code for every row in this column. The common case: a
   * price list, a payroll table, a set of invoices a single business issues.
   */
  currency?: string;
  /**
   * The name of a sibling `text` field on the same collection holding the code
   * per row. The multi-currency case, and the one the catalog already had —
   * thirty-seven templates ship a `currency` column exactly like this.
   *
   * Aggregation over such a field is refused unless the query groups by it, and
   * a range filter must name the currency it is comparing against. Neither is
   * pedantry: minor units are only comparable within one currency, where `100`
   * is a dollar and also a hundred yen.
   */
  currencyField?: string;
  /**
   * Override the minor-unit exponent. Defaults to the ISO-4217 figure for
   * {@link currency} (see {@link MINOR_UNIT_EXPONENTS}), and to `2` for a code
   * the table does not know. Only meaningful with a fixed currency — with
   * `currencyField` the exponent is whatever each row's own code says.
   */
  exponent?: number;
  /**
   * How the amount sits in the column.
   *
   * - `minor` (the default, and the only one the schema applier ever creates) —
   *   an integer count of minor units in a `bigint`/`INTEGER` column. Exact.
   * - `decimal` — major units in whatever numeric column is already there. This
   *   exists for ADOPTED tables: a `numeric(10,2) price` that other systems
   *   still write to cannot be rescaled by ×100 just because backlex started
   *   reading it. It inherits that column's exactness, which on SQLite's `REAL`
   *   means sums drift in the last places; `docs/money.md` says so.
   */
  storage?: "minor" | "decimal";
}

/**
 * ISO-4217 currencies whose minor unit is NOT two decimal places. Everything
 * absent from this table is assumed to have two, which is right for all but the
 * ~30 codes listed here.
 *
 * Getting this wrong is a factor-of-100 error in stored money, so the entries
 * are the published ones rather than a guess: the zero-exponent list is the
 * currencies ISO marks as having no minor unit at all, and the three-exponent
 * list is the Gulf and North African dinars, whose fils is a thousandth.
 */
export const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  // No minor unit.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Thousandths.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Ten-thousandths — index units rather than cash, but they are ISO codes and
  // a workspace tracking one would otherwise silently lose two decimals.
  CLF: 4,
  UYW: 4,
};

/** The exponent assumed for a code the table above does not carry. */
export const DEFAULT_MINOR_UNIT_EXPONENT = 2;

/** The largest exponent a spec may pin. ISO does not go above four. */
export const MAX_MINOR_UNIT_EXPONENT = 6;

/**
 * A shortlist for the admin's currency picker — the codes a workspace is
 * overwhelmingly likely to want, with the non-two-decimal ones deliberately
 * represented so the exponent behaviour is discoverable. Not a validation list:
 * {@link isCurrencyCode} accepts any well-formed code, because a workspace may
 * legitimately track one this list has never heard of.
 */
export const COMMON_CURRENCIES: readonly { code: string; name: string }[] = [
  { code: "TRY", name: "Turkish lira" },
  { code: "USD", name: "US dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "Pound sterling" },
  { code: "JPY", name: "Japanese yen" },
  { code: "CHF", name: "Swiss franc" },
  { code: "CAD", name: "Canadian dollar" },
  { code: "AUD", name: "Australian dollar" },
  { code: "NZD", name: "New Zealand dollar" },
  { code: "SEK", name: "Swedish krona" },
  { code: "NOK", name: "Norwegian krone" },
  { code: "DKK", name: "Danish krone" },
  { code: "PLN", name: "Polish złoty" },
  { code: "CZK", name: "Czech koruna" },
  { code: "HUF", name: "Hungarian forint" },
  { code: "RON", name: "Romanian leu" },
  { code: "BGN", name: "Bulgarian lev" },
  { code: "RUB", name: "Russian ruble" },
  { code: "UAH", name: "Ukrainian hryvnia" },
  { code: "CNY", name: "Chinese yuan" },
  { code: "HKD", name: "Hong Kong dollar" },
  { code: "TWD", name: "New Taiwan dollar" },
  { code: "SGD", name: "Singapore dollar" },
  { code: "KRW", name: "South Korean won" },
  { code: "INR", name: "Indian rupee" },
  { code: "PKR", name: "Pakistani rupee" },
  { code: "IDR", name: "Indonesian rupiah" },
  { code: "MYR", name: "Malaysian ringgit" },
  { code: "THB", name: "Thai baht" },
  { code: "PHP", name: "Philippine peso" },
  { code: "VND", name: "Vietnamese đồng" },
  { code: "AED", name: "UAE dirham" },
  { code: "SAR", name: "Saudi riyal" },
  { code: "QAR", name: "Qatari riyal" },
  { code: "KWD", name: "Kuwaiti dinar" },
  { code: "BHD", name: "Bahraini dinar" },
  { code: "OMR", name: "Omani rial" },
  { code: "JOD", name: "Jordanian dinar" },
  { code: "ILS", name: "Israeli new shekel" },
  { code: "EGP", name: "Egyptian pound" },
  { code: "MAD", name: "Moroccan dirham" },
  { code: "TND", name: "Tunisian dinar" },
  { code: "NGN", name: "Nigerian naira" },
  { code: "KES", name: "Kenyan shilling" },
  { code: "GHS", name: "Ghanaian cedi" },
  { code: "ZAR", name: "South African rand" },
  { code: "BRL", name: "Brazilian real" },
  { code: "MXN", name: "Mexican peso" },
  { code: "ARS", name: "Argentine peso" },
  { code: "CLP", name: "Chilean peso" },
  { code: "COP", name: "Colombian peso" },
  { code: "PEN", name: "Peruvian sol" },
  { code: "AZN", name: "Azerbaijani manat" },
  { code: "GEL", name: "Georgian lari" },
  { code: "KZT", name: "Kazakhstani tenge" },
  { code: "RSD", name: "Serbian dinar" },
  { code: "ISK", name: "Icelandic króna" },
];

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * True for a well-formed ISO-4217 alphabetic code. Deliberately a SHAPE check
 * and not membership of a list: a closed list would have to be maintained
 * against a standard that keeps changing, and the failure mode of rejecting a
 * real code is worse than the failure mode of accepting an invented one (which
 * simply formats as its own code and assumes two decimals).
 */
export const isCurrencyCode = (value: unknown): value is string =>
  typeof value === "string" && CURRENCY_RE.test(value.trim().toUpperCase());

/** Normalize a code to its canonical uppercase form. Throws on a malformed one. */
export const normalizeCurrency = (value: unknown): string => {
  if (!isCurrencyCode(value)) {
    throw new Error(
      `invalid currency ${JSON.stringify(value)} — expected a three-letter ISO-4217 code like "USD"`,
    );
  }
  return String(value).trim().toUpperCase();
};

/**
 * How many decimal places this field's amounts carry.
 *
 * An explicit `spec.exponent` wins, then the ISO table, then two. `code` is the
 * ROW's currency when the field resolves one per row — which is why this takes
 * a code rather than reading `spec.currency`.
 */
export const currencyExponent = (code: string | null | undefined, spec?: MoneySpec): number => {
  if (spec?.exponent !== undefined) return spec.exponent;
  if (!code) return DEFAULT_MINOR_UNIT_EXPONENT;
  const known = MINOR_UNIT_EXPONENTS[code.trim().toUpperCase()];
  return known ?? DEFAULT_MINOR_UNIT_EXPONENT;
};

/**
 * Anything below this fraction of a minor unit is floating-point noise, not
 * precision the caller meant. `0.1 + 0.2` in a browser is
 * `0.30000000000000004`; the excess there is ~4e-17 of a cent. A JPY amount of
 * `19.999`, by contrast, is nine tenths of a yen the caller has to decide about.
 */
const NOISE = 1e-6;

/** Decimal string, no exponent notation. `-` sign, digits, optional fraction. */
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Render a finite JS number as a plain decimal string, expanding the
 * exponential form `String()` produces for very large and very small magnitudes
 * (`1e-7`, `1.2e+21`). Returns null when there is no such form to give.
 */
const toDecimalString = (n: number): string | null => {
  if (!Number.isFinite(n)) return null;
  const s = String(n);
  if (!s.includes("e") && !s.includes("E")) return s;
  // `toFixed` maxes out at 100 fraction digits and switches to exponential
  // above 1e21; anything out there is far past the safe-integer range this
  // module works in, so it is rejected rather than approximated.
  if (Math.abs(n) >= 1e21) return null;
  const fixed = n.toFixed(20);
  return fixed.includes("e") ? null : fixed;
};

/**
 * Convert a major-unit amount to an exact integer count of minor units.
 *
 * The conversion is done by SHIFTING THE DECIMAL POINT of the amount's string
 * form, never by multiplying a double: `12.34 * 100` is `1233.9999999999998`,
 * and `Math.round(1.005 * 100)` is `100` rather than `101`. Both errors are
 * silent, both are money, and both would be stored.
 *
 * Digits beyond the currency's exponent are an error, not something to round
 * away — `19.999 JPY` is not an amount the yen can express, and quantizing it
 * for the caller is the server inventing a number. The single exception is
 * floating-point noise below {@link NOISE} of a minor unit, which is an
 * artifact of the caller's arithmetic rather than a decision they made.
 *
 * @throws Error when the input is not a finite amount, carries more precision
 *   than the currency has, or falls outside the exactly-representable range.
 */
export const toMinorUnits = (amount: number | string, exponent: number): number => {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_MINOR_UNIT_EXPONENT) {
    throw new Error(`invalid minor-unit exponent ${exponent}`);
  }
  let text: string | null;
  if (typeof amount === "number") {
    text = toDecimalString(amount);
  } else if (typeof amount === "string") {
    text = amount.trim();
    // A string is allowed exponent notation too, but only via `Number` — the
    // grammar below is deliberately narrow so that "12,34" and "1 234" are
    // errors rather than guesses about which convention the caller writes in.
    if (/[eE]/.test(text)) text = toDecimalString(Number(text));
  } else {
    throw new Error("amount must be a number or a decimal string");
  }
  if (text === null || text === "") {
    throw new Error(`invalid amount ${JSON.stringify(amount)}`);
  }
  const m = DECIMAL_RE.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new Error(
      `invalid amount ${JSON.stringify(amount)} — expected a decimal like 19.99 (no thousands separators, "." for the decimal point)`,
    );
  }
  const negative = m[1] === "-";
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  const kept = frac.slice(0, exponent).padEnd(exponent, "0");
  const extra = frac.slice(exponent);
  let minor = Number(`${whole || "0"}${kept}`);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`amount ${text} is too large to store exactly`);
  }
  if (extra !== "") {
    const rest = Number(`0.${extra}`);
    if (rest >= NOISE && rest <= 1 - NOISE) {
      throw new Error(
        `amount ${text} has more decimal places than this currency (${exponent}) can express`,
      );
    }
    // Noise at the top of the interval rounds up — `0.29999999999999998` is
    // thirty cents that took a detour through binary.
    if (rest > 1 - NOISE) minor += 1;
    if (!Number.isSafeInteger(minor)) {
      throw new Error(`amount ${text} is too large to store exactly`);
    }
  }
  return negative ? -minor : minor;
};

/**
 * Convert minor units back to a major-unit number.
 *
 * Division by a power of ten is not exact in binary either (`1999 / 100` is
 * `19.989999999999998` in some engines), so the result is rebuilt from the
 * integer's digits and parsed once. What comes back is the shortest double that
 * round-trips to the same minor units, which is exactly the number a reader
 * expects to see.
 */
export const fromMinorUnits = (minor: number, exponent: number): number => {
  if (!Number.isFinite(minor)) return 0;
  if (exponent <= 0) return Math.trunc(minor);
  const negative = minor < 0;
  const digits = Math.abs(Math.trunc(minor)).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent);
  return Number(`${negative ? "-" : ""}${whole}.${frac}`);
};

/**
 * Everything {@link parseMoneyInput} accepts, in one place, so the error
 * message and the docs cannot describe different grammars.
 */
export const MONEY_INPUT_NOTE =
  'A money value may be a number (19.99), a decimal string ("19.99"), an object ({ "amount": 19.99, "currency": "USD" } or { "minor": 1999, "currency": "USD" }), or a string with a trailing ISO code ("19.99 USD"). Currency SYMBOLS are not accepted — "$" is four different currencies.';

/** `19.99 USD` / `USD 19.99` — a code on either side of the amount. */
const TAGGED_RE = /^([A-Za-z]{3})?\s*([+-]?[\d.,]+)\s*([A-Za-z]{3})?$/;

/** The result of reading a caller-supplied money value. */
export interface ParsedMoney {
  /** Exact minor units, once the currency is known. */
  minor: number;
  /**
   * The code the VALUE carried, if any. Null when the caller sent a bare
   * amount and meant the field's own currency.
   */
  currency: string | null;
}

/**
 * Parse an incoming money value into minor units plus whatever currency the
 * value itself named.
 *
 * Resolving that currency against the field's spec — and against the sibling
 * column, when there is one — is the caller's job: this function has no view of
 * the row. `exponentFor` is asked for the exponent once the currency is known,
 * because a per-row-currency field cannot know it in advance.
 *
 * @throws Error with a message suitable for a 422.
 */
export const parseMoneyInput = (
  raw: unknown,
  exponentFor: (currency: string | null) => number,
): ParsedMoney => {
  if (raw === null || raw === undefined || raw === "") {
    throw new Error("amount is empty");
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const currency =
      obj.currency === undefined || obj.currency === null
        ? null
        : normalizeCurrency(obj.currency);
    if (obj.minor !== undefined && obj.minor !== null) {
      const minor = typeof obj.minor === "string" ? Number(obj.minor) : obj.minor;
      if (typeof minor !== "number" || !Number.isSafeInteger(minor)) {
        throw new Error('"minor" must be a whole number of minor units');
      }
      if (obj.amount !== undefined && obj.amount !== null) {
        // Both halves given and disagreeing is a caller bug that would
        // otherwise resolve silently in favour of whichever key is read first.
        const fromAmount = toMinorUnits(
          obj.amount as number | string,
          exponentFor(currency),
        );
        if (fromAmount !== minor) {
          throw new Error(
            `"amount" (${String(obj.amount)}) and "minor" (${minor}) describe different values`,
          );
        }
      }
      return { minor, currency };
    }
    if (obj.amount === undefined || obj.amount === null) {
      throw new Error('a money object needs an "amount" or a "minor"');
    }
    return {
      minor: toMinorUnits(obj.amount as number | string, exponentFor(currency)),
      currency,
    };
  }
  if (typeof raw === "number") {
    return { minor: toMinorUnits(raw, exponentFor(null)), currency: null };
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    const m = TAGGED_RE.exec(text);
    if (!m) {
      throw new Error(`invalid amount ${JSON.stringify(raw)}. ${MONEY_INPUT_NOTE}`);
    }
    const lead = m[1];
    const tail = m[3];
    if (lead && tail) {
      throw new Error(`invalid amount ${JSON.stringify(raw)} — two currency codes`);
    }
    const currency = lead || tail ? normalizeCurrency(lead || tail) : null;
    const body = (m[2] ?? "").trim();
    if (body.includes(",")) {
      // "1,234.56" and "1.234,56" are the same eleven characters in two
      // conventions that disagree by a factor of a thousand. The admin input
      // resolves them against the UI locale before it posts; the API refuses to
      // guess. (docs/money.md § What the API will not guess)
      throw new Error(
        `invalid amount ${JSON.stringify(raw)} — remove thousands separators; the API reads "." as the decimal point`,
      );
    }
    return { minor: toMinorUnits(body, exponentFor(currency)), currency };
  }
  throw new Error(`invalid amount ${JSON.stringify(raw)}. ${MONEY_INPUT_NOTE}`);
};

/**
 * Render a money value for a human. Falls back to `12.34 XYZ` when the runtime
 * has no formatting data for the code — which is what `Intl` does with an
 * invented one, by throwing.
 */
export const formatMoney = (
  value: MoneyValue,
  locale = "en",
  spec?: MoneySpec,
): string => {
  const exponent = currencyExponent(value.currency, spec);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value.amount);
  } catch {
    return `${value.amount.toFixed(exponent)} ${value.currency}`;
  }
};

/**
 * The amount alone, with the currency's number of decimals and no symbol — the
 * form an editable input holds, and the form a CSV cell carries so a
 * spreadsheet reads it as a number.
 */
export const formatMoneyAmount = (
  amount: number,
  currency: string | null,
  spec?: MoneySpec,
): string => amount.toFixed(currencyExponent(currency, spec));

/**
 * Add money values that must all be in the same currency.
 *
 * Exported because a client holding rows the server filtered should be able to
 * total them with the same arithmetic the server would use — the same reason
 * `@backlex/db/geo` exports `distanceKm` rather than the API projecting a
 * distance column.
 *
 * @throws Error when the values disagree about the currency, which is the whole
 *   point: a sum of mixed money is not a smaller number, it is not a number.
 */
export const sumMoney = (values: readonly MoneyValue[], spec?: MoneySpec): MoneyValue | null => {
  if (values.length === 0) return null;
  const currency = normalizeCurrency(values[0]?.currency);
  const exponent = currencyExponent(currency, spec);
  let minor = 0;
  for (const v of values) {
    const code = normalizeCurrency(v.currency);
    if (code !== currency) {
      throw new Error(`cannot add ${currency} to ${code} — convert first, or total per currency`);
    }
    minor += toMinorUnits(v.amount, exponent);
  }
  return { amount: fromMinorUnits(minor, exponent), currency };
};

/** The context {@link validateMoneySpec} needs about the rest of the collection. */
export interface MoneySpecContext {
  /** Every other field on the collection, by name, with its type. */
  fieldTypes: Readonly<Record<string, string>>;
  /** The field being validated — so it cannot point its currency at itself. */
  fieldName: string;
}

/**
 * Validate a money field's configuration at SAVE time, so a misconfigured field
 * is a 422 on the schema edit rather than a column nobody can interpret.
 *
 * @throws Error with a message naming the field.
 */
export const validateMoneySpec = (spec: MoneySpec, ctx: MoneySpecContext): void => {
  const where = `Field "${ctx.fieldName}"`;
  const hasFixed = spec.currency !== undefined && spec.currency !== null && spec.currency !== "";
  const hasField =
    spec.currencyField !== undefined && spec.currencyField !== null && spec.currencyField !== "";
  if (hasFixed === hasField) {
    throw new Error(
      `${where}: a money field needs exactly one of "currency" (a fixed code) and "currencyField" (a sibling column holding the code)`,
    );
  }
  if (hasFixed) normalizeCurrency(spec.currency);
  if (hasField) {
    const target = spec.currencyField as string;
    if (target === ctx.fieldName) {
      throw new Error(`${where}: "currencyField" cannot point at the money field itself`);
    }
    const type = ctx.fieldTypes[target];
    if (type === undefined) {
      throw new Error(`${where}: "currencyField" names "${target}", which is not a field on this collection`);
    }
    if (type !== "text") {
      throw new Error(
        `${where}: "currencyField" must name a text field — "${target}" is ${type}`,
      );
    }
    if (spec.exponent !== undefined) {
      throw new Error(
        `${where}: "exponent" cannot be pinned alongside "currencyField" — each row's own currency decides how many decimals it has`,
      );
    }
  }
  if (spec.exponent !== undefined) {
    if (
      !Number.isInteger(spec.exponent) ||
      spec.exponent < 0 ||
      spec.exponent > MAX_MINOR_UNIT_EXPONENT
    ) {
      throw new Error(
        `${where}: "exponent" must be a whole number between 0 and ${MAX_MINOR_UNIT_EXPONENT}`,
      );
    }
  }
  if (spec.storage !== undefined && spec.storage !== "minor" && spec.storage !== "decimal") {
    throw new Error(`${where}: "storage" must be "minor" or "decimal"`);
  }
};

/** True when this field keeps major units in a numeric column (adopted tables). */
export const isDecimalStorage = (spec?: MoneySpec): boolean => spec?.storage === "decimal";
