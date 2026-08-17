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
  /** Per-collection list-view columns, keyed by collection slug → ordered field
   *  names shown as table columns. Admin-UI-only (rendering); the query engine
   *  never reads it. Empty / missing slug = the curated default columns. */
  listColumns: Record<string, string[]>;
  /** Ordered group-header names for the Collections page + sidebar tree.
   *  Rendering order for group sections; collection rows carry their own
   *  `group` value. Written by `POST /api/collections/layout`. */
  collectionGroups: string[];
  /** Automatic schema-snapshot cadence (#9). `off` disables it; `daily`/`weekly`
   *  make the cron tick capture a `kind:"scheduled"` schema snapshot when due. */
  schemaSnapshotSchedule: "off" | "daily" | "weekly";
  /** How many `scheduled` snapshots to retain — older ones are pruned by the
   *  same tick. Manual/branch/auto snapshots are never pruned. */
  schemaSnapshotKeepLast: number;
  /** Workspace usage limits (#12). Admin-editable via the Usage page; on
   *  managed cloud the `USAGE_LIMIT_*` env keys override field-by-field
   *  (plan injection) — see `services/usage.ts::resolveUsageLimits`. */
  usageLimits: UsageLimits;
}

/** Workspace usage-limit knobs. `null` = unlimited for that dimension. */
export interface UsageLimits {
  /** `off` = not even surfaced; `soft` = overage reported in the usage API/UI
   *  but never blocked; `hard` = over-limit traffic gets 429 QUOTA_EXCEEDED
   *  (requests) / 422 (storage + rows at their write sites). */
  mode: "off" | "soft" | "hard";
  maxRequestsPerMonth: number | null;
  maxStorageBytes: number | null;
  maxDbRows: number | null;
  /** Generations per month. CALLS rather than tokens, because the two provider
   *  paths report different quantities — a direct key returns tokens, the
   *  managed-cloud gateway returns neurons and no tokens — so a call is the
   *  only unit both can be held to. */
  maxAiCallsPerMonth: number | null;
}

export const USAGE_LIMITS_DEFAULTS: UsageLimits = {
  mode: "off",
  maxRequestsPerMonth: null,
  maxStorageBytes: null,
  maxDbRows: null,
  maxAiCallsPerMonth: null,
};

const nullablePosInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;

export const parseUsageLimits = (v: unknown): UsageLimits => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ...USAGE_LIMITS_DEFAULTS };
  const o = v as Record<string, unknown>;
  return {
    mode: o.mode === "soft" || o.mode === "hard" ? o.mode : "off",
    maxRequestsPerMonth: nullablePosInt(o.maxRequestsPerMonth),
    maxStorageBytes: nullablePosInt(o.maxStorageBytes),
    maxDbRows: nullablePosInt(o.maxDbRows),
    maxAiCallsPerMonth: nullablePosInt(o.maxAiCallsPerMonth),
  };
};

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  i18nLocales: ["en", "tr", "de", "es", "fr", "ja"],
  i18nDefaultLocale: "en",
  timezone: DEFAULT_TIMEZONE,
  erdLayout: {},
  listColumns: {},
  collectionGroups: [],
  schemaSnapshotSchedule: "off",
  schemaSnapshotKeepLast: 7,
  usageLimits: { ...USAGE_LIMITS_DEFAULTS },
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

const isListColumns = (v: unknown): v is Record<string, string[]> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every(isStringArray);

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
      if (r.key === "i18nLocales" && isStringArray(r.value) && r.value.length > 0)
        out.i18nLocales = r.value;
      else if (r.key === "i18nDefaultLocale" && typeof r.value === "string")
        out.i18nDefaultLocale = r.value;
      else if (r.key === "timezone" && isValidTimeZone(r.value))
        out.timezone = r.value;
      else if (r.key === "erdLayout" && isErdLayout(r.value))
        out.erdLayout = r.value;
      else if (r.key === "listColumns" && isListColumns(r.value))
        out.listColumns = r.value;
      else if (r.key === "collectionGroups" && isStringArray(r.value))
        out.collectionGroups = r.value;
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
      else if (r.key === "usageLimits") out.usageLimits = parseUsageLimits(r.value);
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

/**
 * Whether an email + password may be exchanged for a session, and on which
 * plane.
 *
 * Once a workspace has SSO, a passkey, or a magic link, the password is the
 * weakest surviving way in — and the one an attacker with a credential dump
 * tries. Turning SSO *on* does not turn the password *off*, so without this
 * there is no way to finish the migration.
 *
 * - `enabled`  — both planes accept a password (the default).
 * - `app-only` — workspace end-users still may; the admin dashboard may not.
 *   This is the usual shape: staff go through the company IdP, customers keep
 *   the login they signed up with.
 * - `disabled` — neither plane accepts one.
 *
 * Instance-global (the `tenant_id IS NULL` row), for the same reason the
 * sign-in branding is: the admin sign-in page is reached before any workspace
 * is selected, so there is no tenant to scope the answer to.
 */
export type PasswordLoginMode = "enabled" | "app-only" | "disabled";

export const PASSWORD_LOGIN_DEFAULT: PasswordLoginMode = "enabled";

export const isPasswordLoginMode = (v: unknown): v is PasswordLoginMode =>
  v === "enabled" || v === "app-only" || v === "disabled";

/** Read the instance-global password-login mode (always the `tenant_id IS NULL`
 *  row). Any read failure resolves to `enabled` — a settings table that cannot
 *  be read must not lock every admin out of their own instance. */
export const loadPasswordLoginMode = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): Promise<PasswordLoginMode> => {
  const t = tableFor(dialect);
  try {
    const rows = (await (db as any)
      .select()
      .from(t)
      .where(isNull(t.tenantId))) as { key: string; value: unknown }[];
    const row = rows.find((r) => r.key === "passwordLogin");
    return row && isPasswordLoginMode(row.value) ? row.value : PASSWORD_LOGIN_DEFAULT;
  } catch {
    return PASSWORD_LOGIN_DEFAULT;
  }
};

/** Keys persisted by {@link SignInBranding} plus the password-login mode. The
 *  settings route consults this to route these keys to the global
 *  (`tenant_id IS NULL`) row on write. */
export const SIGN_IN_BRANDING_KEYS = [
  "signInHeadline",
  "signInTagline",
  "termsUrl",
  "privacyUrl",
  "passwordLogin",
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
      else if (r.key === "termsUrl" && typeof r.value === "string")
        out.termsUrl = r.value;
      else if (r.key === "privacyUrl" && typeof r.value === "string")
        out.privacyUrl = r.value;
    }
  } catch {
    // Pre-migration deploy (table missing) — fall back to empty defaults.
  }
  return out;
};
