/**
 * The long-running admin operations, as durable jobs.
 *
 * **What was wrong.** The queue had retry, backoff, cancel, a dead-letter and an
 * alert channel, and carried none of the work that needed them. Its nine
 * registered types were all integration or agent traffic the product queues for
 * itself. Meanwhile a backup, a restore, a full-text reindex, a vector reindex,
 * a rollup refresh and a geocode backfill all ran INLINE in the request that
 * asked for them — the six operations most likely to exceed a request deadline
 * were the six with no retry, no cancel and no record of having got half way.
 * `POST /:slug/vectorize` was the worst of them: one embedding API call per row,
 * unbounded, inside the request.
 *
 * **The shape.** Every route keeps its synchronous behaviour byte for byte and
 * gains `?async=1`, which enqueues instead and answers `202 { jobId, … }`. No
 * caller is forced to change; the SDK, CLI and MCP twins keep working untouched
 * against the sync path, and the ones that want durability opt in.
 *
 * **The security rule, which shaped everything else.** These split into two
 * classes: admin-scoped (backup, restore, fts/vector reindex) and ROW-LEVEL
 * permission-scoped (geo backfill, rollup refresh). Running the second class as
 * the system would be a privilege escalation with a queue in front of it — the
 * bundled self-service roles grant `update` conditioned on
 * `app_user_id = $user.id`, so an unscoped backfill hands one end user every
 * other customer's address and ships it to a third-party geocoder. So the
 * payload carries `runAs: {userId, tenantId}` and NOTHING else: roles,
 * membership and the compiled `perm.whereSql` are resolved again here, when the
 * work actually runs. A serialized filter would still be enforcing the grant the
 * user held when they pressed the button. See `services/jobs-run-as.ts`.
 *
 * **Three callers are refused rather than queued** (`assertQueueable`): API
 * keys, app-plane end-users and impersonation sessions. Each carries a narrowing
 * that `{userId, tenantId}` cannot express, and re-resolving from the user id
 * alone would silently WIDEN it. Same call the agent path already makes for the
 * same reason (`services/agents/send.ts`).
 */
import { AppError } from "@backlex/core";
import type { Ctx } from "../context";
import type { JobRow, JobType } from "./jobs";
import { enqueueJob, runJobInline } from "./jobs";
import { progressReporterFor, type ProgressReporter } from "./job-progress";
import { requireRunAs, resolveRunAsAdmin, resolveRunAsAuth, type RunAs } from "./jobs-run-as";
import { resolvePermission } from "./permissions";
import { recordActivity } from "./activity";
import { loadCollection } from "./items/collection-loader";
import { backfillFts, isSearchable } from "./fts";
import { embedAndUpsertBatch, isVectorizable } from "./vectorize";
import { refreshCollectionRollups } from "./items/rollup";
import { recordAndRunBackup, restoreBackupById, getBackupScoped } from "./backup";
import {
  geoFieldOrThrow,
  requireGeocodeProvider,
  runGeoBackfill,
  type GeoBackfillResult,
} from "./geo-backfill";
import { queryAll } from "./items/sql-helpers";
import { sql } from "drizzle-orm";

export type LongRunningJobType =
  | "db.backup"
  | "db.restore"
  | "collection.reindex"
  | "geo.backfill";

/**
 * Attempts per type, and each number is a decision about whether replaying the
 * work is safe — not a reliability dial.
 *
 * `attempts` is spent at CLAIM, not at failure (`claimDueJobs` increments as it
 * flips the row to `active`), so "1" really does mean "this runs once, and an
 * isolate that dies mid-flight dead-letters instead of redoing it". That is the
 * right answer for a restore, which replays rows into live tables. It is the
 * wrong answer for a backup, whose worst case on a retry is a second dump.
 */
const MAX_ATTEMPTS: Record<LongRunningJobType, number> = {
  "db.backup": 3,
  // A restore writes into live tables. A half-finished one re-run from the top
  // is not idempotent in `overwrite` mode — it would restate rows an operator
  // may have fixed in between — so it fails visibly rather than trying again.
  "db.restore": 1,
  "collection.reindex": 3,
  // Every attempt spends a metered third-party geocoding quota. Two, so a
  // transient provider blip is survivable and a persistent one is not paid for
  // five times.
  "geo.backfill": 2,
};

/**
 * How long the tick is told to leave a freshly-enqueued job alone.
 *
 * The route enqueues and then starts the job inline on `waitUntil`, so the
 * common case has no queue latency at all. Dating `run_at` forward removes the
 * race between that inline start and a cron tick firing in the same instant:
 * for this window the ONLY thing that can claim the row is the inline runner.
 * After it, the tick is exactly the safety net it is meant to be — an isolate
 * that died before starting gets picked up, one that died mid-run gets picked
 * up on the lease.
 */
const INLINE_GRACE_MS = 60_000;

/** Batches one `geo.backfill` claim will run before re-queueing itself. Bounded
 *  because an edge isolate has a CPU budget and a geocoder has a rate limit;
 *  continued because the point of the job is to finish a collection a single
 *  request could not. */
const GEO_BATCHES_PER_RUN = 10;

/**
 * The request's identity, as the app actually carries it.
 *
 * Deliberately NOT `AuthSubject`: `apiKeyId` is set by `sessionMiddleware` and
 * lives on `AppBindings["Variables"]["auth"]`, but the core `AuthSubject`
 * declares only `apiKeyRoleId`. Typing the parameter as `AuthSubject` compiles
 * away the very field the first refusal below reads — the check would still
 * work at run time, and the type would say it could not.
 */
export interface QueueCaller {
  plane?: string;
  userId: string | null;
  tenantId?: string | null;
  apiKeyId?: string | null;
  impersonatedBy?: string | null;
}

/**
 * Who may put work on this queue.
 *
 * Not a policy choice — each of these carries a narrowing that `runAs`
 * deliberately cannot express, and re-resolving from `{userId, tenantId}` alone
 * would hand the job MORE than the request had:
 *
 *  - **API key.** A role-scoped key resolves to exactly its bound role. Rebuild
 *    from the owner's id and the job gets the owner's full role bundle — a
 *    scoped key escalating to its owner.
 *  - **App plane.** An end-user's grants come from `app_user_roles` plus their
 *    org membership, and `$org.id` / `$org.role` / `$user.orgs` bind off the
 *    subject. `resolveTenantAccess` answers for the control plane only.
 *  - **Impersonation.** `readOnly` lives on the request and nothing re-derives
 *    it from a user id, so a support session could leave a write running after
 *    the session ended.
 *
 * Refusing is the honest answer, and the synchronous path is still there for all
 * three. The agent path makes the same call for the same reason.
 */
export const assertQueueable = (auth: QueueCaller): { userId: string; tenantId: string } => {
  if (!auth.userId || !auth.tenantId) {
    throw new AppError("UNAUTHORIZED", "Background work needs a signed-in user and an active workspace.");
  }
  if (auth.apiKeyId) {
    throw new AppError(
      "VALIDATION",
      "An API key cannot queue background work — a queued job re-resolves its permissions as the key's OWNER, which is wider than the key. Call this without `?async=1`.",
    );
  }
  if (auth.plane === "app") {
    throw new AppError(
      "VALIDATION",
      "Workspace end-users cannot queue background work — a job resolves control-plane roles, and an app-plane identity's grants (including its organization) do not survive the round trip. Call this without `?async=1`.",
    );
  }
  if (auth.impersonatedBy) {
    throw new AppError(
      "VALIDATION",
      "An impersonation session cannot queue background work — the job would outlive the session that authorised it. Call this without `?async=1`.",
    );
  }
  return { userId: auth.userId, tenantId: auth.tenantId };
};

export interface StartJobInput {
  type: LongRunningJobType;
  auth: QueueCaller;
  payload: Record<string, unknown>;
  /** Where to hang the inline start. The route passes `c.executionCtx.waitUntil`
   *  through a guard; on Bun/Node there is no ExecutionContext and the promise
   *  simply runs to completion. */
  background?: (p: Promise<unknown>) => void;
}

/**
 * Queue one long-running operation and start it immediately.
 *
 * Returns only the job id: everything the operation produces lands on the job
 * row (`result`, `progress`, `lastError`), which is the point — a caller that
 * disconnects has lost nothing.
 */
export const startLongJob = async (
  ctx: Ctx,
  input: StartJobInput,
): Promise<{ jobId: string }> => {
  const runAs = assertQueueable(input.auth);
  const { id } = await enqueueJob(ctx, {
    type: input.type as JobType,
    // A label, not an isolation boundary — `claimDueJobs` does not filter by
    // queue. Said here so nobody reads "ops" as a separate worker pool.
    queue: "ops",
    tenantId: runAs.tenantId,
    // `runAs` is spread LAST on purpose. No route builds its payload from a
    // request body today — each one assembles validated values by hand — but
    // this is the line that would have to hold if one ever did, and a caller
    // who could write `runAs` could name any user in the workspace.
    payload: { ...input.payload, runAs },
    maxAttempts: MAX_ATTEMPTS[input.type],
    runAt: new Date(Date.now() + INLINE_GRACE_MS),
  });
  const started = runJobInline(ctx, id);
  if (input.background) input.background(started);
  else void started;
  return { jobId: id };
};

/** Dispatch. Called from `runHandler`'s single branch for these four types, so
 *  the retry / dead-letter / alert behaviour is the queue's, unchanged. */
export const runLongRunningJob = async (ctx: Ctx, job: JobRow): Promise<unknown> => {
  const tenantId = job.tenantId as string;
  const report = progressReporterFor(ctx, job.id);
  switch (job.type as LongRunningJobType) {
    case "db.backup":
      return await runBackupJob(ctx, job, tenantId, report);
    case "db.restore":
      return await runRestoreJob(ctx, job, tenantId);
    case "collection.reindex":
      return await runReindexJob(ctx, job, tenantId, report);
    case "geo.backfill":
      return await runGeoBackfillJob(ctx, job, tenantId, report);
    default:
      throw new Error(`unknown long-running job type '${job.type}'`);
  }
};

// ── db.backup ─────────────────────────────────────────────────────────────

/**
 * The `backups` row is inserted by the ROUTE, synchronously, before the job is
 * queued — so the caller gets an id it can poll and the workspace's backup list
 * shows the attempt immediately rather than only once a worker picks it up.
 * That row's own `status` is the replay guard: `recordAndRunBackup` flips it
 * `queued → running`, so a second copy of this job finds it already `running`
 * and declines instead of dumping the workspace twice.
 */
const runBackupJob = async (
  ctx: Ctx,
  job: JobRow,
  tenantId: string,
  report: ProgressReporter,
): Promise<unknown> => {
  const runAs = requireRunAs(job.payload, job.type, tenantId);
  await resolveRunAsAdmin(ctx, runAs);
  const p = job.payload as { backupId?: string; label?: string | null };
  if (!p.backupId) throw new Error("db.backup job missing payload.backupId");

  const row = await getBackupScoped(ctx, tenantId, p.backupId);
  if (row.status !== "queued") {
    // Either another copy is already running it, or it finished and this is the
    // tick catching up on a lease. Neither may be redone.
    throw new Error(`backup ${p.backupId} is already ${String(row.status)}`);
  }

  const out = await recordAndRunBackup(ctx, {
    id: p.backupId,
    tenantId,
    storageKey: row.storageKey as string,
    userId: runAs.userId,
    label: p.label ?? null,
    onProgress: (x) => report({ ...x, phase: "dump" }),
  });
  // `recordAndRunBackup` persists its own failure on the backups row and answers
  // `{ok:false}` rather than throwing. Rethrow so the QUEUE hears about it too —
  // otherwise a failed dump is recorded as a succeeded job.
  if (!out.ok) throw new Error(out.error ?? "backup failed");
  return { backupId: p.backupId };
};

// ── db.restore ────────────────────────────────────────────────────────────

const runRestoreJob = async (ctx: Ctx, job: JobRow, tenantId: string): Promise<unknown> => {
  const runAs = requireRunAs(job.payload, job.type, tenantId);
  await resolveRunAsAdmin(ctx, runAs);
  const p = job.payload as {
    backupId?: string;
    mode?: "additive" | "overwrite";
    onlyTables?: string[];
  };
  if (!p.backupId) throw new Error("db.restore job missing payload.backupId");
  // Belt and braces on top of `maxAttempts: 1`. A restore writes into live
  // tables, and the one thing that must never happen is a replay of a run that
  // got half way — `attempts` is spent at claim, so anything above the first is
  // a retry of work that already touched data.
  //
  // Scope stated honestly: this catches the QUEUE replaying it (a stale-lease
  // reclaim after an isolate died). It does not catch `POST /api/jobs/{id}/retry`,
  // which resets `attempts` to 0 — and should not, because that is an admin
  // deciding, in their own workspace, that they want it run again. The refusal
  // below tells them to start a fresh restore, and if they retry anyway that is
  // the decision, not an accident.
  if (job.attempts > 1) {
    throw new Error(
      "A restore is never replayed. This one stopped part-way; check the workspace and start a new restore if it is still wanted.",
    );
  }
  return await restoreBackupById(ctx, tenantId, p.backupId, {
    mode: p.mode,
    onlyTables: p.onlyTables,
    userId: runAs.userId,
  });
};

// ── collection.reindex ────────────────────────────────────────────────────

export type ReindexKind = "fts" | "vector" | "rollups";

/**
 * Rebuild a collection's derived data.
 *
 * Three kinds behind one type because they are the same operation from an
 * operator's point of view ("this collection's indexes are stale"), but the
 * gates behind them are NOT the same and the handler re-checks each one for
 * itself: `fts` and `vector` are admin-only DDL-adjacent work, while
 * `rollups` is `update` permission on the collection — a difference that is
 * invisible from the type name and would be lost if this trusted the enqueuer.
 */
const runReindexJob = async (
  ctx: Ctx,
  job: JobRow,
  tenantId: string,
  report: ProgressReporter,
): Promise<unknown> => {
  const runAs = requireRunAs(job.payload, job.type, tenantId);
  const p = job.payload as { slug?: string; kinds?: ReindexKind[] };
  if (!p.slug) throw new Error("collection.reindex job missing payload.slug");
  const kinds = Array.isArray(p.kinds) && p.kinds.length > 0 ? p.kinds : (["fts"] as ReindexKind[]);

  const needsAdmin = kinds.some((k) => k === "fts" || k === "vector");
  const auth = needsAdmin
    ? await resolveRunAsAdmin(ctx, runAs)
    : await resolveRunAsAuth(ctx, runAs);

  const collection = await loadCollection(ctx, tenantId, p.slug);
  const out: Record<string, unknown> = {};

  for (const kind of kinds) {
    if (kind === "fts") {
      await report({ done: 0, total: null, phase: "fts", note: collection.slug });
      out.fts = await reindexFts(ctx, collection, tenantId);
    } else if (kind === "vector") {
      out.vector = await reindexVector(ctx, collection, tenantId, report);
    } else {
      // `POST /{slug}/rollups/refresh` is gated on `update`, not on admin. The
      // job asks the same question again — and asks it of the DATABASE, not of
      // the payload, so a grant revoked while the job waited is felt.
      const perm = await resolvePermission(ctx, auth, collection.slug, "update");
      if (!perm.allowed) {
        throw new AppError(
          "FORBIDDEN",
          `No permission to update "${collection.slug}" — the grant that queued this rollup refresh is gone.`,
        );
      }
      await report({ done: 0, total: null, phase: "rollups", note: collection.slug });
      out.rollups = await refreshCollectionRollups(ctx, tenantId, collection);
    }
  }

  await recordActivity(ctx, {
    userId: runAs.userId,
    tenantId,
    action: "update",
    collection: "system_collections",
    itemId: collection.slug,
    payload: { reindex: kinds, jobId: job.id, ...out },
  });
  return out;
};

const reindexFts = async (
  ctx: Ctx,
  collection: Awaited<ReturnType<typeof loadCollection>>,
  tenantId: string,
): Promise<unknown> => {
  const meta = {
    fts: collection.fts,
    physicalTable: collection.physicalTable,
    pkColumn: collection.pkColumn,
    fields: collection.fields,
    tenantScoped: collection.tenantScoped,
  };
  if (!meta.fts) {
    throw new AppError(
      "VALIDATION",
      `Collection "${collection.slug}" has full-text search disabled. Enable it on the collection first.`,
    );
  }
  if (!isSearchable(meta)) {
    throw new AppError(
      "VALIDATION",
      "No field is flagged `searchable: true`. Mark at least one text/longtext field as searchable.",
    );
  }
  return await backfillFts(ctx, meta, tenantId);
};

/**
 * The one that most needed to leave the request: one embedding provider call per
 * batch of 100, over every row, with no ceiling. Reports per batch, which is
 * also what keeps the lease alive on a collection big enough to matter.
 */
const reindexVector = async (
  ctx: Ctx,
  collection: Awaited<ReturnType<typeof loadCollection>>,
  tenantId: string,
  report: ProgressReporter,
): Promise<unknown> => {
  const meta = {
    slug: collection.slug,
    physicalTable: collection.physicalTable,
    vectorize: collection.vectorize,
    vectorizeModel: collection.vectorizeModel,
    fields: collection.fields,
  };
  if (!meta.vectorize) {
    throw new AppError(
      "VALIDATION",
      `Collection "${collection.slug}" has vectorize disabled. Enable it on the collection first.`,
    );
  }
  if (!isVectorizable(meta, ctx.env)) {
    throw new AppError(
      "VALIDATION",
      "No embedding model resolves for this collection, or no field is marked `vectorize: true`. " +
        "Pick a model (or set EMBEDDING_DEFAULT_MODEL) and flag at least one text/longtext field.",
    );
  }
  const tenantWhere = sql`${sql.identifier("tenant_id")} = ${tenantId}`;
  const totalRow = await queryAll<{ count: number | string | bigint }>(
    ctx,
    sql`SELECT COUNT(*) AS count FROM ${sql.identifier(collection.physicalTable)} WHERE ${tenantWhere}`,
  );
  const total = Number(totalRow[0]?.count ?? 0);

  let processed = 0;
  let skipped = 0;
  let offset = 0;
  const batchSize = 100;
  while (offset < total) {
    const batch = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} WHERE ${tenantWhere} ORDER BY ${sql.identifier("id")} LIMIT ${batchSize} OFFSET ${offset}`,
    );
    if (batch.length === 0) break;
    const upserted = await embedAndUpsertBatch(
      ctx,
      meta,
      tenantId,
      batch.map((row) => ({ id: row.id as string, row })),
    );
    processed += upserted;
    skipped += batch.length - upserted;
    offset += batch.length;
    await report({ done: offset, total, phase: "vector", note: collection.slug });
  }
  return { processed, skipped, total };
};

// ── geo.backfill ──────────────────────────────────────────────────────────

/**
 * Geocode a collection's missing points, continuing across claims.
 *
 * A backfill is unbounded by nature — a workspace can have any number of rows
 * without a point — and an edge isolate is not. So one claim runs a bounded
 * number of batches and, if there is more to do AND it made progress, queues its
 * own continuation. That is the `payments.reconcile` shape: durable, resumable,
 * and never one twenty-minute claim that a lease will steal out from under it.
 *
 * "Made progress" is the termination condition, and it has to be: a row the
 * provider could not place stays in scope forever, so a run that located
 * nothing would otherwise re-queue itself and re-spend the quota until the
 * attempt budget ran out.
 */
const runGeoBackfillJob = async (
  ctx: Ctx,
  job: JobRow,
  tenantId: string,
  report: ProgressReporter,
): Promise<unknown> => {
  const runAs = requireRunAs(job.payload, job.type, tenantId);
  const auth = await resolveRunAsAuth(ctx, runAs);
  const p = job.payload as { slug?: string; field?: string; batch?: number; pass?: number };
  if (!p.slug || !p.field) {
    throw new Error("geo.backfill job has an invalid payload");
  }
  requireGeocodeProvider(ctx.geocode.provider);

  // The row-level grant, resolved NOW. Not carried on the payload, and not
  // inherited from whoever pressed the button an hour ago.
  const perm = await resolvePermission(ctx, auth, p.slug, "update");
  if (!perm.allowed) {
    throw new AppError(
      "FORBIDDEN",
      `No permission to update "${p.slug}" — the grant that queued this backfill is gone.`,
    );
  }

  const collection = await loadCollection(ctx, tenantId, p.slug);
  const field = geoFieldOrThrow(collection, p.field);
  const result: GeoBackfillResult = await runGeoBackfill(ctx, {
    collection,
    field,
    batch: Math.min(p.batch ?? 50, 500),
    maxBatches: GEO_BATCHES_PER_RUN,
    permWhere: perm.whereSql,
    tenantId,
    roles: auth.roles,
    onProgress: report,
  });

  const pass = (p.pass ?? 1) + 1;
  let continued: string | null = null;
  if (result.remaining > 0 && result.located > 0) {
    const next = await enqueueJob(ctx, {
      type: "geo.backfill",
      queue: "ops",
      tenantId,
      payload: { ...p, pass, runAs },
      maxAttempts: MAX_ATTEMPTS["geo.backfill"],
    });
    continued = next.id;
  }

  await recordActivity(ctx, {
    userId: runAs.userId,
    tenantId,
    action: "update",
    collection: collection.slug,
    itemId: "__geocode__",
    payload: { ...result, field: p.field, jobId: job.id, pass, continued },
  });
  return { ...result, pass, continued };
};

export { MAX_ATTEMPTS, INLINE_GRACE_MS };
export type { RunAs };
