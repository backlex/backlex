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
  /** Active locales for this workspace. Drives the Translations admin grid
   *  and the public `/api/i18n` endpoint. First entry is the default. */
  i18nLocales: string[];
  /** Locale returned by the public endpoint when the requested one has no
   *  string. Must exist in `i18nLocales`. */
  i18nDefaultLocale: string;
  /** Workspace default IANA time zone. Used to render dates for users who
   *  haven't set a personal one (`users.timezone`). */
  timezone: string;
  /** Saved node positions for the Schema graph (ERD) editor, keyed by
   *  collection slug. Admin-UI-only convenience state — never read by the
   *  query engine. Empty object = fall back to the deterministic auto-layout. */
  erdLayout: Record<string, { x: number; y: number }>;
  /** Automatic schema-snapshot cadence (#9). `off` disables it; `daily`/`weekly`
   *  make the cron tick capture a `kind:"scheduled"` schema snapshot when due. */
  schemaSnapshotSchedule: "off" | "daily" | "weekly";
  /** How many `scheduled` snapshots to retain — older ones are pruned by the
   *  same tick. Manual/branch/auto snapshots are never pruned. */
  schemaSnapshotKeepLast: number;
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  i18nLocales: ["en", "tr", "de", "es", "fr", "ja"],
  i18nDefaultLocale: "en",
  timezone: DEFAULT_TIMEZONE,
  erdLayout: {},
  schemaSnapshotSchedule: "off",
  schemaSnapshotKeepLast: 7,
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isErdLayout = (
  v: unknown,
): v is Record<string, { x: number; y: number }> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every(
    (p) =>
      !!p &&
      typeof p === "object" &&
      typeof (p as { x?: unknown }).x === "number" &&
      typeof (p as { y?: unknown }).y === "number",
  );

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

/**
 * Per-isolate read cache. Settings change rarely (admin PATCH, backup restore)
 * but are read on hot paths (public i18n endpoint, item i18n serialization),
 * each read costing a DB round-trip on D1. Keyed on the live `db` instance via
 * WeakMap so a different database (tests spin a fresh one per spec) can never
 * serve another's rows — the global `tenant_id IS NULL` branding row would
 * otherwise collide across databases. Writers must call
 * {@link invalidateSettingsCache}; the TTL only bounds cross-isolate staleness.
 */
const SETTINGS_CACHE_TTL_MS = 60_000;
const settingsCache = new WeakMap<
  object,
  Map<string, { value: AppSettings; expires: number }>
>();
const brandingCache = new WeakMap<
  object,
  { value: SignInBranding; expires: number }
>();

export const invalidateSettingsCache = (db: unknown): void => {
  settingsCache.delete(db as object);
  brandingCache.delete(db as object);
};

export const loadAppSettings = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<AppSettings> => {
  const cacheKey = tenantId ?? "__global__";
  const cached = settingsCache.get(db)?.get(cacheKey);
  if (cached && cached.expires > Date.now()) return { ...cached.value };
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
      if (r.key === "i18nLocales" && isStringArray(r.value) && r.value.length > 0)
        out.i18nLocales = r.value;
      else if (r.key === "i18nDefaultLocale" && typeof r.value === "string")
        out.i18nDefaultLocale = r.value;
      else if (r.key === "timezone" && isValidTimeZone(r.value))
        out.timezone = r.value;
      else if (r.key === "erdLayout" && isErdLayout(r.value))
        out.erdLayout = r.value;
      else if (
        r.key === "schemaSnapshotSchedule" &&
        (r.value === "off" || r.value === "daily" || r.value === "weekly")
      )
        out.schemaSnapshotSchedule = r.value;
      else if (
        r.key === "schemaSnapshotKeepLast" &&
        typeof r.value === "number" &&
        Number.isFinite(r.value)
      )
        out.schemaSnapshotKeepLast = Math.min(50, Math.max(1, Math.floor(r.value)));
    }
    if (!out.i18nLocales.includes(out.i18nDefaultLocale)) {
      out.i18nDefaultLocale = out.i18nLocales[0] ?? "en";
    }
    // Cache a copy so a caller mutating its result can't poison later reads.
    const byDb = settingsCache.get(db) ?? new Map();
    settingsCache.set(db, byDb);
    byDb.set(cacheKey, {
      value: { ...out },
      expires: Date.now() + SETTINGS_CACHE_TTL_MS,
    });
    return out;
  } catch {
    // Pre-migration deploy (table missing) or transient error — fall back to
    // permissive defaults rather than blocking auth. Deliberately not cached:
    // the table appearing a moment later should heal on the next read.
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
  /** Terms of Service URL shown on the sign-up consent line; empty = hide link. */
  termsUrl: string;
  /** Privacy Policy URL shown on the sign-up consent line; empty = hide link. */
  privacyUrl: string;
}

export const SIGN_IN_BRANDING_DEFAULTS: SignInBranding = {
  signInHeadline: "",
  signInTagline: "",
  termsUrl: "",
  privacyUrl: "",
};

/** Keys persisted by {@link SignInBranding}. The settings route consults this
 *  to route these keys to the global (`tenant_id IS NULL`) row on write. */
export const SIGN_IN_BRANDING_KEYS = [
  "signInHeadline",
  "signInTagline",
  "termsUrl",
  "privacyUrl",
] as const;

/** Read the instance-global login-screen branding (always the
 *  `tenant_id IS NULL` row, regardless of any active workspace). */
export const loadSignInBranding = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): Promise<SignInBranding> => {
  const cached = brandingCache.get(db);
  if (cached && cached.expires > Date.now()) return { ...cached.value };
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
      else if (r.key === "termsUrl" && typeof r.value === "string")
        out.termsUrl = r.value;
      else if (r.key === "privacyUrl" && typeof r.value === "string")
        out.privacyUrl = r.value;
    }
    brandingCache.set(db, {
      value: { ...out },
      expires: Date.now() + SETTINGS_CACHE_TTL_MS,
    });
  } catch {
    // Pre-migration deploy (table missing) — fall back to empty defaults,
    // uncached so the table appearing later heals on the next read.
  }
  return out;
};
