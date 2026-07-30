import { sql, type SQL } from "drizzle-orm";
import { type FieldDef, resolveAutoFill, sidecarFields } from "@backlex/db";
import { AppError, type AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import { publishEvent } from "../events";
import { recordActivity } from "../activity";
import { runSyncHooks } from "../sync-hooks";
import { recordRevision } from "../revisions";
import { embedAndUpsert, deleteVector } from "../vectorize";
import { indexFts, deleteFts } from "../fts";
import type { CollectionRow } from "./collection-loader";
import { serialize, deserialize, deserializeRow, projectFields } from "./serialize";
import {
  collectFieldWarnings,
  enforceFieldConditions,
  enforceValidationRules,
  type FieldWarning,
  validateAppUserLinks,
  validateBody,
  validateRelations,
} from "./validate";
import { hashIncomingFields, scrubHashFields, scrubPrivateFields } from "./hash-fields";
import { assertRowsWithinLimit } from "../usage";
import { enforceOnDeleteTriggers } from "./on-delete";
import {
  echoLocalized,
  sidecarClear,
  sidecarDeleteRow,
  sidecarInsert,
  sidecarUpsert,
  splitIsEmpty,
  splitLocalized,
  validateLocalePatches,
} from "./i18n-sidecar";
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
import {
  getStagedRow,
  stagedDeleteSql,
  stagedUpsertSql,
  stagedViewOf,
} from "./staged";

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
  /** Caller email, when known — lets a field condition rule resolve
   *  `$user.email`. Optional; omitted ⇒ null. */
  email?: string | null;
  /** requestMeta(c.req.raw) — ip/ua/etc. for the activity row. */
  meta: Record<string, unknown>;
  durationMs: () => number;
  /** ?locale= write target for `localized` (sidecar) fields. */
  locale: string | null;
  /**
   * Skip synchronous hooks for this write.
   *
   * Opt-OUT rather than opt-in on purpose: a validation hook that silently does
   * not run is a worse failure than a restore being slow, so a caller who
   * forgets the flag still gets the guarantee. Set it for machine-driven bulk
   * writes — restore, seed, template apply, CSV import — where firing a
   * blocking HTTP call per row is both pointless and ruinous.
   */
  skipSyncHooks?: boolean;
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
  // Unique/FK violations are mapped to clean 4xx inside execute().
  await execute(env.ctx, stmt, env.db);
};

export type SideEffect = () => Promise<void>;

export interface WriteResult {
  id: string;
  /** The projected row (create/update) or the deleted row (delete). */
  data?: Record<string, unknown>;
  /** Advisory (warning/info) validation hints — non-blocking. */
  warnings?: FieldWarning[];
  sideEffects: SideEffect[];
}

const authOf = (env: WriteEnv) => ({ tenantId: env.tenantId ?? null, roles: env.roles });

/** Full auth subject for the DSL evaluator (field-condition rule matching). */
const authSubjectOf = (env: WriteEnv): AuthSubject => ({
  userId: env.userId,
  email: env.email ?? null,
  roles: env.roles,
  tenantId: env.tenantId ?? null,
});

export const performCreate = async (
  env: WriteEnv,
  dataIn: Record<string, unknown>,
  perm: ResolvedPerm,
): Promise<WriteResult> => {
  let data = dataIn;
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  // Hard workspace row cap (#12) — checked against the half-hourly sweep
  // gauge, so it's approximate by design (a burst can overshoot until the
  // next sweep). Single chokepoint: REST, batch, GraphQL, and MCP all create
  // through here.
  if (env.tenantId) await assertRowsWithinLimit(ctx, ctx.env, env.tenantId);
  let id: string;
  // Integer-keyed managed collections (external-DB migration creates these)
  // share the adopted contract: backlex never invents numeric keys, so the
  // body must carry the PK. uuid/text PKs keep auto-generating a UUID.
  if (collection.adopted || collection.pkType === "integer") {
    const pkVal = data[collection.pkColumn];
    if (pkVal === undefined || pkVal === null || pkVal === "") {
      throw new AppError(
        "VALIDATION",
        `Primary key "${collection.pkColumn}" is required in the body for ${
          collection.adopted ? "adopted" : "integer-keyed"
        } collections`,
      );
    }
    id = String(pkVal);
    delete data[collection.pkColumn];
  } else {
    id = crypto.randomUUID();
  }
  // Pull `localized` fields out of `data` up front so the base INSERT never
  // targets a sidecar-only column, and validate each provided per-locale value.
  const localeSplit = splitLocalized(data, collection.fields, env.locale);
  validateLocalePatches(localeSplit, collection.fields);
  validateBody(data, collection.fields, false, perm.fields);
  await validateRelations(data, collection.fields, ctx, env.tenantId);
  await validateAppUserLinks(data, collection.fields, ctx, env.tenantId);
  // Enforce conditional `required` effects against the proposed row (runs before
  // hashing so a rule sees the plaintext the user typed).
  enforceFieldConditions(data, collection.fields, authSubjectOf(env));
  // Cross-field validation rules run on the same plaintext proposed row.
  enforceValidationRules(data, collection.fields, authSubjectOf(env));
  const warnings = collectFieldWarnings(data, collection.fields, authSubjectOf(env));
  // Replace any `hash` field's plaintext with its scrypt digest before the row
  // is built. Empty values are dropped (see hashIncomingFields).
  await hashIncomingFields(data, collection.fields);

  // Synchronous hooks run LAST in the validation phase — after
  // `hashIncomingFields`, so a hook never sees a plaintext password — and can
  // reject the write or patch the payload. A patched body is re-validated:
  // the hook is external, so its output is no more trusted than the client's.
  if (!env.skipSyncHooks) {
    const hooked = await runSyncHooks(ctx, {
      tenantId: env.tenantId ?? null,
      collection: collection.slug,
      phase: "beforeCreate",
      id: null,
      data,
      actor: { userId: env.userId, email: env.email ?? null, roles: env.roles },
    });
    if (hooked.data !== data) {
      data = hooked.data;
      validateBody(data, collection.fields, false, perm.fields);
    }
  }

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
  // Auto-filled columns are computed + written server-side (client input was
  // rejected by validateBody), so they can't be spoofed.
  for (const f of collection.fields) {
    if (!f.onCreate) continue;
    const v = resolveAutoFill(f.onCreate, { now, userId: env.userId, tenantId: env.tenantId });
    if (v === undefined) continue;
    const stored = serialize(v, f.type, ctx.dialect);
    cols.push(f.name);
    vals.push(stored);
    // Feed the response / event / index the read-form value (e.g. an ISO
    // timestamp) so it matches what a subsequent GET returns.
    data[f.name] = deserialize(stored, f.type, ctx.dialect);
  }
  for (const f of collection.fields) {
    if (data[f.name] === undefined || f.onCreate) continue;
    cols.push(f.name);
    vals.push(serialize(data[f.name], f.type, ctx.dialect));
  }

  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await emit(env, sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`);
  // Translations sidecar: one INSERT per locale touched (no conflict possible on
  // a fresh row). Emitted through the same chokepoint so it joins the atomic
  // batch / transaction and rolls back with the base row.
  if (!splitIsEmpty(localeSplit)) {
    const byName = new Map<string, FieldDef>(collection.fields.map((f) => [f.name, f]));
    for (const [loc, fieldMap] of localeSplit.localePatches) {
      await emit(env, sidecarInsert(table, id, loc, fieldMap, byName, ctx.dialect));
    }
  }
  if (usesOwnershipSideTable(collection) && env.userId) {
    await emit(
      env,
      sql`INSERT INTO ${sql.identifier("item_ownership")} (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}, ${sql.identifier("owner_id")}, ${sql.identifier("created_at")})
          VALUES (${collection.id}, ${id}, ${env.userId}, ${now})`,
    );
  }

  // Digest is persisted — scrub it from the payload before it feeds the
  // response, event, audit and embed/FTS side-effects.
  scrubHashFields(data, collection.fields);
  scrubPrivateFields(data, collection.fields);
  const out: Record<string, unknown> = { id, ...data, ...echoLocalized(localeSplit, env.locale) };
  if (collection.hasCreatedAt) out.createdAt = deserialize(now, "timestamp", ctx.dialect);
  if (collection.hasUpdatedAt) out.updatedAt = deserialize(now, "timestamp", ctx.dialect);
  if (collection.ownerScoped) out.ownerId = env.userId;
  const projected = projectFields(out, perm.fields);

  const sideEffects: SideEffect[] = [
    () => embedAndUpsert(ctx, collection, env.tenantId ?? null, id, data),
    () => indexFts(ctx, collection, id, data),
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
  return { id, data: projected, warnings: warnings.length ? warnings : undefined, sideEffects };
};

export const performUpdate = async (
  env: WriteEnv,
  id: string,
  patchIn: Record<string, unknown>,
  perm: ResolvedPerm,
  opts?: {
    /** Optimistic-concurrency precondition: the `updatedAt` the caller loaded
     *  the row with. When set and the row has moved since, the update is
     *  refused with 409 CONFLICT instead of silently last-write-winning. */
    ifUnmodifiedSince?: string;
    /** Bypass staged-edits interception and write the live row directly.
     *  Set by `?live=1` (route gates it on publish permission) and by the
     *  publish endpoint / cron when *applying* a staged patch. */
    live?: boolean;
  },
): Promise<WriteResult> => {
  let patch = patchIn;
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  // Split localized fields out before base validation/write (same as create).
  const localeSplit = splitLocalized(patch, collection.fields, env.locale);
  validateLocalePatches(localeSplit, collection.fields);
  validateBody(patch, collection.fields, true, perm.fields);
  await validateRelations(patch, collection.fields, ctx, env.tenantId);
  await validateAppUserLinks(patch, collection.fields, ctx, env.tenantId);
  // Hash `hash`-typed fields; an empty/omitted value is dropped so the existing
  // digest is left untouched ("leave blank to keep").
  await hashIncomingFields(patch, collection.fields);

  // Same placement and reasoning as create: after hashing (so a hook never
  // sees plaintext), and a patched body is re-validated because the hook's
  // output is no more trusted than the client's.
  if (!env.skipSyncHooks) {
    const hooked = await runSyncHooks(ctx, {
      tenantId: env.tenantId ?? null,
      collection: collection.slug,
      phase: "beforeUpdate",
      id,
      data: patch,
      actor: { userId: env.userId, email: env.email ?? null, roles: env.roles },
    });
    if (hooked.data !== patch) {
      patch = hooked.data;
      validateBody(patch, collection.fields, true, perm.fields);
    }
  }

  const tenantWhere = tenantFilter(collection, authOf(env));
  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))} LIMIT 1`,
    env.db,
  );
  if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
  const beforeRow = deserializeRow(existing[0], collection.fields, ctx.dialect, collection.ownerScoped);

  // Optimistic-concurrency guard: refuse the write when the row moved after
  // the caller loaded it. Compared as epoch ms so ISO-format differences
  // between dialects don't matter. Advisory and opt-in — callers that don't
  // send the precondition keep today's last-write-wins behavior.
  if (opts?.ifUnmodifiedSince !== undefined && collection.hasUpdatedAt) {
    const expectedMs = new Date(opts.ifUnmodifiedSince).getTime();
    if (Number.isNaN(expectedMs)) {
      throw new AppError("VALIDATION", "Invalid If-Unmodified-Since value — expected a timestamp");
    }
    const currentRaw = beforeRow.updatedAt;
    const currentMs =
      currentRaw instanceof Date ? currentRaw.getTime() : new Date(String(currentRaw ?? "")).getTime();
    if (!Number.isNaN(currentMs) && currentMs !== expectedMs) {
      throw new AppError("CONFLICT", "This record was modified after you loaded it", {
        currentUpdatedAt: currentRaw ?? null,
      });
    }
  }

  // Enforce conditional `required` against the POST-patch row: a rule that
  // references fields the PATCH omits is still judged against the merged result.
  const mergedForConditions: Record<string, unknown> = { ...beforeRow };
  for (const f of collection.fields) {
    if (patch[f.name] !== undefined) mergedForConditions[f.name] = patch[f.name];
  }
  enforceFieldConditions(mergedForConditions, collection.fields, authSubjectOf(env));
  enforceValidationRules(mergedForConditions, collection.fields, authSubjectOf(env));
  const warnings = collectFieldWarnings(mergedForConditions, collection.fields, authSubjectOf(env));

  // Staged-edits interception: on a `stagedEdits` collection, an ordinary
  // PATCH against a *published* row never touches the live row — the (already
  // validated + hashed) patch is folded into the item's staged JSON patch
  // instead, and `publish` applies it later. Draft/archived rows and `live`
  // callers fall through to the normal write below. Sits after validation so
  // a staged save surfaces the same 4xx a live save would.
  if (
    collection.versioned &&
    collection.stagedEdits &&
    !opts?.live &&
    (beforeRow as Record<string, unknown>)._status === "published"
  ) {
    // Canonical staged shape: base fields post-hash from `patch`; localized
    // fields as their full `{locale: value}` map (splitLocalized with a null
    // write-locale routes maps back into the sidecar on apply); a locale-less
    // null (clear-all-locales) stays a null.
    const stagedPatch: Record<string, unknown> = { ...patch };
    for (const [loc, fieldMap] of localeSplit.localePatches) {
      for (const [fname, v] of Object.entries(fieldMap)) {
        const prev = stagedPatch[fname];
        stagedPatch[fname] = {
          ...(prev && typeof prev === "object" && !Array.isArray(prev)
            ? (prev as Record<string, unknown>)
            : {}),
          [loc]: v,
        };
      }
    }
    for (const name of localeSplit.clearAll) stagedPatch[name] = null;

    const existingStaged = await getStagedRow(ctx, collection, id);
    const mergedStaged: Record<string, unknown> = {
      ...(existingStaged?.data ?? {}),
      ...stagedPatch,
    };
    await emit(
      env,
      stagedUpsertSql(
        ctx.dialect,
        collection.id,
        id,
        env.tenantId ?? null,
        mergedStaged,
        env.userId,
      ),
    );
    // Response: the live row with the staged patch previewed on top, flagged
    // `_staged`. `updatedAt` is NOT bumped — the live row didn't move.
    const preview: Record<string, unknown> = {
      ...beforeRow,
      ...stagedViewOf(mergedStaged, collection.fields),
    };
    const projectedPreview = projectFields(preview, perm.fields);
    // Set after projection — `_staged` is a system annotation, not a field.
    projectedPreview._staged = true;
    const auditPatch = stagedViewOf(stagedPatch, collection.fields);
    const sideFx: SideEffect[] = [
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
            payload: { ...auditPatch, _staged: true },
            response: { data: projectedPreview },
            durationMs: env.durationMs(),
          },
        ),
    ];
    return {
      id,
      data: projectedPreview,
      warnings: warnings.length ? warnings : undefined,
      sideEffects: sideFx,
    };
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
  // Auto-filled-on-update columns are computed + written server-side (client
  // input was rejected by validateBody). Fold the value into `patch` so the
  // SET below emits it and the refreshed-row merge reflects it.
  for (const f of collection.fields) {
    if (!f.onUpdate) continue;
    const v = resolveAutoFill(f.onUpdate, { now, userId: env.userId, tenantId: env.tenantId });
    if (v === undefined) continue;
    const stored = serialize(v, f.type, ctx.dialect);
    sets.push(sql`${sql.identifier(f.name)} = ${stored}`);
    patch[f.name] = deserialize(stored, f.type, ctx.dialect);
  }
  if (sets.length > 0) {
    await emit(
      env,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
  }
  // Translations sidecar: upsert each touched locale (preserving other locales /
  // fields), then NULL any field cleared with a locale-less null. The base
  // UPDATE above already bumped `updated_at` unconditionally, so a sidecar-only
  // PATCH still moves the row's version (the single-read ETag keys on it).
  if (!splitIsEmpty(localeSplit)) {
    const byName = new Map<string, FieldDef>(collection.fields.map((f) => [f.name, f]));
    for (const [loc, fieldMap] of localeSplit.localePatches) {
      await emit(env, sidecarUpsert(table, id, loc, fieldMap, byName, ctx.dialect));
    }
    for (const name of localeSplit.clearAll) {
      await emit(env, sidecarClear(table, id, name));
    }
  }

  // Digest is persisted — scrub it from the patch so the merge below, the
  // response, event and audit payload never carry it.
  scrubHashFields(patch, collection.fields);
  // Private columns must not re-enter the merged row below (beforeRow already
  // omits them via deserializeRow) so the response/event/index stay clean.
  scrubPrivateFields(patch, collection.fields);
  // Refreshed row: in-memory merge of the before-row + applied patch (the only
  // columns that changed are updated_at + the patched fields). Avoids a
  // post-write SELECT so the same code path works inside an atomic batch where
  // the write hasn't committed yet.
  const refreshedRow: Record<string, unknown> = { ...beforeRow };
  for (const f of collection.fields) {
    if (patch[f.name] !== undefined) refreshedRow[f.name] = patch[f.name];
  }
  // Reflect the localized fields this write touched (native value or map).
  Object.assign(refreshedRow, echoLocalized(localeSplit, env.locale));
  if (collection.hasUpdatedAt) refreshedRow.updatedAt = deserialize(now, "timestamp", ctx.dialect);
  const projected = projectFields(refreshedRow, perm.fields);

  const sideEffects: SideEffect[] = [
    () => embedAndUpsert(ctx, collection, env.tenantId ?? null, id, refreshedRow),
    () => indexFts(ctx, collection, id, refreshedRow),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        // `before` is server-only (reactive Stage 2): the emit chokepoint uses
        // it to compute each filtered subscriber's membership transition, then
        // strips it — it never reaches a client.
        { event: "updated", data: refreshedRow, before: beforeRow },
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
  return { id, data: projected, warnings: warnings.length ? warnings : undefined, sideEffects };
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

  // Delete hooks can only veto — a `data` patch has nothing to patch — so the
  // returned payload is ignored and only the allow/deny verdict matters.
  if (!env.skipSyncHooks) {
    await runSyncHooks(ctx, {
      tenantId: env.tenantId ?? null,
      collection: collection.slug,
      phase: "beforeDelete",
      id,
      data: oldRow,
      actor: { userId: env.userId, email: env.email ?? null, roles: env.roles },
    });
  }

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
    // Translations sidecar rows go with a hard delete (SQLite/D1 have no FK
    // cascade). Only emit when the collection actually has a sidecar table, else
    // the DELETE would target a non-existent table.
    if (sidecarFields(collection.fields).length > 0) {
      await emit(env, sidecarDeleteRow(table, id));
    }
  }

  // Deleting the row obsoletes any staged patch for it. Guarded on `versioned`
  // (not `stagedEdits`) so patches left behind by a toggled-off setting still
  // get cleaned up.
  if (collection.versioned) {
    await emit(env, stagedDeleteSql(collection.id, id));
  }

  // App-layer ON DELETE relational triggers: null-out or cascade rows in other
  // collections that reference this one (no DB-level FKs in v1). Runs on both
  // hard and soft delete so a soft-deleted target still detaches its children.
  await enforceOnDeleteTriggers(ctx, env.tenantId, collection.slug, id, (stmt) =>
    emit(env, stmt),
  );

  const sideEffects: SideEffect[] = [
    () => deleteVector(ctx, collection, env.tenantId ?? null, id),
    () => deleteFts(ctx, collection, id),
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
