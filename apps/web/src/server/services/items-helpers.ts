import { sql, and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import { validateValue, type FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import { serializeField } from "./items/serialize";
import { canonicalizeMoneyFields } from "./items/money-fields";
import {
  assertInitialStates,
  assertTransitions,
  transitionFieldsOf,
} from "./items/transitions";

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

/**
 * Re-exported from the items write path rather than reimplemented.
 *
 * This module used to carry its own copy, and it had drifted: `timestamp`
 * became `Number(value)` on SQLite (so the ISO string a read hands back stored
 * as null) and a `Date` on Postgres (which postgres-js cannot bind for a
 * dynamic table), and `geo` was never normalized at all. Every collection write
 * that goes through a flow, a booking, a payment sync or an approval came
 * through here, so those were not edge cases. One implementation, one set of
 * fixes.
 */
export { serialize } from "./items/serialize";

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
  // Flows, bookings, payment syncs and approvals all write collections through
  // here without ever touching `performCreate`, so the money canonicalization
  // has to happen on this path too — otherwise a flow that sets `total: 19.99`
  // stores nineteen minor units. Same class of miss as GraphQL hand-building
  // its own INSERT.
  canonicalizeMoneyFields(input.data, collection.fields);
  // A lifecycle's `initial` list is a property of the data, not of the caller,
  // so it holds for a flow-authored row too — see ./items/transitions.
  assertInitialStates(collection.fields, input.data);

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
    vals.push(serializeField(input.data[f.name], f, ctx.dialect));
  }

  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await execute(
    ctx,
    sql`INSERT INTO ${sql.identifier(collection.physicalTable)} (${colSql}) VALUES (${valSql})`,
  );
  return { id, row: { id, ...input.data } };
};

/**
 * Enforce the lifecycle graph on a server-authored patch (flow, booking,
 * payment sync, approval resolution).
 *
 * The graph is data integrity, so it applies here exactly as it does to a
 * request from a person; the ROLE gate does not, because there is no person —
 * hence `roles: null`. See `./items/transitions` for that split.
 *
 * Costs one SELECT, and only when the collection actually has a lifecycle field
 * the patch is touching: a transition needs the value being moved out of, and
 * unlike `performUpdate` this path never loads the row it is patching.
 */
const assertFlowTransitions = async (
  ctx: Ctx,
  collection: CollectionRow,
  input: UpdateItemInput,
): Promise<void> => {
  const touched = transitionFieldsOf(collection.fields).filter(
    (f) => input.data[f.name] !== undefined,
  );
  if (touched.length === 0) return;
  const cols = sql.join(
    [...new Set(touched.map((f) => f.name))].map((n) => sql.identifier(n)),
    sql`, `,
  );
  const wheres = [sql`${sql.identifier("id")} = ${input.id}`];
  if (collection.tenantScoped) {
    wheres.push(sql`${sql.identifier("tenant_id")} = ${input.tenantId}`);
  }
  const query = sql`SELECT ${cols} FROM ${sql.identifier(collection.physicalTable)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`;
  const rows =
    ctx.dialect === "pg"
      ? await (async () => {
          const r = (await (ctx.db as any).execute(query)) as unknown;
          if (Array.isArray(r)) return r as Record<string, unknown>[];
          if (r && typeof r === "object" && "rows" in r) {
            return (r as { rows: Record<string, unknown>[] }).rows;
          }
          return [] as Record<string, unknown>[];
        })()
      : ((await (ctx.db as any).all(query)) as Record<string, unknown>[]);
  const before = rows[0];
  // No row: the UPDATE below will match nothing either. Leave the "not found"
  // shape as it was rather than inventing a new error from a pre-check.
  if (!before) return;
  assertTransitions({
    fields: collection.fields,
    before,
    patch: input.data,
    merged: { ...before, ...input.data },
    roles: null,
  });
};

/** Patch an existing row by id. Validates partial fields. Tenant-scoped. */
export const updateItem = async (
  ctx: Ctx,
  input: UpdateItemInput,
): Promise<void> => {
  const collection = await loadCollection(ctx, input.tenantId, input.slug);
  validateRow(input.data, collection.fields, true);
  canonicalizeMoneyFields(input.data, collection.fields);
  await assertFlowTransitions(ctx, collection, input);

  const now = nowFor(ctx.dialect);
  const sets = [sql`${sql.identifier("updated_at")} = ${now}`];
  for (const f of collection.fields) {
    if (input.data[f.name] === undefined) continue;
    sets.push(
      sql`${sql.identifier(f.name)} = ${serializeField(input.data[f.name], f, ctx.dialect)}`,
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
