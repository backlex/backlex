/**
 * Shared helpers for the accounting write-backs (QuickBooks, Xero).
 *
 * The two providers post very different bodies, but they share the four
 * problems every ledger destination has, and each one has a wrong answer that
 * looks fine in a test and corrupts books in production:
 *
 *   - **A stable reference per row**, so a re-sent batch updates rather than
 *     invoices the customer twice. Derived from (sync, row), never from row
 *     data — see {@link ledgerRef}.
 *   - **Money that is a number**, not a string with a currency symbol in it.
 *   - **Dates as calendar days**, because an accounting date is a day, not an
 *     instant, and both APIs reject a full timestamp.
 *   - **Values that end up inside a QUERY**, because neither API has an
 *     upsert — you look the record up first, and looking it up means putting a
 *     value into an expression the provider parses.
 *
 * Pure + dependency-free, like every other file in this package.
 */

/** How long a derived reference is, in hex characters after the prefix.
 *  QuickBooks caps `DocNumber` at 21, so the whole thing has to be short. */
const REF_HEX = 12;

/** Marks a reference as one backlex minted, in a field a human also reads. */
const REF_PREFIX = "BX-";

/**
 * The reference a row is addressed by in the ledger.
 *
 * Neither QuickBooks nor Xero lets the caller choose a record's id, so the
 * upsert key has to be a field they can be QUERIED by — an invoice number, a
 * contact number. Derived from (sync, row) so it is:
 *
 *   - **stable** — the same row addresses the same invoice on every run, which
 *     is the whole of the idempotency story;
 *   - **collision-free across syncs** — two collections can hold the same
 *     primary key, and without the sync in the hash one sync's push would
 *     overwrite the other's invoices;
 *   - **safe to interpolate** — it is `[A-Z0-9-]` by construction, so the one
 *     value that is ALWAYS put into a provider query carries no injection
 *     surface at all. Row data that reaches a query goes through
 *     {@link quickbooksLiteral} / {@link xeroLiteral} instead.
 */
export const ledgerRef = async (syncKey: string, rowId: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${syncKey} ${rowId}`));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, REF_HEX);
  return `${REF_PREFIX}${hex.toUpperCase()}`;
};

/** A mapped column as a non-empty string, or `null`. */
export const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/**
 * A mapped column as an amount.
 *
 * A `decimal` column arrives as a string on both dialects, and a currency
 * column may carry its symbol and thousands separators. Anything that does not
 * resolve to a finite number is `null` and the caller skips the row rather than
 * posting a zero — an invoice for nothing is worse than an invoice that is
 * visibly missing.
 */
export const money = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  // Keep digits, sign and separators; drop symbols and spaces.
  const cleaned = v.trim().replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  // "1.234,56" (tr/de) vs "1,234.56" (en): whichever separator comes LAST is
  // the decimal one. Getting this backwards turns 1.234,56 into 1.23.
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const normalized =
    lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

/** `2026-08-02`. Timestamps arrive as epoch ms on SQLite and as a `Date` on
 *  Postgres, so both are accepted rather than assuming the dialect. */
export const dateOnly = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
};

/** A three-letter currency code, or `null`. Both providers reject anything
 *  else with a validation error that names the whole request, not the field. */
export const currency = (v: unknown): string | null => {
  const s = text(v)?.toUpperCase() ?? null;
  return s && /^[A-Z]{3}$/.test(s) ? s : null;
};

/**
 * Drop characters with no place in a ledger field and no escape in either
 * provider's query grammar.
 *
 * A code-point filter rather than a regex character class: the class would be
 * written with escapes that describe the very bytes it removes, and a tool that
 * helpfully resolves them turns the guard into its own counterexample.
 */
const stripControl = (v: string): string =>
  [...v]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join("");

/**
 * A value on its way into a QuickBooks query literal.
 *
 * QuickBooks has no upsert: a push finds the existing record with
 * `select * from Customer where DisplayName in (…)` and only then decides
 * whether to create or update. That means row data — a customer's name — is
 * parsed by Intuit as part of an expression, so the quote and the backslash
 * have to be escaped rather than trusted to be absent. A name like O'Brien is
 * ordinary, not an attack, and it is exactly the input that breaks a naive
 * concatenation.
 */
export const quickbooksLiteral = (v: string, max = 100): string =>
  stripControl(v).slice(0, max).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** The same, for Xero's `where` expressions — which quote with `"`. */
export const xeroLiteral = (v: string, max = 255): string =>
  stripControl(v).slice(0, max).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
