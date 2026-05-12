import { eq, isNull, or } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import { loadAppSettings } from "./settings";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.i18nStrings : sqlite.schema.i18nStrings;

interface I18nRow {
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
}

/**
 * Load all i18n strings visible to the given tenant: tenant-scoped rows take
 * precedence over global (tenantId=NULL) rows for the same (key, locale).
 */
const loadRows = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<I18nRow[]> => {
  const t = tableFor(dialect);
  try {
    const rows = (await (db as any)
      .select()
      .from(t)
      .where(
        tenantId ? or(eq(t.tenantId, tenantId), isNull(t.tenantId)) : isNull(t.tenantId),
      )) as I18nRow[];
    return rows;
  } catch {
    return [];
  }
};

/**
 * Resolve a single locale's strings, applying fallback chain:
 *   <requested> → <default> → key (literal).
 *
 * Tenant rows shadow global rows. Returns a flat key→value map suitable for
 * client-side i18n libraries.
 */
export const resolveLocaleStrings = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
  locale: string,
): Promise<{
  locale: string;
  defaultLocale: string;
  available: string[];
  strings: Record<string, string>;
}> => {
  const settings = await loadAppSettings(db, dialect, tenantId);
  const rows = await loadRows(db, dialect, tenantId);

  // Index: key → locale → { value, tenantSpecific }
  const idx = new Map<string, Map<string, { value: string; tenant: boolean }>>();
  for (const r of rows) {
    let perKey = idx.get(r.key);
    if (!perKey) {
      perKey = new Map();
      idx.set(r.key, perKey);
    }
    const existing = perKey.get(r.locale);
    const tenant = r.tenantId !== null;
    if (!existing || (tenant && !existing.tenant)) {
      perKey.set(r.locale, { value: r.value, tenant });
    }
  }

  const out: Record<string, string> = {};
  const fallback = settings.i18nDefaultLocale;
  for (const [key, perLocale] of idx) {
    const v = perLocale.get(locale)?.value;
    if (v !== undefined) {
      out[key] = v;
      continue;
    }
    if (locale !== fallback) {
      const fv = perLocale.get(fallback)?.value;
      if (fv !== undefined) {
        out[key] = fv;
        continue;
      }
    }
    out[key] = key;
  }

  return {
    locale,
    defaultLocale: settings.i18nDefaultLocale,
    available: settings.i18nLocales,
    strings: out,
  };
};

/**
 * Load all locales as a key×locale matrix; used by the admin UI.
 */
export const loadMatrix = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<{
  data: Record<string, Record<string, string>>;
  locales: string[];
  configuredLocales: string[];
  defaultLocale: string;
}> => {
  const settings = await loadAppSettings(db, dialect, tenantId);
  const rows = await loadRows(db, dialect, tenantId);

  // Tenant rows shadow global rows for the same (key, locale).
  const tenantSeen = new Set<string>();
  const out: Record<string, Record<string, string>> = {};
  const localesSeen = new Set<string>(settings.i18nLocales);

  for (const r of rows) {
    if (r.tenantId !== null) tenantSeen.add(`${r.key}::${r.locale}`);
  }
  for (const r of rows) {
    if (r.tenantId === null && tenantSeen.has(`${r.key}::${r.locale}`)) continue;
    localesSeen.add(r.locale);
    if (!out[r.key]) out[r.key] = {};
    out[r.key]![r.locale] = r.value;
  }

  return {
    data: out,
    locales: [...localesSeen].sort(),
    configuredLocales: settings.i18nLocales,
    defaultLocale: settings.i18nDefaultLocale,
  };
};
