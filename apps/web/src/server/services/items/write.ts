import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { Ctx } from "../../context";
import { publishEvent } from "../events";
import { recordActivity } from "../activity";
import { recordRevision } from "../revisions";
import { embedAndUpsert, deleteVector } from "../vectorize";
import { type CollectionRow, hasI18nField } from "./collection-loader";
import { serialize, deserialize, deserializeRow, projectFields } from "./serialize";
import { validateBody, validateRelations } from "./validate";
import { mergeI18nPatch } from "./i18n";
import {
  deletedFilter,
  execute,
  fromOf,
  nowFor,
  pkEq,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "./sql-helpers";

/**
 * Shared item-write core. The single-item REST handlers AND the batch endpoint
 * both call these so create/update/delete stay byte-identical across the two
 * surfaces. Each `perform*` validates, executes its physical write (against
 * `env.db` — `ctx.db` normally, a transaction handle in atomic-batch mode), and
 * returns its async side-effects (vectorize, realtime/flow/webhook events,
 * audit, revisions) as thunks the caller runs *after* the write (or after the
 * transaction commits). They THROW `AppError` on failure — the single-item
 * handlers let it bubble to the error middleware, the non-atomic batch catches
 * it per-row, and the atomic batch lets it abort the whole transaction.
 */

export interface ResolvedPerm {
  whereSql: SQL | null | undefined;
  fields: Set<string> | null;
}

export interface WriteEnv {
  ctx: Ctx;
  collection: CollectionRow;
  userId: string | null;
  tenantId: string | null | undefined;
  roles: string[];
  /** requestMeta(c.req.raw) — ip/ua/etc. for the activity row. */
  meta: Record<string, unknown>;
  durationMs: () => number;
  /** ?locale= write target for i18n_text fields. */
  locale: string | null;
  /** Physical-write DB handle. Defaults to ctx.db; an atomic batch passes its
   *  transaction handle so the writes commit/roll back together. */
  db?: unknown;
  /** Atomic mode: when set, write statements are pushed here (in order) instead
   *  of executing immediately. The caller replays them inside one transaction
   *  so the whole batch commits or rolls back together. Reads (existence /
   *  before-snapshot) still run against ctx.db during the prepare phase. */
  collect?: SQL[];
}

/** Execute a write statement, or queue it when collecting for an atomic batch. */
const emit = async (env: WriteEnv, stmt: SQL): Promise<void> => {
  if (env.collect) {
    env.collect.push(stmt);
    return;
  }
  await execute(env.ctx, stmt, env.db);
};

export type SideEffect = () => Promise<void>;

export interface WriteResult {
  id: string;
  /** The projected row (create/update) or the deleted row (delete). */
  data?: Record<string, unknown>;
  sideEffects: SideEffect[];
}

const authOf = (env: WriteEnv) => ({ tenantId: env.tenantId ?? null, roles: env.roles });

export const performCreate = async (
  env: WriteEnv,
  data: Record<string, unknown>,
  perm: ResolvedPerm,
): Promise<WriteResult> => {
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  let id: string;
  if (collection.adopted) {
    const pkVal = data[collection.pkColumn];
    if (pkVal === undefined || pkVal === null || pkVal === "") {
      throw new AppError(
        "VALIDATION",
        `Primary key "${collection.pkColumn}" is required in the body for adopted collections`,
      );
    }
    id = String(pkVal);
    delete data[collection.pkColumn];
  } else {
    id = crypto.randomUUID();
  }
  validateBody(data, collection.fields, false, perm.fields);
  await validateRelations(data, collection.fields, ctx, env.tenantId);

  if (collection.singleton) {
    const existingOne = await queryAll<{ one: number }>(
      ctx,
      sql`SELECT 1 AS one FROM ${fromOf(collection)} ${whereOf(tenantFilter(collection, authOf(env)), deletedFilter(collection))} LIMIT 1`,
      env.db,
    );
    if (existingOne[0]) {
      throw new AppError("VALIDATION", "This collection is a singleton and already has a row");
    }
  }
  if (hasI18nField(collection.fields)) {
    mergeI18nPatch(data, {}, collection.fields, env.locale);
  }
  const now = nowFor(ctx.dialect);

  const cols: string[] = [collection.pkColumn];
  const vals: unknown[] = [id];
  if (collection.hasCreatedAt) {
    cols.push(collection.createdAtColumn ?? "created_at");
    vals.push(now);
  }
  if (collection.hasUpdatedAt) {
    cols.push(collection.updatedAtColumn ?? "updated_at");
    vals.push(now);
  }
  if (collection.ownerScoped && !collection.adopted) {
    cols.push("owner_id");
    vals.push(env.userId);
  }
  if (collection.tenantScoped) {
    if (!env.tenantId) {
      throw new AppError(
        "VALIDATION",
        "Active tenant could not be resolved; cannot insert into tenant-scoped collection",
      );
    }
    cols.push("tenant_id");
    vals.push(env.tenantId);
  }
  for (const f of collection.fields) {
    if (data[f.name] === undefined) continue;
    cols.push(f.name);
    vals.push(serialize(data[f.name], f.type, ctx.dialect));
  }

  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await emit(env, sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`);
  if (usesOwnershipSideTable(collection) && env.userId) {
    await emit(
      env,
      sql`INSERT INTO ${sql.identifier("item_ownership")} (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}, ${sql.identifier("owner_id")}, ${sql.identifier("created_at")})
          VALUES (${collection.id}, ${id}, ${env.userId}, ${now})`,
    );
  }

  const out: Record<string, unknown> = { id, ...data };
  if (collection.hasCreatedAt) out.createdAt = deserialize(now, "timestamp", ctx.dialect);
  if (collection.hasUpdatedAt) out.updatedAt = deserialize(now, "timestamp", ctx.dialect);
  if (collection.ownerScoped) out.ownerId = env.userId;
  const projected = projectFields(out, perm.fields);

  const sideEffects: SideEffect[] = [
    () => embedAndUpsert(ctx, collection, env.tenantId ?? null, id, data),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "created", data: out },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: env.tenantId ?? null },
      ),
    () =>
      recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: env.userId,
          tenantId: env.tenantId ?? null,
          action: "create",
          collection: collection.slug,
          itemId: id,
          ...env.meta,
          payload: data,
          response: { data: projected },
          durationMs: env.durationMs(),
        },
      ),
  ];
  return { id, data: projected, sideEffects };
};

export const performUpdate = async (
  env: WriteEnv,
  id: string,
  patch: Record<string, unknown>,
  perm: ResolvedPerm,
): Promise<WriteResult> => {
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  validateBody(patch, collection.fields, true, perm.fields);
  await validateRelations(patch, collection.fields, ctx, env.tenantId);

  const tenantWhere = tenantFilter(collection, authOf(env));
  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))} LIMIT 1`,
    env.db,
  );
  if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
  const beforeRow = deserializeRow(existing[0], collection.fields, ctx.dialect, collection.ownerScoped);

  if (hasI18nField(collection.fields)) {
    mergeI18nPatch(patch, beforeRow, collection.fields, env.locale);
  }

  const now = nowFor(ctx.dialect);
  const sets: SQL[] = [];
  if (collection.hasUpdatedAt) {
    sets.push(sql`${sql.identifier(collection.updatedAtColumn ?? "updated_at")} = ${now}`);
  }
  for (const f of collection.fields) {
    if (patch[f.name] === undefined) continue;
    sets.push(sql`${sql.identifier(f.name)} = ${serialize(patch[f.name], f.type, ctx.dialect)}`);
  }
  if (sets.length > 0) {
    await emit(
      env,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
  }

  // Refreshed row: in-memory merge of the before-row + applied patch (the only
  // columns that changed are updated_at + the patched fields). Avoids a
  // post-write SELECT so the same code path works inside an atomic batch where
  // the write hasn't committed yet.
  const refreshedRow: Record<string, unknown> = { ...beforeRow };
  for (const f of collection.fields) {
    if (patch[f.name] !== undefined) refreshedRow[f.name] = patch[f.name];
  }
  if (collection.hasUpdatedAt) refreshedRow.updatedAt = deserialize(now, "timestamp", ctx.dialect);
  const projected = projectFields(refreshedRow, perm.fields);

  const sideEffects: SideEffect[] = [
    () => embedAndUpsert(ctx, collection, env.tenantId ?? null, id, refreshedRow),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "updated", data: refreshedRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: env.tenantId ?? null },
      ),
    () =>
      recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: env.userId,
          tenantId: env.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: id,
          ...env.meta,
          payload: patch,
          response: { data: projected },
          durationMs: env.durationMs(),
        },
      ),
    () =>
      recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: beforeRow,
          userId: env.userId,
          tenantId: env.tenantId ?? null,
        },
      ),
  ];
  return { id, data: projected, sideEffects };
};

export const performDelete = async (
  env: WriteEnv,
  id: string,
  perm: ResolvedPerm,
): Promise<WriteResult> => {
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  const tenantWhere = tenantFilter(collection, authOf(env));

  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))} LIMIT 1`,
    env.db,
  );
  if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
  const oldRow = deserializeRow(existing[0], collection.fields, ctx.dialect, collection.ownerScoped);

  if (collection.softDelete) {
    // Bump `updated_at` alongside `deleted_at` so the soft-delete surfaces in the
    // incremental changefeed (offline sync) — a tombstone whose `updated_at`
    // didn't move would fall before the client's cursor and never sync.
    const now = nowFor(ctx.dialect);
    const softSets = [sql`${sql.identifier("deleted_at")} = ${now}`];
    if (collection.hasUpdatedAt) {
      softSets.push(sql`${sql.identifier(collection.updatedAtColumn ?? "updated_at")} = ${now}`);
    }
    await emit(
      env,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(softSets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
  } else {
    await emit(
      env,
      sql`DELETE FROM ${sql.identifier(table)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
    if (usesOwnershipSideTable(collection)) {
      await emit(
        env,
        sql`DELETE FROM ${sql.identifier("item_ownership")}
            WHERE ${sql.identifier("collection_id")} = ${collection.id}
            AND ${sql.identifier("item_id")} = ${id}`,
      );
    }
  }

  const sideEffects: SideEffect[] = [
    () => deleteVector(ctx, collection, id),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "deleted", data: oldRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: env.tenantId ?? null },
      ),
    () =>
      recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: env.userId,
          tenantId: env.tenantId ?? null,
          action: "delete",
          collection: collection.slug,
          itemId: id,
          ...env.meta,
          payload: oldRow,
          response: { ok: true },
          durationMs: env.durationMs(),
        },
      ),
    () =>
      recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: oldRow,
          userId: env.userId,
          tenantId: env.tenantId ?? null,
        },
      ),
  ];
  return { id, data: oldRow, sideEffects };
};
