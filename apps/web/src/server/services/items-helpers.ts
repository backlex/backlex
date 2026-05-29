import { sql, and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import { validateValue, type FieldDef, type FieldType } from "@backlex/db";
import type { Ctx } from "../context";

/**
 * Slim shared helpers for dynamic-collection rows. The HTTP routes in
 * routes/items.ts have a fuller version that also handles permission
 * filters, projections, locales, revisions, and audit logs — those stay
 * scoped to the user-facing API. Flow operations bypass all of that and
 * only need the core insert/update path (admin-trust execution).
 *
 * Keep the serialize/validate semantics in lockstep with routes/items.ts.
 * If you change one, change both.
 */

export interface CollectionRow {
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean;
  tenantScoped: boolean;
}

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export const loadCollection = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  slug: string,
): Promise<CollectionRow> => {
  if (!tenantId) {
    throw new AppError(
      "UNAUTHORIZED",
      "Active tenant required to access collections",
    );
  }
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  const r = rows[0] as Record<string, unknown>;
  return {
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    fields: r.fields as FieldDef[],
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
    tenantScoped:
      r.tenantScoped ?? r.tenant_scoped ?? true ? true : false,
  };
};

export const serialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === undefined || value === null) return null;
  if (dialect === "sqlite") {
    if (type === "json" || type === "relation_many") return JSON.stringify(value);
    if (type === "boolean") return value ? 1 : 0;
    if (type === "timestamp")
      return value instanceof Date ? value.getTime() : Number(value);
  } else {
    if (type === "timestamp" && !(value instanceof Date))
      return new Date(value as string | number);
    if (type === "relation_many" && typeof value === "string") {
      try { return JSON.parse(value); } catch { return value; }
    }
  }
  return value;
};

export const validateRow = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  partial: boolean,
): void => {
  for (const f of fields) {
    if (f.computed) continue;
    if (
      f.required &&
      !partial &&
      (data[f.name] === undefined || data[f.name] === null)
    ) {
      throw new AppError("VALIDATION", `Field "${f.name}" is required`);
    }
  }
  for (const k of Object.keys(data)) {
    const def = fields.find((f) => f.name === k);
    if (!def) throw new AppError("VALIDATION", `Unknown field "${k}"`);
    if (def.computed)
      throw new AppError(
        "VALIDATION",
        `Field "${k}" is computed (read-only) — drop it from your payload`,
      );
    try {
      validateValue(def, data[k]);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
  }
};

export const nowFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? new Date() : Date.now();

export const execute = async (ctx: Ctx, query: unknown): Promise<unknown> => {
  if (ctx.dialect === "pg") return (ctx.db as any).execute(query);
  return (ctx.db as any).run(query);
};

/* ─────────────────────────── flow-facing API ─────────────────────────── */

export interface CreateItemInput {
  slug: string;
  tenantId: string;
  ownerId?: string | null;
  data: Record<string, unknown>;
}

export interface UpdateItemInput {
  slug: string;
  tenantId: string;
  id: string;
  data: Record<string, unknown>;
}

/** Insert a row into a dynamic collection. Bypasses permission checks
 *  (flows are admin-authored). Returns the new id; the caller can publish
 *  events if needed. */
export const createItem = async (
  ctx: Ctx,
  input: CreateItemInput,
): Promise<{ id: string; row: Record<string, unknown> }> => {
  const collection = await loadCollection(ctx, input.tenantId, input.slug);
  validateRow(input.data, collection.fields, false);

  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  const cols: string[] = ["id", "created_at", "updated_at"];
  const vals: unknown[] = [id, now, now];

  if (collection.ownerScoped) {
    cols.push("owner_id");
    vals.push(input.ownerId ?? null);
  }
  if (collection.tenantScoped) {
    cols.push("tenant_id");
    vals.push(input.tenantId);
  }
  for (const f of collection.fields) {
    if (input.data[f.name] === undefined) continue;
    cols.push(f.name);
    vals.push(serialize(input.data[f.name], f.type, ctx.dialect));
  }

  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await execute(
    ctx,
    sql`INSERT INTO ${sql.identifier(collection.physicalTable)} (${colSql}) VALUES (${valSql})`,
  );
  return { id, row: { id, ...input.data } };
};

/** Patch an existing row by id. Validates partial fields. Tenant-scoped. */
export const updateItem = async (
  ctx: Ctx,
  input: UpdateItemInput,
): Promise<void> => {
  const collection = await loadCollection(ctx, input.tenantId, input.slug);
  validateRow(input.data, collection.fields, true);

  const now = nowFor(ctx.dialect);
  const sets = [sql`${sql.identifier("updated_at")} = ${now}`];
  for (const f of collection.fields) {
    if (input.data[f.name] === undefined) continue;
    sets.push(
      sql`${sql.identifier(f.name)} = ${serialize(input.data[f.name], f.type, ctx.dialect)}`,
    );
  }
  if (sets.length === 1) return; // nothing to update beyond the timestamp

  const wheres = [sql`${sql.identifier("id")} = ${input.id}`];
  if (collection.tenantScoped) {
    wheres.push(sql`${sql.identifier("tenant_id")} = ${input.tenantId}`);
  }

  await execute(
    ctx,
    sql`UPDATE ${sql.identifier(collection.physicalTable)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.join(wheres, sql` AND `)}`,
  );
};
