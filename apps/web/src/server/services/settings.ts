import { eq, isNull } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";

/**
 * Runtime-mutable instance settings, backed by the `app_settings` key/value
 * table. Distinct from `Env` (deploy-time config — wrangler vars/secrets,
 * `.env`): these are the few knobs admins can flip from the UI without a
 * redeploy. Keep this list small and the keys whitelisted in
 * `routes/settings.ts`.
 */
export interface AppSettings {
  siteName: string;
  /** When false, account creation is rejected (any sign-up path). The very
   *  first user is always allowed so a fresh instance can bootstrap. */
  openSignup: boolean;
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  siteName: "workeros",
  openSignup: true,
};

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
      if (r.key === "siteName" && typeof r.value === "string") out.siteName = r.value;
      else if (r.key === "openSignup" && typeof r.value === "boolean")
        out.openSignup = r.value;
    }
    return out;
  } catch {
    // Pre-migration deploy (table missing) or transient error — fall back to
    // permissive defaults rather than blocking auth.
    return { ...APP_SETTINGS_DEFAULTS };
  }
};
