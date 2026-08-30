import { eq, isNull, or } from "drizzle-orm";
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
  /** Workspace default currency (ISO-4217, upper-case) — the code the admin
   *  form pre-selects when a money field is created. Authoring convenience
   *  only: it is copied onto the field spec at creation time and never read
   *  again at runtime, because an amount whose currency could change with a
   *  settings toggle would silently restate every price in the workspace.
   *
   *  This key was in the PATCH whitelist for three releases with no reader
   *  here, so the admin's choice was accepted, stored, and then dropped on
   *  every read — `add-field.tsx` asked `GET /api/admin/settings` for
   *  `defaultCurrency`, got `undefined`, and fell back to USD forever. A green
   *  toast for work that did not happen. */
  defaultCurrency: string;
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
  // USD, because that is what the money-field editor has always fallen back to
  // client-side (`emptyMoneyDraft`). Reading the key correctly must not move
  // the default under workspaces that never set one.
  defaultCurrency: "USD",
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

/**
 * The tenant id the instance-global settings tier is stored under.
 *
 * It used to be `NULL`, which made "this row belongs to the whole instance"
 * indistinguishable from "this row's tenant column was never filled in" — the
 * same value a bug produces. Every other layered config table in this codebase
 * already answers that with a sentinel (`GLOBAL_EMAIL_CONFIG_ID`,
 * `GLOBAL_AUTH_CONFIG_ID`, `GLOBAL_WORKSPACE_CONFIG_ID`, …), and they all spell
 * it the same way, so `app_settings` now joins them.
 *
 * The sentinel also buys back an atomic upsert: SQLite/D1 treat NULLs as
 * DISTINCT inside a unique index, so `ON CONFLICT (tenant_id, key)` could never
 * dedupe the global row and the write path had to keep a select-then-write race
 * for it alone. `'_global'` is an ordinary value, so it conflicts like any other.
 */
export const GLOBAL_SETTINGS_TENANT_ID = "_global";

/**
 * Keys whose value was served from the pre-sentinel `tenant_id IS NULL` row in
 * this isolate, one entry per key. Read by `legacyGlobalSettingsKeysSeen()`.
 *
 * A compatibility shim nobody can tell is unused is a shim that never gets
 * removed, so the fallback reports itself instead of being silently load-
 * bearing forever.
 */
const legacyGlobalKeysSeen = new Set<string>();

/**
 * Note (and log, once per key per isolate) that the deprecated global row
 * answered a read. Once per key rather than once per request because this sits
 * on the sign-in path: a per-request line would be a log flood on the busiest
 * endpoint the instance has, and the operator only needs to learn the fact once
 * per key per isolate to act on it.
 */
const noteLegacyGlobalRow = (key: string): void => {
  if (legacyGlobalKeysSeen.has(key)) return;
  legacyGlobalKeysSeen.add(key);
  console.warn(
    `[settings] compat: app_settings.${key} was read from the deprecated ` +
      `tenant_id IS NULL row — no '${GLOBAL_SETTINGS_TENANT_ID}' row exists for it. ` +
      `Re-save the setting (or re-run the migration) so this fallback can be deleted.`,
  );
};

/** Which keys this isolate has served from the deprecated `tenant_id IS NULL`
 *  row. Empty means nothing depends on the fallback here and it is safe to
 *  delete — which is the whole point of keeping the record. */
export const legacyGlobalSettingsKeysSeen = (): string[] =>
  [...legacyGlobalKeysSeen].sort();

/** Forget what the fallback has seen. Test-only: the record is per-isolate and
 *  a spec that shares a process with others needs a clean slate. */
export const resetLegacyGlobalSettingsLog = (): void => legacyGlobalKeysSeen.clear();

/**
 * Read the instance-global tier: the `'_global'` row, falling back per key to
 * the pre-sentinel `tenant_id IS NULL` row for one release.
 *
 * Both tiers come back in ONE query — the fallback is a read of rows we were
 * fetching anyway, so keeping it costs nothing until it is deleted. A key
 * present in both is answered by the sentinel row: the migration writes that
 * one, so it is the newer of the two by construction.
 *
 * The fallback is narrowed to {@link GLOBAL_TIER_KEYS}, and that narrowing is
 * what keeps its report worth reading. `PUT /api/account/list-columns` still
 * parks a per-user `listColumns:<userId>` row on a NULL `tenant_id` for a user
 * with no active workspace — those rows are not the settings tier, nothing here
 * ever reads them, and left unfiltered they would make every isolate announce a
 * legacy dependency that does not exist. A warning that always fires is a
 * warning nobody acts on.
 */
const readGlobalRows = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): Promise<Map<string, unknown>> => {
  const t = tableFor(dialect);
  const rows = (await (db as any)
    .select()
    .from(t)
    .where(or(eq(t.tenantId, GLOBAL_SETTINGS_TENANT_ID), isNull(t.tenantId)))) as {
    tenantId: string | null;
    key: string;
    value: unknown;
  }[];
  const out = new Map<string, unknown>();
  const legacy = new Map<string, unknown>();
  for (const r of rows) {
    if (r.tenantId === GLOBAL_SETTINGS_TENANT_ID) out.set(r.key, r.value);
    else legacy.set(r.key, r.value);
  }
  for (const [key, value] of legacy) {
    if (out.has(key) || !GLOBAL_TIER_KEYS.has(key)) continue;
    out.set(key, value);
    noteLegacyGlobalRow(key);
  }
  return out;
};

/** Read one settings tier as a key → value map. `null` (no active workspace)
 *  and the sentinel both mean the instance-global tier. */
const readSettingsRows = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<Map<string, unknown>> => {
  if (tenantId === null || tenantId === GLOBAL_SETTINGS_TENANT_ID)
    return readGlobalRows(db, dialect);
  const t = tableFor(dialect);
  const rows = (await (db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as { key: string; value: unknown }[];
  return new Map(rows.map((r) => [r.key, r.value]));
};

const isCurrencyCode = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z]{3}$/.test(v);

export const loadAppSettings = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<AppSettings> => {
  try {
    const rows = await readSettingsRows(db, dialect, tenantId);
    const out: AppSettings = { ...APP_SETTINGS_DEFAULTS };
    for (const [key, value] of rows) {
      if (key === "i18nLocales" && isStringArray(value) && value.length > 0)
        out.i18nLocales = value;
      else if (key === "i18nDefaultLocale" && typeof value === "string")
        out.i18nDefaultLocale = value;
      else if (key === "timezone" && isValidTimeZone(value)) out.timezone = value;
      // Upper-cased on the way out so a workspace that stored `try` and one
      // that stored `TRY` hand the money editor the same code.
      else if (key === "defaultCurrency" && isCurrencyCode(value))
        out.defaultCurrency = value.toUpperCase();
      else if (key === "erdLayout" && isErdLayout(value)) out.erdLayout = value;
      else if (key === "listColumns" && isListColumns(value)) out.listColumns = value;
      else if (key === "collectionGroups" && isStringArray(value))
        out.collectionGroups = value;
      else if (
        key === "schemaSnapshotSchedule" &&
        (value === "off" || value === "daily" || value === "weekly")
      )
        out.schemaSnapshotSchedule = value;
      else if (
        key === "schemaSnapshotKeepLast" &&
        typeof value === "number" &&
        Number.isFinite(value)
      )
        out.schemaSnapshotKeepLast = Math.min(50, Math.max(1, Math.floor(value)));
      else if (key === "usageLimits") out.usageLimits = parseUsageLimits(value);
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
 * `app_settings` rows whose `tenant_id` is {@link GLOBAL_SETTINGS_TENANT_ID}.
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
 * Instance-global (the {@link GLOBAL_SETTINGS_TENANT_ID} row), for the same
 * reason the sign-in branding is: the admin sign-in page is reached before any
 * workspace is selected, so there is no tenant to scope the answer to.
 */
export type PasswordLoginMode = "enabled" | "app-only" | "disabled";

export const PASSWORD_LOGIN_DEFAULT: PasswordLoginMode = "enabled";

export const isPasswordLoginMode = (v: unknown): v is PasswordLoginMode =>
  v === "enabled" || v === "app-only" || v === "disabled";

/** Read the instance-global password-login mode (always the global tier). Any
 *  read failure resolves to `enabled` — a settings table that cannot be read
 *  must not lock every admin out of their own instance. */
export const loadPasswordLoginMode = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): Promise<PasswordLoginMode> => {
  try {
    const value = (await readGlobalRows(db, dialect)).get("passwordLogin");
    return isPasswordLoginMode(value) ? value : PASSWORD_LOGIN_DEFAULT;
  } catch {
    return PASSWORD_LOGIN_DEFAULT;
  }
};

/** Keys persisted by {@link SignInBranding} plus the password-login mode. The
 *  settings route consults this to route these keys to the global
 *  ({@link GLOBAL_SETTINGS_TENANT_ID}) row on write. */
export const SIGN_IN_BRANDING_KEYS = [
  "signInHeadline",
  "signInTagline",
  "termsUrl",
  "privacyUrl",
  "passwordLogin",
] as const;

/**
 * Every key the instance-global tier legitimately holds: the branding keys plus
 * the workspace-shaped keys a caller with no active workspace falls back to.
 * `readGlobalRows` consults it to decide which pre-sentinel `tenant_id IS NULL`
 * rows are settings at all — see the note there on the per-user `listColumns:…`
 * rows that share the NULL tier without belonging to it.
 *
 * Declared here rather than beside `readGlobalRows` because it is built FROM
 * `SIGN_IN_BRANDING_KEYS`, and a module-level const cannot be read before the
 * const it is built from exists. Only ever consulted at request time, so the
 * order is safe.
 */
const GLOBAL_TIER_KEYS: ReadonlySet<string> = new Set<string>([
  ...SIGN_IN_BRANDING_KEYS,
  ...Object.keys(APP_SETTINGS_DEFAULTS),
]);

/** Read the instance-global login-screen branding (always the global tier,
 *  regardless of any active workspace). */
export const loadSignInBranding = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): Promise<SignInBranding> => {
  const out: SignInBranding = { ...SIGN_IN_BRANDING_DEFAULTS };
  try {
    const rows = await readGlobalRows(db, dialect);
    for (const [key, value] of rows) {
      if (key === "signInHeadline" && typeof value === "string")
        out.signInHeadline = value;
      else if (key === "signInTagline" && typeof value === "string")
        out.signInTagline = value;
      else if (key === "termsUrl" && typeof value === "string") out.termsUrl = value;
      else if (key === "privacyUrl" && typeof value === "string")
        out.privacyUrl = value;
    }
  } catch {
    // Pre-migration deploy (table missing) — fall back to empty defaults.
  }
  return out;
};
