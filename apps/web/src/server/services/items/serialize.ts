import { type FieldDef, type FieldType, foldColumn, foldSearch, hasFoldColumn, isLocalized, parseGeoPoint } from "@backlex/db";
import { moneyValueOf, toStoredMoney } from "./money-fields";

export const serialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === undefined || value === null) return null;
  // A point is normalized to canonical `{ lat, lng }` on the way IN, on both
  // dialects, so the four accepted input shapes (GeoJSON pair, `latitude`/
  // `longitude`, a pasted "lat,lng" string) all land as one shape. Everything
  // downstream — the `_near` compiler's `$.lat`, the admin's map pin, the CSV
  // export — reads that one shape and nothing else. `validateValue` has already
  // rejected an unparseable value by the time a write reaches here; a read-path
  // caller (backup restore) that hands us junk keeps it rather than throwing.
  if (type === "geo") {
    let point: unknown = value;
    try {
      point = parseGeoPoint(value);
    } catch {
      return dialect === "sqlite" ? JSON.stringify(value) : value;
    }
    return dialect === "sqlite" ? JSON.stringify(point) : point;
  }
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many") {
      // relation_many is an array of foreign ids — store as JSON text on
      // SQLite so the same column pattern as `json` works (no native array).
      return JSON.stringify(value);
    }
    if (type === "boolean") return value ? 1 : 0;
    if (type === "timestamp") {
      // Accepts every shape the pg branch below does, which it did not used to.
      // `Number("2026-08-20T00:00:00Z")` is NaN, so an ISO string — the exact
      // form the READ path hands back — landed in the column as null and the
      // write still answered 201. The same request against Postgres stored it
      // correctly, so a timestamp round-trip silently lost data on SQLite/D1
      // alone.
      if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isNaN(ms) ? null : ms;
      }
      // A bare number, or a numeric string, is already epoch ms — `new Date`
      // would reject the string form.
      if (typeof value === "number") return Number.isNaN(value) ? null : value;
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        return Number(value);
      }
      const ms = new Date(value as string).getTime();
      return Number.isNaN(ms) ? null : ms;
    }
  } else {
    if (type === "timestamp") {
      // ISO strings round-trip through postgres-js's prepared-statement
      // binder cleanly. Date instances reach `byteLength` and throw
      // because the binder has no schema-side type info for our dynamic
      // tables (c_* and adopted both miss from Drizzle's type map).
      const d = value instanceof Date ? value : new Date(value as string | number);
      return d.toISOString();
    }
    if (type === "relation_many" && typeof value === "string") {
      // Be forgiving — caller might send already-stringified JSON.
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    if ((type === "json" || type === "relation_many") && Array.isArray(value)) {
      // Hand `jsonb` its own text form rather than the JS array.
      //
      // Drizzle has no column type for our dynamic tables (`c_*` and adopted
      // both miss from its type map), and for an unknown column it binds a JS
      // array as a SQL ROW CONSTRUCTOR — `VALUES (…, ($6, $7))` — which
      // Postgres rejects with "column is of type jsonb but expression is of
      // type record". Every array-valued json column hit this: a multi-select
      // answer, a `relation_many` edit, any tags list. SQLite never did (it
      // stringifies just above), so the whole class of failure was invisible
      // to a SQLite-only suite and broke on the dialect production runs.
      //
      // Objects are left alone: the driver serializes those correctly today,
      // and re-encoding them here would change a path that works.
      return JSON.stringify(value);
    }
  }
  return value;
};

/**
 * Read one column back into the value the API hands out.
 *
 * `money` is deliberately NOT handled here and must not be: its value is
 * `{ amount, currency }`, and the currency may live in a sibling column, so the
 * conversion is a function of the ROW rather than of this cell. Every read path
 * therefore goes through {@link deserializeField}, which has the row — see
 * `moneyValueOf`. A money column reaching this function alone comes back as the
 * raw integer it is stored as, which is the honest answer to a question asked
 * without enough information.
 */
/**
 * Write one value into the form its column holds, with the field available for
 * the types the type token alone does not describe.
 *
 * `money` is the only such type today: its canonical value is
 * `{ amount, currency }` and the column is an integer count of minor units, so
 * the conversion needs the currency the value carries and the exponent the
 * field pins. Every write surface goes through this rather than
 * {@link serialize} — including GraphQL, which builds its own INSERT and would
 * otherwise hand the driver a live object to bind.
 */
export const serializeField = (
  value: unknown,
  field: FieldDef,
  dialect: "pg" | "sqlite",
): unknown =>
  field.type === "money"
    ? toStoredMoney(value, field)
    : serialize(value, field.type, dialect);

/**
 * Every column one field writes, and what goes in each.
 *
 * A `text` field writes TWO: itself, and the folded companion the
 * case-insensitive filters compare against. Nothing else about a write path
 * changes — but a path that keeps calling {@link serializeField} directly will
 * write the column and leave the companion NULL, and a NULL companion does not
 * degrade a filter, it makes the row **invisible** to one.
 *
 * That is why this exists as one helper rather than two lines repeated at each
 * INSERT: the failure is silent, it is per-write-path, and this codebase has
 * already been bitten by exactly that shape — a sidecar value that three of the
 * four writers maintained.
 * `apps/web/tests/fold-write-paths.test.ts` walks every path and proves it.
 */
export const serializeColumns = (
  value: unknown,
  field: FieldDef,
  dialect: "pg" | "sqlite",
): Array<[string, unknown]> => {
  const stored = serializeField(value, field, dialect);
  if (!hasFoldColumn(field)) return [[field.name, stored]];
  return [
    [field.name, stored],
    [foldColumn(field.name), stored == null ? null : foldSearch(String(stored))],
  ];
};

export const deserialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  // A hashed secret never leaves the DB through the API — the digest reads
  // back as null on every surface (list / get / changefeed / CSV / GraphQL).
  // Raw backups bypass this (they SELECT * without deserializing), so restore
  // still round-trips the digest.
  if (type === "hash") return null;
  if (value === null || value === undefined) return value;
  // Stored as TEXT on SQLite, `jsonb` on PG — same as `json`. Parsed leniently
  // because an ADOPTED column can hold anything: a row the platform never wrote
  // reads back as whatever it is rather than taking the whole page down with a
  // JSON.parse throw. `_near` already excludes such a row from proximity
  // results (see the `json_valid` guard in the compiler).
  if (type === "geo") {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many") {
      return typeof value === "string" ? JSON.parse(value) : value;
    }
    if (type === "boolean") return Boolean(value);
    if (type === "timestamp") return new Date(value as number).toISOString();
  }
  return value;
};

/**
 * Read one column back, with the row available for the field types whose value
 * is not a function of the cell alone.
 *
 * Today that is `money` and only `money` — its currency may be in a sibling
 * column, and reading it without one produces an amount that does not say what
 * it is. Every read surface (REST rows, GraphQL rows, `expand`ed relations, the
 * sandbox bridge) calls this rather than {@link deserialize} so a new such type
 * lands on all of them at once, which is the failure this repo keeps paying for
 * on the write side.
 */
export const deserializeField = (
  value: unknown,
  field: FieldDef,
  dialect: "pg" | "sqlite",
  row: Record<string, unknown>,
  fields: FieldDef[],
): unknown =>
  field.type === "money"
    ? moneyValueOf(value, field, fields, row)
    : deserialize(value, field.type, dialect);

export const projectFields = (
  out: Record<string, unknown>,
  allowed: Set<string> | null,
): Record<string, unknown> => {
  if (!allowed) return out;
  const sysKeep = new Set(["id", "createdAt", "updatedAt", "ownerId"]);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (sysKeep.has(k) || allowed.has(k)) filtered[k] = v;
  }
  return filtered;
};

export const deserializeRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  ownerScoped: boolean,
  projection: string[] | null = null,
  collection?: { pkColumn: string; hasCreatedAt: boolean; hasUpdatedAt: boolean },
): Record<string, unknown> => {
  const pk = collection?.pkColumn ?? "id";
  const hasCreatedAt = collection?.hasCreatedAt ?? true;
  const hasUpdatedAt = collection?.hasUpdatedAt ?? true;
  const includeAll = !projection;
  const sel = new Set(projection ?? []);
  const out: Record<string, unknown> = {};
  if (includeAll || sel.has("id") || sel.has(pk)) out.id = row[pk] ?? row.id;
  if (hasCreatedAt && (includeAll || sel.has("created_at")))
    out.createdAt = deserialize(row.created_at, "timestamp", dialect);
  if (hasUpdatedAt && (includeAll || sel.has("updated_at")))
    out.updatedAt = deserialize(row.updated_at, "timestamp", dialect);
  if ((includeAll && ownerScoped) || sel.has("owner_id"))
    out.ownerId = row.owner_id ?? null;
  // Versioned-collection system columns — exposed only when present.
  if (row._status !== undefined) {
    out._status = row._status;
    const publishedAt =
      row._published_at != null ? deserialize(row._published_at, "timestamp", dialect) : null;
    out._publishedAt = publishedAt; // public/SDK contract (camelCase)
    // Snake-case mirrors for the admin SPA, which reads `_status` / `_publish_at`
    // / `_unpublish_at` / `_published_at` directly (Scheduled / Expires badges,
    // the "edited since publish" indicator, the Kanban lifecycle board).
    out._published_at = publishedAt;
    out._publish_at =
      row._publish_at != null ? deserialize(row._publish_at, "timestamp", dialect) : null;
    out._unpublish_at =
      row._unpublish_at != null ? deserialize(row._unpublish_at, "timestamp", dialect) : null;
  }
  for (const f of fields) {
    // Private / internal columns never leave through an API read surface.
    if (f.private) continue;
    // `localized` fields live in the `<table>__i18n` sidecar, not on the base
    // row — they're materialized separately by `applySidecarLocalization` on the
    // read paths that JOIN/aggregate the sidecar. Skipping them here keeps the
    // full-map/native-value shaping in one place and avoids mis-deserializing a
    // per-locale aggregate as a single value.
    if (isLocalized(f)) continue;
    if (includeAll || sel.has(f.name)) {
      out[f.name] = deserializeField(row[f.name], f, dialect, row, fields);
    }
  }
  return out;
};
