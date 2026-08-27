import type { Money } from "./backlex";

/** Render a money pair through `Intl`, so the unit comes from the data rather
 *  than from a `$` glued onto a number. */
export function fmtMoney(m: Money | number | null | undefined, fallbackCurrency = "USD"): string {
  if (m == null) return "—";
  const amount = typeof m === "number" ? m : m.amount;
  const currency = typeof m === "number" ? fallbackCurrency : (m.currency ?? fallbackCurrency);
  if (!Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The bare number out of a money pair, for arithmetic and for form inputs. */
export function moneyAmount(m: Money | number | null | undefined): number {
  if (m == null) return 0;
  return typeof m === "number" ? m : (m.amount ?? 0);
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(n);
}

/** Timestamps arrive as epoch milliseconds from `ts()` columns and as ISO
 *  strings from the system `created_at`; both land here. */
export function fmtDate(v: unknown): string {
  if (v == null || v === "") return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(v: unknown): string {
  if (v == null || v === "") return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `<input type="datetime-local">` wants a local-time string with no zone. */
export function toLocalInput(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(s: string): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}
