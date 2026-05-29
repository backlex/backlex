import { eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
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
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  openSignup: true,
  i18nLocales: ["en", "tr", "de", "es", "fr", "ja"],
  i18nDefaultLocale: "en",
  timezone: DEFAULT_TIMEZONE,
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

/**
 * Login-screen branding — the headline/tagline shown on the public sign-in
 * page. Unlike {@link AppSettings} these are **instance-global**, not
 * per-workspace: the sign-in page is reached before any workspace is selected,
 * so there is no active tenant to scope them to. They live on the
 * `app_settings` row with a NULL `tenant_id` (the global-settings row).
 */
export interface SignInBranding {
  /** Custom headline; empty string = use the client's built-in default. */
  signInHeadline: string;
  /** Custom tagline; empty string = use the client's built-in default. */
  signInTagline: string;
}

export const SIGN_IN_BRANDING_DEFAULTS: SignInBranding = {
  signInHeadline: "",
  signInTagline: "",
};

/** Keys persisted by {@link SignInBranding}. The settings route consults this
 *  to route these keys to the global (`tenant_id IS NULL`) row on write. */
export const SIGN_IN_BRANDING_KEYS = [
  "signInHeadline",
  "signInTagline",
] as const;

/** Read the instance-global login-screen branding (always the
 *  `tenant_id IS NULL` row, regardless of any active workspace). */
export const loadSignInBranding = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): Promise<SignInBranding> => {
  const t = tableFor(dialect);
  const out: SignInBranding = { ...SIGN_IN_BRANDING_DEFAULTS };
  try {
    const rows = (await (db as any)
      .select()
      .from(t)
      .where(isNull(t.tenantId))) as { key: string; value: unknown }[];
    for (const r of rows) {
      if (r.key === "signInHeadline" && typeof r.value === "string")
        out.signInHeadline = r.value;
      else if (r.key === "signInTagline" && typeof r.value === "string")
        out.signInTagline = r.value;
    }
  } catch {
    // Pre-migration deploy (table missing) — fall back to empty defaults.
  }
  return out;
};
