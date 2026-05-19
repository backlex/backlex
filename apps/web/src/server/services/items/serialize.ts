import type { FieldDef, FieldType } from "@workeros/db";

export const serialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === undefined || value === null) return null;
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many" || type === "i18n_text") {
      // relation_many is an array of foreign ids — store as JSON text on
      // SQLite so the same column pattern as `json` works (no native array).
      // i18n_text is a `{locale: value}` map — same story.
      return JSON.stringify(value);
    }
    if (type === "boolean") return value ? 1 : 0;
    if (type === "timestamp") {
      return value instanceof Date ? value.getTime() : Number(value);
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
  }
  return value;
};

export const deserialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === null || value === undefined) return value;
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many" || type === "i18n_text") {
      return typeof value === "string" ? JSON.parse(value) : value;
    }
    if (type === "boolean") return Boolean(value);
    if (type === "timestamp") return new Date(value as number).toISOString();
  }
  return value;
};

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
    out._publishedAt =
      row._published_at != null
        ? deserialize(row._published_at, "timestamp", dialect)
        : null;
  }
  for (const f of fields) {
    if (includeAll || sel.has(f.name)) {
      out[f.name] = deserialize(row[f.name], f.type, dialect);
    }
  }
  return out;
};
