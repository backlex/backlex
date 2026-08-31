/**
 * Display formatting, with the locale named ONCE and never left to the runtime.
 *
 * `Intl.DateTimeFormat(undefined, …)` resolves against the browser's UI
 * language, which is not the same thing as the language the page is written in
 * — a Turkish page in a browser whose UI is English renders Turkish words
 * beside English month names, and nothing in the code says so. So the locale is
 * a constant here and every formatter takes it explicitly.
 */

export const LOCALE = "tr-TR";
export const TIMEZONE = "Europe/Istanbul";

const dateFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone: TIMEZONE });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TIMEZONE,
});
const timeFmt = new Intl.DateTimeFormat(LOCALE, { timeStyle: "short", timeZone: TIMEZONE });

type Stamp = number | string | null | undefined;

const toDate = (v: Stamp): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const fmtDate = (v: Stamp): string => {
  const d = toDate(v);
  return d ? dateFmt.format(d) : "—";
};

export const fmtDateTime = (v: Stamp): string => {
  const d = toDate(v);
  return d ? dateTimeFmt.format(d) : "—";
};

export const fmtTime = (v: Stamp): string => {
  const d = toDate(v);
  return d ? timeFmt.format(d) : "—";
};

/** "3 saat önce". Falls back to an absolute date past a week, where "8 gün
 *  önce" stops being the more useful of the two. */
export function fmtRelative(v: Stamp): string {
  const d = toDate(v);
  if (!d) return "—";
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs > 7 * 86_400_000) return dateFmt.format(d);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), "second");
}

/** A money field, formatted in the currency the SERVER said it was in — never
 *  a hardcoded symbol, because the pair is what the API returns for a reason. */
export function fmtMoney(m: { amount: number; currency: string } | null | undefined): string {
  if (!m || typeof m.amount !== "number") return "—";
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: m.currency || "TRY",
    maximumFractionDigits: 2,
  }).format(m.amount);
}

const numberFmt = new Intl.NumberFormat(LOCALE);
export const fmtNumber = (n: number | null | undefined): string =>
  typeof n === "number" ? numberFmt.format(n) : "—";

export const fmtWeight = (g: number | null | undefined): string =>
  typeof g !== "number" ? "—" : g >= 1000 ? `${numberFmt.format(g / 1000)} kg` : `${numberFmt.format(g)} g`;

// ── Domain vocabulary ───────────────────────────────────────────────────────

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  new: { label: "Yeni", tone: "slate" },
  confirmed: { label: "Onaylandı", tone: "blue" },
  picking: { label: "Toplanıyor", tone: "amber" },
  packed: { label: "Paketlendi", tone: "purple" },
  shipped: { label: "Sevk edildi", tone: "teal" },
  delivered: { label: "Teslim edildi", tone: "green" },
  cancelled: { label: "İptal", tone: "red" },
};

export const WAVE_STATUS: Record<string, { label: string; tone: string }> = {
  planned: { label: "Planlandı", tone: "slate" },
  released: { label: "Sahaya verildi", tone: "blue" },
  in_progress: { label: "Toplanıyor", tone: "amber" },
  completed: { label: "Tamamlandı", tone: "green" },
  cancelled: { label: "İptal", tone: "red" },
};

export const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Bekliyor", tone: "slate" },
  picking: { label: "Toplanıyor", tone: "amber" },
  picked: { label: "Toplandı", tone: "green" },
  short: { label: "Eksik", tone: "red" },
};

export const SHIPMENT_STATUS: Record<string, { label: string; tone: string }> = {
  created: { label: "Oluşturuldu", tone: "slate" },
  handed_over: { label: "Kargoya verildi", tone: "blue" },
  in_transit: { label: "Yolda", tone: "amber" },
  out_for_delivery: { label: "Dağıtımda", tone: "purple" },
  delivered: { label: "Teslim edildi", tone: "green" },
  returned: { label: "İade", tone: "amber" },
  lost: { label: "Kayıp", tone: "red" },
};

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Taslak", tone: "gray" },
  scheduled: { label: "Planlandı", tone: "blue" },
  active: { label: "Yayında", tone: "green" },
  paused: { label: "Duraklatıldı", tone: "amber" },
  ended: { label: "Bitti", tone: "slate" },
};

export const PACKAGE_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "Açık", tone: "amber" },
  sealed: { label: "Kapatıldı", tone: "blue" },
  handed_over: { label: "Kargoya verildi", tone: "green" },
};

export const CHANNEL: Record<string, string> = {
  web: "Web",
  marketplace: "Pazaryeri",
  telefon: "Telefon",
  magaza: "Mağaza",
};

export const PRIORITY: Record<string, { label: string; tone: string }> = {
  standart: { label: "Standart", tone: "gray" },
  hizli: { label: "Hızlı", tone: "amber" },
  ayni_gun: { label: "Aynı gün", tone: "red" },
};

export const SERVICE: Record<string, string> = {
  standart: "Standart",
  ekspres: "Ekspres",
  ayni_gun: "Aynı gün",
};

export const MOVEMENT_REASON: Record<string, string> = {
  receipt: "Mal kabul",
  pick: "Toplama",
  adjustment: "Sayım farkı",
  transfer: "Transfer",
  return: "İade girişi",
  damage: "Hasar/fire",
};

export const SEGMENT: Record<string, { label: string; tone: string }> = {
  standart: { label: "Standart", tone: "gray" },
  gumus: { label: "Gümüş", tone: "slate" },
  altin: { label: "Altın", tone: "amber" },
  platin: { label: "Platin", tone: "purple" },
};
