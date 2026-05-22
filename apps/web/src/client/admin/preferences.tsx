// Locale + time-zone preferences for the admin SPA.
//
// `PreferencesProvider` loads the signed-in user's resolved preferences once
// (`GET /api/account/preferences`) and hands every page timezone-/locale-aware
// date formatters via `usePreferences()`. The effective locale = user override
// → workspace default → "en"; the effective time zone resolves the same way.
//
// Also exports the option builders the Settings + Account forms share so the
// workspace language list and time-zone pickers stay consistent.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { accountApi, type ApiAccountPreferences } from "./api";

export const DEFAULT_LOCALE = "en";
export const DEFAULT_TIMEZONE = "UTC";

/** Mirror of the server's `LocaleCode` regex (`routes/settings.ts`) — a
 *  language tag with at most one subtag (script / region). Keep in sync. */
export const LOCALE_CODE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

/** A generous set of commonly-translated languages offered in the workspace
 *  "add language" picker. Any other valid code can still be typed in. */
export const COMMON_LANGUAGES: string[] = [
  "en", "tr", "de", "es", "fr", "it", "pt", "pt-BR", "nl", "sv", "da", "nb",
  "fi", "pl", "cs", "sk", "sl", "hr", "sr", "hu", "ro", "bg", "el", "is", "ga",
  "ru", "uk", "be", "kk", "az", "hy", "ka",
  "ar", "he", "fa", "ur", "ps",
  "hi", "bn", "ta", "te", "mr", "gu", "pa", "ml", "kn", "ne", "si",
  "th", "vi", "id", "ms", "fil", "my", "km", "lo",
  "ja", "ko", "zh", "zh-Hant",
  "sw", "am", "ha", "yo", "zu", "af",
];

type DateInput = string | number | Date | null | undefined;

const toDate = (v: DateInput): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/** Display name for a locale, e.g. `tr` → "Türkçe — Turkish". Falls back to
 *  the raw code on runtimes without `Intl.DisplayNames`. */
export const localeLabel = (code: string): string => {
  try {
    const native = new Intl.DisplayNames([code], { type: "language" }).of(code);
    const english = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (native && english && native.toLowerCase() !== english.toLowerCase()) {
      return `${native} — ${english}`;
    }
    return native || english || code;
  } catch {
    return code;
  }
};

export interface SelectOptionLite {
  value: string;
  label: string;
}

/** Common languages not already in `exclude`, for the "add language" picker. */
export const languageOptions = (
  exclude: readonly string[],
): SelectOptionLite[] => {
  const seen = new Set(exclude.map((c) => c.toLowerCase()));
  return COMMON_LANGUAGES.filter((c) => !seen.has(c.toLowerCase())).map((c) => ({
    value: c,
    label: `${localeLabel(c)}  ·  ${c}`,
  }));
};

// --- Time zones -----------------------------------------------------------

/** Curated fallback for runtimes that lack `Intl.supportedValuesOf`. */
const FALLBACK_TIMEZONES = [
  "UTC", "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos",
  "America/Anchorage", "America/Bogota", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Mexico_City", "America/New_York",
  "America/Sao_Paulo", "America/Toronto", "Asia/Dubai", "Asia/Hong_Kong",
  "Asia/Istanbul", "Asia/Jakarta", "Asia/Kolkata", "Asia/Seoul",
  "Asia/Shanghai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Berlin", "Europe/Istanbul", "Europe/London",
  "Europe/Madrid", "Europe/Moscow", "Europe/Paris", "Pacific/Auckland",
];

const supportedTimeZones = (): string[] => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (typeof fn === "function") {
      const list = fn("timeZone");
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch {
    /* fall through to the curated list */
  }
  return FALLBACK_TIMEZONES;
};

/** Current UTC offset for `tz`, e.g. "GMT+3". Empty when unavailable. */
const offsetLabel = (tz: string): string => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
};

let cachedTimezoneOptions: SelectOptionLite[] | null = null;

/** Every IANA zone the runtime knows, each labelled with its current offset.
 *  Computed once and cached — UTC sorts first, then alphabetical. */
export const timezoneOptions = (): SelectOptionLite[] => {
  if (cachedTimezoneOptions) return cachedTimezoneOptions;
  const zoneSet = new Set(supportedTimeZones());
  // `Intl.supportedValuesOf("timeZone")` omits the bare "UTC" id on most
  // engines (it lists "Etc/UTC" instead) — but "UTC" is the stored default,
  // so it must always be a selectable option or the picker renders blank.
  zoneSet.add("UTC");
  const zones = [...zoneSet].sort((a, b) => {
    if (a === "UTC") return -1;
    if (b === "UTC") return 1;
    return a.localeCompare(b);
  });
  cachedTimezoneOptions = zones.map((tz) => {
    const off = offsetLabel(tz);
    const name = tz.replace(/_/g, " ");
    return { value: tz, label: off ? `${name}  (${off})` : name };
  });
  return cachedTimezoneOptions;
};

// --- Formatters -----------------------------------------------------------

export interface DateFormatters {
  /** Date only, e.g. "May 22, 2026". */
  formatDate: (v: DateInput) => string;
  /** Date + time in the effective time zone. */
  formatDateTime: (v: DateInput) => string;
  /** Time only in the effective time zone. */
  formatTime: (v: DateInput) => string;
  /** Locale-aware relative time, e.g. "3 minutes ago". */
  formatRelative: (v: DateInput) => string;
}

const safeFormat = <T,>(build: () => T, fallback: () => T): T => {
  try {
    return build();
  } catch {
    return fallback();
  }
};

/** Build a set of date formatters bound to a locale + IANA time zone. An
 *  invalid locale/zone degrades gracefully to en/UTC rather than throwing. */
export const makeFormatters = (
  locale: string,
  timezone: string,
): DateFormatters => {
  const dateFmt = safeFormat(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: timezone }),
    () => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }),
  );
  const dateTimeFmt = safeFormat(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }),
    () =>
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }),
  );
  const timeFmt = safeFormat(
    () => new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: timezone }),
    () => new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: "UTC" }),
  );
  const relFmt = safeFormat(
    () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
    () => new Intl.RelativeTimeFormat("en", { numeric: "auto" }),
  );

  const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ];

  return {
    formatDate: (v) => {
      const d = toDate(v);
      return d ? dateFmt.format(d) : "—";
    },
    formatDateTime: (v) => {
      const d = toDate(v);
      return d ? dateTimeFmt.format(d) : "—";
    },
    formatTime: (v) => {
      const d = toDate(v);
      return d ? timeFmt.format(d) : "—";
    },
    formatRelative: (v) => {
      const d = toDate(v);
      if (!d) return "—";
      const diffMs = d.getTime() - Date.now();
      const abs = Math.abs(diffMs);
      for (const [unit, ms] of RELATIVE_UNITS) {
        if (abs >= ms || unit === "second") {
          return relFmt.format(Math.round(diffMs / ms), unit);
        }
      }
      return relFmt.format(0, "second");
    },
  };
};

// --- Context --------------------------------------------------------------

export interface PreferencesContextValue extends DateFormatters {
  /** Effective locale (user override → workspace default → "en"). */
  locale: string;
  /** Effective IANA time zone (user override → workspace default → "UTC"). */
  timezone: string;
  /** Raw payload — `user.*` may be null; `workspace.locales` drives pickers. */
  prefs: ApiAccountPreferences | null;
  loading: boolean;
  /** Re-fetch from the server — call after saving preferences. */
  refresh: () => Promise<void>;
}

const buildValue = (
  locale: string,
  timezone: string,
  prefs: ApiAccountPreferences | null,
  loading: boolean,
  refresh: () => Promise<void>,
): PreferencesContextValue => ({
  locale,
  timezone,
  prefs,
  loading,
  refresh,
  ...makeFormatters(locale, timezone),
});

const PreferencesContext = createContext<PreferencesContextValue>(
  buildValue(DEFAULT_LOCALE, DEFAULT_TIMEZONE, null, true, async () => {}),
);

/** Resolved locale/time-zone + date formatters for the signed-in admin. */
export const usePreferences = (): PreferencesContextValue =>
  useContext(PreferencesContext);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ApiAccountPreferences | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await accountApi.getPreferences();
      setPrefs(r.data);
    } catch {
      // Not signed in / endpoint missing — keep the en/UTC defaults.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<PreferencesContextValue>(() => {
    const locale = prefs?.effective.locale || DEFAULT_LOCALE;
    const timezone = prefs?.effective.timezone || DEFAULT_TIMEZONE;
    return buildValue(locale, timezone, prefs, loading, refresh);
  }, [prefs, loading, refresh]);

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}
