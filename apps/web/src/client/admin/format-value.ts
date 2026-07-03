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
type FieldFormat = {
  style?: "plain" | "decimal" | "currency" | "percent";
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
}

/** Collapse an i18n_text map ({ en, tr }) to one string (English first). */
const pickI18n = (v: Record<string, unknown>): string => {
  const pick = v.en ?? Object.values(v).find((x) => x != null);
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
        return new Intl.NumberFormat(locale, { style: "percent", ...fd }).format(n);
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
 * `now` is injectable for deterministic relative-time tests.
 */
export const formatFieldValue = (
  value: unknown,
  field: FormattableField,
  locale = "en",
  now: number = Date.now(),
): string => {
  if (value === null || value === undefined || value === "") return "";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // i18n_text (or any {locale: value} map) — collapse before formatting.
    if (field.type === "i18n_text") return pickI18n(value as Record<string, unknown>);
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
