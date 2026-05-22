import { eq, isNull } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "../lib/locale";

/**
 * Runtime-mutable instance settings, backed by the `app_settings` key/value
 * table. Distinct from `Env` (deploy-time config — wrangler vars/secrets,
 * `.env`): these are the few knobs admins can flip from the UI without a
 * redeploy. Keep this list small and the keys whitelisted in
 * `routes/settings.ts`.
 */
export interface AppSettings {
  /** When false, account creation is rejected (any sign-up path). The very
   *  first user is always allowed so a fresh instance can bootstrap. */
  openSignup: boolean;
  /** Active locales for this workspace. Drives the Translations admin grid
   *  and the public `/api/i18n` endpoint. First entry is the default. */
  i18nLocales: string[];
  /** Locale returned by the public endpoint when the requested one has no
   *  string. Must exist in `i18nLocales`. */
  i18nDefaultLocale: string;
  /** Workspace default IANA time zone. Used to render dates for users who
   *  haven't set a personal one (`users.timezone`). */
  timezone: string;
  /** Custom headline for the public sign-in screen's brand panel. Empty
   *  string = use the built-in default copy. */
  signInHeadline: string;
  /** Custom tagline shown under the sign-in headline. Empty string = use the
   *  built-in default copy. */
  signInTagline: string;
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  openSignup: true,
  i18nLocales: ["en", "tr", "de", "es", "fr", "ja"],
  i18nDefaultLocale: "en",
  timezone: DEFAULT_TIMEZONE,
  signInHeadline: "",
  signInTagline: "",
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

export const loadAppSettings = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<AppSettings> => {
  const t = tableFor(dialect);
  try {
    const rows = (await (db as any)
      .select()
      .from(t)
      .where(tenantId ? eq(t.tenantId, tenantId) : isNull(t.tenantId))) as {
      key: string;
      value: unknown;
    }[];
    const out: AppSettings = { ...APP_SETTINGS_DEFAULTS };
    for (const r of rows) {
      if (r.key === "openSignup" && typeof r.value === "boolean")
        out.openSignup = r.value;
      else if (r.key === "i18nLocales" && isStringArray(r.value) && r.value.length > 0)
        out.i18nLocales = r.value;
      else if (r.key === "i18nDefaultLocale" && typeof r.value === "string")
        out.i18nDefaultLocale = r.value;
      else if (r.key === "timezone" && isValidTimeZone(r.value))
        out.timezone = r.value;
      else if (r.key === "signInHeadline" && typeof r.value === "string")
        out.signInHeadline = r.value;
      else if (r.key === "signInTagline" && typeof r.value === "string")
        out.signInTagline = r.value;
    }
    if (!out.i18nLocales.includes(out.i18nDefaultLocale)) {
      out.i18nDefaultLocale = out.i18nLocales[0] ?? "en";
    }
    return out;
  } catch {
    // Pre-migration deploy (table missing) or transient error — fall back to
    // permissive defaults rather than blocking auth.
    return { ...APP_SETTINGS_DEFAULTS };
  }
};
