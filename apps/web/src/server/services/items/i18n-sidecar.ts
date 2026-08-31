import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { type FieldDef, i18nTableName, isLocalized, validateValue } from "@backlex/db";
import type { Ctx } from "../../context";
import { deserialize, serialize } from "./serialize";
import { queryAll } from "./sql-helpers";

/** Alias for the requested-locale sidecar join (single-locale read). */
export const I18N_REQ_ALIAS = "i18n_req";
/** Alias for the workspace-default-locale fallback join (single-locale read). */
export const I18N_DEF_ALIAS = "i18n_def";

/**
 * Write-side helpers for `localized` fields (the `<table>__i18n` translations
 * sidecar). These functions only ever touch fields for which `isLocalized(f)`
 * is true.
 *
 * Disambiguation rule (mirrors the REST `?locale=` contract): when a concrete
 * write locale is set, a localized field's value is ALWAYS the native value for
 * that locale (never an object-of-locales) — this keeps localizing a `json` /
 * `relation_many` field, whose native value is itself an object/array,
 * unambiguous. The object-of-locales shape `{en: …, tr: …}` is only accepted
 * when no write locale (or `*`) is set.
 */

export interface LocaleSplit {
  /** Localized values written with no locale stated. Empty on a `?locale=`
   *  write and on one that states `{locale: value}` maps. */
  bare: Record<string, unknown>;
  /** locale → { fieldName → native value }. A `null` value clears that column
   *  for that locale. */
  localePatches: Map<string, Record<string, unknown>>;
  /** Fields to clear across ALL locales (a `null` value sent without a concrete
   *  `?locale=`). */
  clearAll: Set<string>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Remove every `localized` field from `patch` (mutating it, like
 * `mergeI18nPatch`) and bucket the removed values by locale. After this call the
 * base INSERT/UPDATE loops never see localized fields (they have no base column).
 */
export const splitLocalized = (
  patch: Record<string, unknown>,
  fields: FieldDef[],
  writeLocale: string | null,
): LocaleSplit => {
  const localePatches = new Map<string, Record<string, unknown>>();
  const clearAll = new Set<string>();
  /** Values sent without a locale — the caller files them under the workspace
   *  default once it has resolved it. */
  const bare: Record<string, unknown> = {};
  const put = (loc: string, name: string, val: unknown): void => {
    let m = localePatches.get(loc);
    if (!m) {
      m = {};
      localePatches.set(loc, m);
    }
    m[name] = val;
  };
  for (const f of fields) {
    if (!isLocalized(f)) continue;
    if (!(f.name in patch)) continue;
    const v = patch[f.name];
    delete patch[f.name];
    if (writeLocale && writeLocale !== "*") {
      // Concrete locale → the value is the native value for that locale
      // (null clears that locale's column).
      put(writeLocale, f.name, v);
      continue;
    }
    if (v === null) {
      clearAll.add(f.name);
      continue;
    }
    if (isPlainObject(v)) {
      for (const [loc, val] of Object.entries(v)) put(loc, f.name, val);
      continue;
    }
    // A bare value on a locale-less write is the workspace's default language.
    //
    // This used to be a 422 saying "send {locale: value} or set ?locale=xx",
    // and the strictness was defensible in isolation: it stops a Turkish title
    // being filed under `en` because nobody said. But it made localizing an
    // EXISTING column a breaking change for every writer — `products.create({
    // name })` is the first line of both examples, every doc snippet and the
    // SDK's own quickstart — so no field already in use could ever adopt it,
    // which is most of them.
    //
    // Resolved lazily by the caller (`bare` is only inspected when non-empty)
    // so the settings read costs nothing on a write that states its locale.
    // Nothing else in the stack is stricter than this: reads fall back to the
    // default locale, the slug fold takes it, and a bare template sample means
    // it too.
    bare[f.name] = v;
  }
  return { localePatches, clearAll, bare };
};

/** Whether the split carries any sidecar work. */
export const splitIsEmpty = (split: LocaleSplit): boolean =>
  split.localePatches.size === 0 && split.clearAll.size === 0;

/** Run each provided per-locale value through its field's soft validation
 *  (min/max/length/format). Per-locale `required` is intentionally NOT enforced
 *  in v1 (a partial single-locale write must not trip a "missing" error). */
export const validateLocalePatches = (split: LocaleSplit, fields: FieldDef[]): void => {
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const [, fieldMap] of split.localePatches) {
    for (const [name, val] of Object.entries(fieldMap)) {
      const f = byName.get(name);
      if (!f) continue;
      try {
        validateValue(f, val);
      } catch (e) {
        throw new AppError("VALIDATION", (e as Error).message);
      }
    }
  }
};

const colValSql = (
  rowId: string,
  locale: string,
  fieldMap: Record<string, unknown>,
  byName: Map<string, FieldDef>,
  dialect: "pg" | "sqlite",
): { cols: string[]; colSql: SQL; valSql: SQL } => {
  const names = Object.keys(fieldMap);
  const cols = ["row_id", "locale", ...names];
  const vals: unknown[] = [
    rowId,
    locale,
    ...names.map((n) => serialize(fieldMap[n], byName.get(n)!.type, dialect)),
  ];
  return {
    cols,
    colSql: sql.join(
      cols.map((n) => sql.identifier(n)),
      sql`, `,
    ),
    valSql: sql.join(
      vals.map((v) => sql`${v}`),
      sql`, `,
    ),
  };
};

/** Plain INSERT of one locale row — used on create (no existing rows to merge). */
export const sidecarInsert = (
  table: string,
  rowId: string,
  locale: string,
  fieldMap: Record<string, unknown>,
  byName: Map<string, FieldDef>,
  dialect: "pg" | "sqlite",
): SQL => {
  const { colSql, valSql } = colValSql(rowId, locale, fieldMap, byName, dialect);
  return sql`INSERT INTO ${sql.identifier(i18nTableName(table))} (${colSql}) VALUES (${valSql})`;
};

/**
 * UPSERT one locale row, setting ONLY the provided columns so other fields on
 * that locale row — and every other locale — are preserved. Both dialects accept
 * the `excluded.` alias in the conflict target.
 */
export const sidecarUpsert = (
  table: string,
  rowId: string,
  locale: string,
  fieldMap: Record<string, unknown>,
  byName: Map<string, FieldDef>,
  dialect: "pg" | "sqlite",
): SQL => {
  const { cols, colSql, valSql } = colValSql(rowId, locale, fieldMap, byName, dialect);
  const setCols = cols.filter((c) => c !== "row_id" && c !== "locale");
  const setSql = sql.join(
    setCols.map((n) => sql`${sql.identifier(n)} = excluded.${sql.identifier(n)}`),
    sql`, `,
  );
  return sql`INSERT INTO ${sql.identifier(i18nTableName(table))} (${colSql}) VALUES (${valSql})
    ON CONFLICT (${sql.identifier("row_id")}, ${sql.identifier("locale")}) DO UPDATE SET ${setSql}`;
};

/** NULL out one field across every locale row for a base row (a locale-less
 *  `null` write). */
export const sidecarClear = (table: string, rowId: string, fieldName: string): SQL =>
  sql`UPDATE ${sql.identifier(i18nTableName(table))} SET ${sql.identifier(fieldName)} = NULL WHERE ${sql.identifier("row_id")} = ${rowId}`;

/** Delete every locale row for a base row (hard delete; SQLite/D1 have no FK
 *  cascade so this is the cross-dialect contract). */
export const sidecarDeleteRow = (table: string, rowId: string): SQL =>
  sql`DELETE FROM ${sql.identifier(i18nTableName(table))} WHERE ${sql.identifier("row_id")} = ${rowId}`;

/**
 * Build the localized fields' echo for the write response / realtime event —
 * either the single native value (concrete `?locale=`) or the full
 * `{locale: value}` map (locale-less / `*` write). Only reflects fields this
 * write touched; untouched localized fields are absent (a subsequent GET returns
 * them via the read path).
 */
export const echoLocalized = (
  split: LocaleSplit,
  writeLocale: string | null,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (writeLocale && writeLocale !== "*") {
    const m = split.localePatches.get(writeLocale);
    if (m) for (const [name, val] of Object.entries(m)) out[name] = val;
    return out;
  }
  for (const [loc, fieldMap] of split.localePatches) {
    for (const [name, val] of Object.entries(fieldMap)) {
      // A field sent as a bare value is echoed as one. Filing it under the
      // default locale is a storage decision; answering `{en: "Widget"}` to a
      // caller who wrote `"Widget"` would move the break rather than remove it
      // — the response is what an optimistic client reconciles from.
      if (name in split.bare) {
        out[name] = split.bare[name];
        continue;
      }
      const cur = (out[name] as Record<string, unknown> | undefined) ?? {};
      cur[loc] = val;
      out[name] = cur;
    }
  }
  return out;
};

/**
 * One scalar per localized field, for the consumers that need a single value
 * rather than a per-locale map.
 *
 * Slug derivation is the caller that forced this. A slug column is `unique`, so
 * it cannot itself be localized — there is one handle per row whatever language
 * the title is read in — and `resolveSlug` reads its `from` sources off the
 * payload, which `splitLocalized` has already emptied. The result was a silent
 * `null`: creating a product whose `name` was localized produced a row with no
 * URL handle at all, with a 201 and no warning.
 *
 * `order` is tried in turn — the write's own `?locale=`, then the workspace
 * default — and anything still unresolved falls back to the lowest-sorted
 * locale that has a value. Sorted rather than first-seen so two identical
 * writes cannot fold to two different slugs depending on key order.
 */
export const pickLocalizedValues = (
  byLocale: Iterable<[string, Record<string, unknown>]>,
  order: Array<string | null | undefined>,
): Record<string, unknown> => {
  const locales = [...byLocale];
  const preferred = order.filter((l): l is string => Boolean(l) && l !== "*");
  const out: Record<string, unknown> = {};
  const names = new Set<string>();
  for (const [, fields] of locales) for (const n of Object.keys(fields)) names.add(n);
  const has = (v: unknown): boolean => v !== null && v !== undefined && v !== "";
  for (const name of names) {
    let picked: unknown;
    for (const loc of preferred) {
      const v = locales.find(([l]) => l === loc)?.[1][name];
      if (has(v)) {
        picked = v;
        break;
      }
    }
    if (picked === undefined) {
      for (const [, fields] of [...locales].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (has(fields[name])) {
          picked = fields[name];
          break;
        }
      }
    }
    if (picked !== undefined) out[name] = picked;
  }
  return out;
};

/** Sidecar rows (`{locale, …fields}`) in the shape {@link pickLocalizedValues}
 *  reads — used when the source of a slug was not part of this write. */
export const sidecarByLocale = (
  rows: Array<Record<string, unknown>>,
  defs: FieldDef[],
): Array<[string, Record<string, unknown>]> =>
  rows.map((r) => {
    const fields: Record<string, unknown> = {};
    for (const f of defs) if (f.name in r) fields[f.name] = r[f.name];
    return [String(r.locale), fields] as [string, Record<string, unknown>];
  });

// ── Read side ───────────────────────────────────────────────────────────────

interface SidecarReadOpts {
  physicalTable: string;
  pkColumn: string;
  /** Requested read locale (`null`/`"*"` ⇒ full-map mode). */
  locale: string | null;
  /** Workspace default, for the single-locale fallback join. */
  defaultLocale: string | null;
}

/** Whether a concrete single locale was requested (vs the full-map default). */
export const isSingleLocale = (locale: string | null): boolean =>
  Boolean(locale) && locale !== "*";

/**
 * LEFT JOIN(s) that surface each localized field for a single requested locale,
 * plus the workspace-default fallback. Empty in full-map mode (that path uses a
 * correlated aggregate in the SELECT instead). Both joins hit the sidecar's
 * `(row_id, locale)` primary key, so they never multiply base rows — keyset
 * pagination and the existing relation joins stay correct.
 *
 * Takes `defs` for the same reason {@link buildLocalizedSelects} does, and it
 * is not an optimization: `applyCollection` creates `<table>__i18n` only when
 * `sidecarFields(fields)` is non-empty, so on a collection with nothing
 * localized the table does not exist. Gating only on "was a single locale
 * requested?" emitted a LEFT JOIN onto a missing table and the whole list
 * answered 500 — for `?locale=en`, a parameter a client sends without knowing
 * whether any field happens to be translated. The join exists exactly when
 * something selects from it.
 */
export const buildSidecarJoins = (defs: FieldDef[], opts: SidecarReadOpts): SQL[] => {
  if (defs.length === 0) return [];
  if (!isSingleLocale(opts.locale) || !opts.locale) return [];
  const sidecar = i18nTableName(opts.physicalTable);
  const base = sql.identifier(opts.physicalTable);
  const joinFor = (alias: string, loc: string): SQL =>
    sql`LEFT JOIN ${sql.identifier(sidecar)} ${sql.identifier(alias)} ON ${sql.identifier(alias)}.${sql.identifier("row_id")} = ${base}.${sql.identifier(opts.pkColumn)} AND ${sql.identifier(alias)}.${sql.identifier("locale")} = ${loc}`;
  const joins = [joinFor(I18N_REQ_ALIAS, opts.locale)];
  if (opts.defaultLocale && opts.defaultLocale !== opts.locale) {
    joins.push(joinFor(I18N_DEF_ALIAS, opts.defaultLocale));
  }
  return joins;
};

/**
 * SELECT-list expressions for the localized fields — appended to the base
 * SELECT (localized fields have no base column, so there is never a collision).
 *  - single-locale: `COALESCE(i18n_req.f, i18n_def.f) AS f` (fallback in SQL).
 *  - full-map: a correlated aggregate building `{locale: value}` per field
 *    (`jsonb_object_agg` on PG, `json_group_object` on SQLite — the latter wraps
 *    json/relation_many with `json()` so they nest instead of double-encoding).
 */
export const buildLocalizedSelects = (
  defs: FieldDef[],
  dialect: "pg" | "sqlite",
  opts: SidecarReadOpts,
): SQL[] => {
  if (defs.length === 0) return [];
  if (isSingleLocale(opts.locale)) {
    const useDefault = Boolean(opts.defaultLocale) && opts.defaultLocale !== opts.locale;
    return defs.map((f) => {
      const req = sql`${sql.identifier(I18N_REQ_ALIAS)}.${sql.identifier(f.name)}`;
      const expr = useDefault
        ? sql`COALESCE(${req}, ${sql.identifier(I18N_DEF_ALIAS)}.${sql.identifier(f.name)})`
        : req;
      return sql`${expr} AS ${sql.identifier(f.name)}`;
    });
  }
  const sidecar = i18nTableName(opts.physicalTable);
  const base = sql.identifier(opts.physicalTable);
  const t = sql.identifier("t");
  return defs.map((f) => {
    const col = sql`${t}.${sql.identifier(f.name)}`;
    const val =
      dialect === "sqlite" && (f.type === "json" || f.type === "relation_many")
        ? sql`json(${col})`
        : col;
    const agg =
      dialect === "pg"
        ? sql`jsonb_object_agg(${t}.${sql.identifier("locale")}, ${val})`
        : sql`json_group_object(${t}.${sql.identifier("locale")}, ${val})`;
    return sql`(SELECT ${agg} FROM ${sql.identifier(sidecar)} ${t} WHERE ${t}.${sql.identifier("row_id")} = ${base}.${sql.identifier(opts.pkColumn)}) AS ${sql.identifier(f.name)}`;
  });
};

/** Parse a full-map aggregate value into a `{locale: deserialized}` object. */
const deserializeLocaleMap = (
  v: unknown,
  type: FieldDef["type"],
  dialect: "pg" | "sqlite",
): Record<string, unknown> => {
  if (v === null || v === undefined) return {};
  let map: unknown = v;
  if (typeof v === "string") {
    // SQLite `json_group_object` returns a JSON string; PG jsonb comes parsed.
    try {
      map = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const out: Record<string, unknown> = {};
  for (const [loc, raw] of Object.entries(map as Record<string, unknown>)) {
    out[loc] = deserialize(raw, type, dialect);
  }
  return out;
};

/**
 * Fill the localized fields on an already-deserialized row from the raw
 * joined/aggregated SELECT values. Single-locale mode yields each field's native
 * value (fallback already resolved in SQL); full-map mode yields the
 * `{locale: value}` map. Skips fields absent from the raw row (i.e. not
 * projected) so `?fields=` is honoured. `deserializeRow` skips localized fields,
 * so this is the single place they are materialized on the read path.
 */
export const applySidecarLocalization = (
  out: Record<string, unknown>,
  raw: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  locale: string | null,
): void => {
  const single = isSingleLocale(locale);
  for (const f of fields) {
    if (!isLocalized(f) || f.private) continue;
    if (!(f.name in raw)) continue;
    out[f.name] = single
      ? deserialize(raw[f.name], f.type, dialect)
      : deserializeLocaleMap(raw[f.name], f.type, dialect);
  }
};

/**
 * Fetch every locale row for a single base row. Used by the single-item read
 * (which does a small second query instead of the list path's JOIN/aggregate).
 * Returns raw rows `{locale, <localized cols…>}`; empty when the collection has
 * no localized fields.
 */
export const loadSidecarForRow = async (
  ctx: Ctx,
  physicalTable: string,
  id: string,
  defs: FieldDef[],
): Promise<Array<Record<string, unknown>>> => {
  if (defs.length === 0) return [];
  const cols = defs.map((f) => sql.identifier(f.name));
  return queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier("locale")}, ${sql.join(cols, sql`, `)} FROM ${sql.identifier(i18nTableName(physicalTable))} WHERE ${sql.identifier("row_id")} = ${id}`,
  );
};

/**
 * Batch-load sidecar rows for many base ids in one query, grouped by `row_id`.
 * Used by the search hydration path (rows fetched by `IN (…)`).
 */
export const loadSidecarForRows = async (
  ctx: Ctx,
  physicalTable: string,
  ids: string[],
  defs: FieldDef[],
): Promise<Map<string, Array<Record<string, unknown>>>> => {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  if (defs.length === 0 || ids.length === 0) return grouped;
  const cols = defs.map((f) => sql.identifier(f.name));
  const idList = sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  );
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier("row_id")}, ${sql.identifier("locale")}, ${sql.join(cols, sql`, `)} FROM ${sql.identifier(i18nTableName(physicalTable))} WHERE ${sql.identifier("row_id")} IN (${idList})`,
  );
  for (const r of rows) {
    const rid = String(r.row_id);
    let arr = grouped.get(rid);
    if (!arr) {
      arr = [];
      grouped.set(rid, arr);
    }
    arr.push(r);
  }
  return grouped;
};

/**
 * Materialize localized fields on `out` from sidecar rows loaded in JS (the
 * single-read counterpart of {@link applySidecarLocalization}). Single-locale
 * mode resolves requested → default → null per field; full-map mode returns the
 * `{locale: value}` map. Apply BEFORE the perm-field projection so a localized
 * field the caller may not read is trimmed.
 */
export const applySidecarFromRows = (
  out: Record<string, unknown>,
  sidecarRows: Array<Record<string, unknown>>,
  defs: FieldDef[],
  dialect: "pg" | "sqlite",
  locale: string | null,
  defaultLocale: string | null,
): void => {
  const single = isSingleLocale(locale);
  const byLocale = new Map(sidecarRows.map((r) => [r.locale as string, r]));
  for (const f of defs) {
    if (f.private) continue;
    if (single) {
      const reqVal = byLocale.get(locale as string)?.[f.name];
      const defVal = defaultLocale ? byLocale.get(defaultLocale)?.[f.name] : undefined;
      out[f.name] = deserialize(reqVal ?? defVal ?? null, f.type, dialect);
    } else {
      const map: Record<string, unknown> = {};
      for (const r of sidecarRows) {
        map[r.locale as string] = deserialize(r[f.name], f.type, dialect);
      }
      out[f.name] = map;
    }
  }
};
