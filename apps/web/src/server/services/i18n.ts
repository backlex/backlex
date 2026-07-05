import { and, eq, isNull, or } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
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

// ── Shared surface helpers ───────────────────────────────────────────────────
// REST (routes/i18n.ts) and GraphQL (services/graphql/i18n.ts) both call
// these so the upsert-by-(key,locale) and tenant-vs-global scoping rules live
// in one place.

export interface I18nStringRow {
  id: string;
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
}

/** Rows for the workspace plus global fallback rows (row form; the admin UI
 *  pivots them into a key×locale table). */
export const listI18nStrings = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
): Promise<I18nStringRow[]> => {
  const t = tableFor(dialect);
  return (await (db as any)
    .select()
    .from(t)
    .where(or(eq(t.tenantId, tenantId ?? ""), isNull(t.tenantId)))) as I18nStringRow[];
};

/** Upsert one (key, locale) string. `created` distinguishes insert vs update
 *  so REST can keep its 201/200 split. */
export const upsertI18nString = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
  input: { key: string; locale: string; value: string },
): Promise<{ id: string; created: boolean }> => {
  const t = tableFor(dialect);
  const existing = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.key, input.key),
        eq(t.locale, input.locale),
        tenantId ? eq(t.tenantId, tenantId) : isNull(t.tenantId),
      ),
    )
    .limit(1)) as { id: string }[];
  if (existing[0]) {
    await (db as any)
      .update(t)
      .set({
        value: input.value,
        updatedAt: dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.id, existing[0].id));
    return { id: existing[0].id, created: false };
  }
  const id = crypto.randomUUID();
  await (db as any).insert(t).values({
    id,
    tenantId: tenantId ?? null,
    key: input.key,
    locale: input.locale,
    value: input.value,
  });
  return { id, created: true };
};

export const bulkUpsertI18nStrings = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string | null,
  rows: { key: string; locale: string; value: string }[],
): Promise<number> => {
  let upserts = 0;
  for (const row of rows) {
    await upsertI18nString(db, dialect, tenantId, row);
    upserts += 1;
  }
  return upserts;
};

/** Delete one row — scoped to the workspace's own rows or global rows,
 *  mirroring the REST semantics. */
export const deleteI18nString = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = tableFor(dialect);
  await (db as any)
    .delete(t)
    .where(and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId))));
};
