// Display formatting for a field value in lists / detail views. Pure + locale-
// aware — it only affects RENDERING; storage, the API, sorting and filtering
// always use the raw value. Falls back to a plain string when no `format` hint
// applies, so it's a safe drop-in for the old `cellText`.
//
// Uses a local structural type rather than importing FieldDef from @backlex/db:
// that package's index re-exports the server-side auto-migrate (migrations
// bundle → `.sql` imports), which would drag the whole server graph into the
// client typecheck program (which has no `*.sql` ambient). Keep in sync with
// FieldDef.format in packages/db/src/field-types.ts.
// `@backlex/db/geo` IS safe to import here, unlike the package root: it is a
// dependency-free subpath export that exists for exactly this reason, so the
// coordinates a table cell prints are formatted by the same function the server
// and the field editor use.
import { formatGeoPoint, tryParseGeoPoint } from "@backlex/db/geo";
// Same reasoning as `@backlex/db/geo` above: a dependency-free subpath export,
// so the amount a table cell prints is formatted by the exact function the
// server and the item form use.
import { formatMoney, type MoneyValue } from "@backlex/db/money";
import { formatPhone, type PhoneDisplay } from "@backlex/db/phone";
import { formatEmail, type EmailDisplay } from "@backlex/db/email";

type FieldFormat = {
  style?: "plain" | "decimal" | "currency" | "percent" | "percent100";
  precision?: number;
  currency?: string;
  thousandSeparator?: boolean;
  dateStyle?: "relative" | "date" | "datetime" | "time";
  prefix?: string;
  suffix?: string;
};

/** The slice of a field this renderer needs. */
export interface FormattableField {
  type: string;
  format?: FieldFormat;
  /** Value is a per-locale `{locale: value}` map — collapse before formatting. */
  localized?: boolean;
  /** A phone field renders through its own `display` rather than `format` —
   *  the stored value is canonical E.164, and the only alternative rendering is
   *  a space after the calling code. */
  phone?: { display?: PhoneDisplay };
  /** An email field renders through its own `display` rather than `format` —
   *  the stored value is canonical, and the only alternative rendering is the
   *  international domain decoded back into its own alphabet. */
  email?: { display?: EmailDisplay };
}

/** Field shape the label resolver needs. */
export interface LabelledField {
  name: string;
  label?: string;
  translations?: Record<string, string>;
}

/**
 * Resolve a field's display label for the active admin locale:
 * `translations[locale] ?? label ?? name`. Pure — call sites pass the current
 * `i18n.locale`.
 */
export const fieldLabel = (field: LabelledField, locale = "en"): string =>
  field.translations?.[locale] || field.label || field.name;

/** Collapse a localized `{locale: value}` map to one string. Prefers the
 *  workspace default language (`prefer`) when given, then English, then the
 *  first filled locale. */
const pickI18n = (v: Record<string, unknown>, prefer?: string): string => {
  const pick =
    (prefer ? v[prefer] : undefined) ?? v.en ?? Object.values(v).find((x) => x != null);
  return pick != null ? String(pick) : "";
};

/** Relative time like "3d ago" / "in 2h". Mirrors the list's fmtDate wording. */
const relative = (ms: number, now: number): string => {
  const diff = now - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? " ago" : "";
  const prefix = diff >= 0 ? "" : "in ";
  const min = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (abs < min) return "just now";
  if (abs < hour) return `${prefix}${Math.max(1, Math.floor(abs / min))}m${suffix}`;
  if (abs < day) return `${prefix}${Math.max(1, Math.floor(abs / hour))}h${suffix}`;
  if (abs < 7 * day) return `${prefix}${Math.floor(abs / day)}d${suffix}`;
  return new Date(ms).toISOString().slice(0, 10);
};

const wrap = (core: string, f: FieldFormat): string =>
  core === "" ? "" : `${f.prefix ?? ""}${core}${f.suffix ?? ""}`;

const formatNumber = (raw: unknown, f: FieldFormat, locale: string): string => {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return String(raw ?? "");
  const p = f.precision;
  const fd = p != null ? { minimumFractionDigits: p, maximumFractionDigits: p } : {};
  try {
    switch (f.style) {
      case "currency":
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: f.currency || "USD",
          ...fd,
        }).format(n);
      case "percent":
        // `Intl`'s own convention: the value is a FRACTION, so 0.2 → "20%".
        return new Intl.NumberFormat(locale, { style: "percent", ...fd }).format(n);
      case "percent100":
        // The column already holds the percentage, so 20 → "20%". Dividing here
        // rather than asking `Intl` for a plain number with a "%" suffix keeps
        // the locale's own percent sign, spacing and digit shaping — in Turkish
        // that is "%20", not "20%".
        return new Intl.NumberFormat(locale, { style: "percent", ...fd }).format(n / 100);
      case "decimal":
        return new Intl.NumberFormat(locale, {
          useGrouping: f.thousandSeparator ?? true,
          ...fd,
        }).format(n);
      default:
        return p != null ? n.toFixed(p) : String(n);
    }
  } catch {
    return String(n);
  }
};

const formatDate = (raw: unknown, f: FieldFormat, locale: string, now: number): string => {
  const ms =
    typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return String(raw ?? "");
  const d = new Date(ms);
  try {
    switch (f.dateStyle) {
      case "relative":
        return relative(ms, now);
      case "date":
        return d.toLocaleDateString(locale);
      case "time":
        return d.toLocaleTimeString(locale);
      case "datetime":
        return d.toLocaleString(locale);
      default:
        return d.toLocaleString(locale);
    }
  } catch {
    return d.toISOString();
  }
};

/**
 * Render a field value for display. `locale` is the admin's active UI locale;
 * `now` is injectable for deterministic relative-time tests. `defaultLocale` is
 * the workspace content default (`i18nDefaultLocale`) — a `localized` field
 * collapses to it before falling back to English.
 */
export const formatFieldValue = (
  value: unknown,
  field: FormattableField,
  locale = "en",
  now: number = Date.now(),
  defaultLocale?: string,
): string => {
  if (value === null || value === undefined || value === "") return "";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // A `localized` field value is a `{locale: value}` map; collapse to the
    // workspace default language (then English) before formatting.
    if (field.localized) {
      return pickI18n(value as Record<string, unknown>, defaultLocale);
    }
  }
  // A point renders as coordinates, not as `[object Object]` — which is what
  // `String(value)` at the bottom of this function would produce for the only
  // field type whose value is an object the user is meant to read.
  if (field.type === "geo") {
    const p = tryParseGeoPoint(value);
    return p ? formatGeoPoint(p) : "";
  }
  // `{ amount, currency }` renders as an amount in that currency — with its own
  // number of decimals, so a yen total is not printed with two of them. A money
  // field ignores `format.style`: the currency is on the value, which is
  // strictly better information than a display hint someone typed.
  if (field.type === "money") {
    const m = value as Partial<MoneyValue>;
    if (typeof m?.amount === "number" && typeof m?.currency === "string") {
      return formatMoney({ amount: m.amount, currency: m.currency }, locale);
    }
    return typeof value === "number" || typeof value === "string" ? String(value) : "";
  }
  // A stored number is canonical E.164, and that is what it renders as unless
  // the field asked for the one alternative the bundled calling-code table can
  // actually justify (a space after the country code). There is deliberately no
  // national format — see `packages/db/src/phone.ts` on why a numbering plan is
  // not a dataset this ships.
  if (field.type === "phone") {
    return formatPhone(value, field.phone?.display);
  }
  // A stored address is canonical, and that is what it renders as unless the
  // field asked for the one alternative worth offering: the A-label decoded
  // back, so `ada@xn--rnek-4qa.com` reads as `ada@örnek.com`. Never what a
  // caller receives from the API — the column holds the deliverable form.
  if (field.type === "email") {
    return formatEmail(value, field.email?.display);
  }
  const f = field.format;
  if (f) {
    if ((field.type === "integer" || field.type === "number") && f.style) {
      return wrap(formatNumber(value, f, locale), f);
    }
    if (field.type === "timestamp" && f.dateStyle) {
      return wrap(formatDate(value, f, locale, now), f);
    }
    if (f.prefix || f.suffix) return wrap(String(value), f);
  }
  return String(value);
};
