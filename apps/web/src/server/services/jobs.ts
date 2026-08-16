import { and, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AuthSubject } from "@backlex/core";
import type { PaymentRecordKind } from "@backlex/integrations/payments";
import type { Ctx } from "../context";
import type { DbCtx } from "./seed";
import type { Env } from "../env";
import { buildContext } from "../context";
import { findByName } from "./functions";
import { runFunction } from "./sandbox";
import { deliverWebhookById } from "./webhooks";
import { deliverIntegrationById } from "./integrations";
import { runSync } from "./integration-syncs";
import { pollListingBatchRow } from "./integration-listings";
import { runTask } from "./integration-tasks";
import { reconcileProvider } from "./payments";
import { publishEvent } from "./events";
import { recordActivity } from "./activity";
import type { JobProgress } from "./job-progress";

const SYSTEM_AUTH: AuthSubject = { userId: null, email: null, roles: [] };

/** Built-in handler discriminators. `function` runs a named user function in the
 *  sandbox; `webhook.deliver` re-attempts a single outbound webhook (so webhooks
 *  inherit the queue's retry + dead-letter); `payments.reconcile` walks a
 *  payment provider's API and upserts what it finds; `integration.sync` pulls a
 *  page of rows from a source integration into a collection; `agent.turn` runs one
 *  queued agent turn; `agent.distill_memory` extracts durable facts from a
 *  thread's recent transcript out of band. */
export type JobType =
  | "function"
  | "webhook.deliver"
  | "integration.deliver"
  | "integration.sync"
  | "integration.task"
  /** Ask a marketplace what became of a batch of listings. Its own type rather
   *  than a `sync` run because it is owed on batches, not on schedules — a
   *  manually published batch has no interval to ride on. */
  | "integration.listing-poll"
  | "agent.turn"
  | "payments.reconcile"
  | "agent.distill_memory"
  /** The long-running ADMIN operations. Everything above is integration or
   *  agent work the product queues for itself; these four are things a person
   *  presses a button for and then has to wait on. They ran inline in the
   *  request until this queue could carry them, which meant the six operations
   *  most likely to exceed a request deadline were the six with no retry, no
   *  cancel and no dead-letter. See `services/jobs-long-running.ts`. */
  | "db.backup"
  | "db.restore"
  | "collection.reindex"
  | "geo.backfill";

export type JobStatus =
  | "pending"
  | "active"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

export interface JobRow {
  id: string;
  tenantId: string | null;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  runAt: Date | number;
  attempts: number;
  maxAttempts: number;
  claimedAt: Date | number | null;
  lastError: string | null;
  result: unknown;
  /** See `services/job-progress.ts`. NULL = has not reported, which is NOT the
   *  same as 0%. */
  progress: JobProgress | null;
  createdAt: Date | number;
  updatedAt: Date | number;
  completedAt: Date | number | null;
}

export interface JobPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  batch: number;
  leaseMs: number;
}

const numEnv = (raw: string | undefined, fallback: number): number => {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const jobPolicy = (env: Env): JobPolicy => ({
  maxAttempts: numEnv(env.JOB_MAX_ATTEMPTS, 5),
  backoffBaseMs: numEnv(env.JOB_BACKOFF_BASE_MS, 60_000),
  backoffMaxMs: numEnv(env.JOB_BACKOFF_MAX_MS, 3_600_000),
  batch: numEnv(env.JOB_BATCH, 25) || 25,
  leaseMs: numEnv(env.JOB_LEASE_MS, 300_000),
});

/** Exponential backoff with ±10% jitter, capped at `backoffMaxMs`. `attempt`
 *  is the (already-incremented) attempt count, so the first retry waits one
 *  `base`. A zero base (tests) collapses to immediate re-run. */
export const backoffMs = (attempt: number, policy: JobPolicy): number => {
  if (policy.backoffBaseMs <= 0) return 0;
  const raw = policy.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(policy.backoffMaxMs, raw);
  const jitter = capped * 0.1 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
};

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.jobs : sqlite.schema.jobs;

/**
 * The whole row, aliased back to the camelCase `JobRow` shape.
 *
 * It is spelled out because Postgres claims with `UPDATE … RETURNING` while
 * SQLite claims with a plain `select()`, and the two have to hand `runHandler`
 * the SAME object. The pg list used to name ten columns, so `claimedAt`,
 * `lastError`, `result`, `progress` and the three timestamps were silently
 * `undefined` on Postgres and populated on SQLite. Nothing read them at the
 * time; a handler that resumes from `job.progress` would work on SQLite, start
 * from zero on Postgres, and the suite — which runs on SQLite — would agree
 * with it. `tests/job-row-parity.test.ts` pins the two shapes together.
 */
const JOB_RETURNING = sql`${sql.identifier("id")},
                ${sql.identifier("tenant_id")} AS "tenantId",
                ${sql.identifier("queue")},
                ${sql.identifier("type")},
                ${sql.identifier("payload")},
                ${sql.identifier("status")},
                ${sql.identifier("priority")},
                ${sql.identifier("run_at")} AS "runAt",
                ${sql.identifier("attempts")},
                ${sql.identifier("max_attempts")} AS "maxAttempts",
                ${sql.identifier("claimed_at")} AS "claimedAt",
                ${sql.identifier("last_error")} AS "lastError",
                ${sql.identifier("result")},
                ${sql.identifier("progress")},
                ${sql.identifier("created_at")} AS "createdAt",
                ${sql.identifier("updated_at")} AS "updatedAt",
                ${sql.identifier("completed_at")} AS "completedAt"`;

const nowFor = (dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? new Date() : Date.now();

const tsValue = (date: Date, dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? date : date.getTime();

const asMs = (v: Date | number | null | undefined): number =>
  v == null ? 0 : v instanceof Date ? v.getTime() : v;

export interface EnqueueInput {
  type: JobType;
  payload?: Record<string, unknown>;
  queue?: string;
  tenantId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  priority?: number;
}

export const enqueueJob = async (
  ctx: Ctx,
  input: EnqueueInput,
  policy: JobPolicy = jobPolicy(ctx.env),
): Promise<{ id: string }> => {
  const t = tableFor(ctx.dialect);
  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: input.tenantId ?? null,
    queue: input.queue ?? "default",
    type: input.type,
    payload: input.payload ?? {},
    status: "pending",
    priority: input.priority ?? 0,
    runAt: input.runAt ? tsValue(input.runAt, ctx.dialect) : now,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? policy.maxAttempts,
    claimedAt: null,
    lastError: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  return { id };
};

/**
 * Atomically claim up to `limit` due jobs, flipping them to `active`, stamping
 * `claimedAt`, and incrementing `attempts` (so a job whose isolate dies mid-run
 * still counts the try — the stale-lease reclaim below picks it up next tick
 * rather than retrying forever). Eligible = `run_at <= now` AND (`pending` OR a
 * stale `active` lease older than `leaseMs`).
 *
 * PG: one `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING` — race-free across
 * concurrent isolates. SQLite/D1: select candidates then guarded per-row
 * updates; the Bun tick is single-process serial so the window is nil (same
 * reasoning as `claimDueTasks`).
 */
export const claimDueJobs = async (
  ctx: Ctx,
  policy: JobPolicy,
): Promise<JobRow[]> => {
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  const staleCut = ctx.dialect === "pg"
    ? new Date(Date.now() - policy.leaseMs)
    : Date.now() - policy.leaseMs;

  if (ctx.dialect === "pg") {
    const jobsTbl = sql.identifier("jobs");
    const result = await (ctx.db as any).execute(sql`
      UPDATE ${jobsTbl}
      SET ${sql.identifier("status")} = 'active',
          ${sql.identifier("claimed_at")} = ${now},
          ${sql.identifier("updated_at")} = ${now},
          ${sql.identifier("attempts")} = ${sql.identifier("attempts")} + 1
      WHERE ${sql.identifier("id")} IN (
        SELECT ${sql.identifier("id")} FROM ${jobsTbl}
        WHERE ${sql.identifier("run_at")} <= ${now}
          AND (
            ${sql.identifier("status")} = 'pending'
            OR (${sql.identifier("status")} = 'active' AND ${sql.identifier("claimed_at")} <= ${staleCut})
          )
        ORDER BY ${sql.identifier("priority")} ASC, ${sql.identifier("run_at")} ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${policy.batch}
      )
      RETURNING ${JOB_RETURNING}
    `);
    const rows = Array.isArray(result) ? result : (result?.rows ?? []);
    return rows as JobRow[];
  }

  // SQLite: select eligible candidates, then claim each with a guarded update.
  // Cast columns to `any` — the pg|sqlite union types `runAt`/`claimedAt` as
  // `Date`, so `lte(col, number)` won't resolve (see CLAUDE.md dual-dialect note).
  const tt = t as any;
  const candidates = (await (ctx.db as any)
    .select()
    .from(t)
    .where(
      and(
        lte(tt.runAt, now as number),
        or(
          eq(tt.status, "pending"),
          and(eq(tt.status, "active"), lte(tt.claimedAt, staleCut as number)),
        ),
      ),
    )
    .orderBy(tt.priority, tt.runAt)
    .limit(policy.batch)) as JobRow[];
  if (candidates.length === 0) return [];

  const claimed: JobRow[] = [];
  for (const row of candidates) {
    await (ctx.db as any)
      .update(t)
      .set({ status: "active", claimedAt: now, updatedAt: now, attempts: row.attempts + 1 })
      .where(and(eq(t.id, row.id), eq(t.status, row.status)));
    claimed.push({ ...row, status: "active", attempts: row.attempts + 1 });
  }
  return claimed;
};

/**
 * Claim ONE job by id, and answer honestly about whether we won it.
 *
 * `claimDueJobs` picks work off the clock; this picks a job somebody just
 * enqueued and wants started now, without waiting up to a minute for the next
 * tick. The two race by construction, so unlike `claimDueJobs`'s SQLite arm —
 * which is allowed to assume its guarded update succeeded, because the Bun tick
 * is a single serial process — this one has to CHECK. It re-reads the row and
 * only claims the job if the claim it just wrote is the one that is there.
 *
 * Returns null when somebody else already has it, when it was cancelled in the
 * meantime, or when it is not `pending` for any other reason. Null means "do
 * nothing", never "run it anyway": a second copy of a restore or an import is
 * the failure this exists to prevent.
 */
export const claimJobById = async (ctx: Ctx, id: string): Promise<JobRow | null> => {
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);

  if (ctx.dialect === "pg") {
    const jobsTbl = sql.identifier("jobs");
    const result = await (ctx.db as any).execute(sql`
      UPDATE ${jobsTbl}
      SET ${sql.identifier("status")} = 'active',
          ${sql.identifier("claimed_at")} = ${now},
          ${sql.identifier("updated_at")} = ${now},
          ${sql.identifier("attempts")} = ${sql.identifier("attempts")} + 1
      WHERE ${sql.identifier("id")} = ${id}
        AND ${sql.identifier("status")} = 'pending'
      RETURNING ${JOB_RETURNING}
    `);
    const rows = (Array.isArray(result) ? result : (result?.rows ?? [])) as JobRow[];
    return rows[0] ?? null;
  }

  const before = await getJob(ctx, id);
  if (!before || before.status !== "pending") return null;
  await (ctx.db as any)
    .update(t)
    .set({
      status: "active",
      claimedAt: now,
      updatedAt: now,
      attempts: before.attempts + 1,
    })
    .where(and(eq(t.id, id), eq(t.status, "pending")));
  // Read back rather than assume. Two writers cannot both satisfy
  // `status = 'pending'` — SQLite serializes writes — but only the row can say
  // which of them did, and `claimedAt` is what it says it with.
  const after = await getJob(ctx, id);
  if (!after || after.status !== "active" || asMs(after.claimedAt) !== asMs(now)) {
    return null;
  }
  return after;
};

/**
 * Start a job the moment it is enqueued, rather than waiting for the tick.
 *
 * The queue's own cadence is 30-60 seconds, which is right for retries and
 * wrong for "I pressed Reindex". Same shape as the agent path
 * (`services/agents/async-run.ts`): the durable row is the source of truth and
 * the scheduled tick is the safety net for an isolate that died — this is only
 * the fast start. Never throws; a failure is already persisted on the row by
 * `runJob`, and this runs detached on `waitUntil` where a rejection has nobody
 * to catch it.
 */
export const runJobInline = async (ctx: Ctx, id: string): Promise<void> => {
  try {
    const job = await claimJobById(ctx, id);
    if (!job) return;
    await runJob(ctx, job, jobPolicy(ctx.env));
  } catch (e) {
    console.error(`[job:${id}] inline start failed`, e);
  }
};

/** Dispatch a claimed job to its handler. Handlers throw on failure so the
 *  caller drives retry / dead-letter. */
const runHandler = async (ctx: Ctx, job: JobRow): Promise<unknown> => {
  if (job.type === "function") {
    const name = typeof job.payload.name === "string" ? job.payload.name : "";
    if (!name) throw new Error("function job missing payload.name");
    if (!job.tenantId) throw new Error("function job missing tenantId");
    const fn = await findByName(ctx, job.tenantId, name);
    if (!fn) throw new Error(`function '${name}' not found`);
    const result = await runFunction(
      fn.code,
      { ctx, auth: { ...SYSTEM_AUTH, tenantId: job.tenantId } },
      job.payload.input ?? {},
      fn.timeoutMs,
    );
    if (!result.ok) throw new Error(result.error ?? "function failed");
    return result.value;
  }
  if (job.type === "webhook.deliver") {
    const p = job.payload as {
      webhookId?: string;
      channel?: string;
      event?: string;
      body?: string;
    };
    if (!p.webhookId || !p.channel || !p.event || typeof p.body !== "string") {
      throw new Error("webhook.deliver job has an invalid payload");
    }
    const out = await deliverWebhookById(ctx, {
      webhookId: p.webhookId,
      tenantId: job.tenantId,
      channel: p.channel,
      event: p.event,
      body: p.body,
      attempt: job.attempts,
    });
    if (out.status < 200 || out.status >= 300) {
      throw new Error(`webhook responded ${out.status}${out.error ? `: ${out.error}` : ""}`);
    }
    return { status: out.status };
  }
  if (job.type === "integration.deliver") {
    const p = job.payload as {
      integrationId?: string;
      message?: {
        event?: string;
        text?: string;
        payload?: Record<string, unknown>;
        record?: Record<string, unknown> | null;
      };
    };
    const m = p.message;
    if (!p.integrationId || !m || typeof m.event !== "string" || typeof m.text !== "string") {
      throw new Error("integration.deliver job has an invalid payload");
    }
    const out = await deliverIntegrationById(ctx.env, ctx, {
      integrationId: p.integrationId,
      tenantId: job.tenantId,
      // `record` is carried through only when the enqueuer put it there —
      // `deliverOne` re-checks the provider before it reaches one.
      message: { event: m.event, text: m.text, payload: m.payload ?? {}, ...(m.record ? { record: m.record } : {}) },
      attempt: job.attempts,
    });
    // A provider failure is thrown so the queue retries with backoff; the
    // breaker in deliverOne independently pauses a target that stays dead.
    if (!out.ok) throw new Error(`integration responded ${out.status}`);
    return { status: out.status, skipped: out.skipped ?? false };
  }
  if (job.type === "integration.task") {
    const p = job.payload as {
      integrationId?: string;
      task?: string;
      collection?: string;
      itemId?: string;
      settings?: Record<string, unknown>;
      outputMapping?: Record<string, string>;
    };
    if (!p.integrationId || !p.task || !p.collection || !p.itemId) {
      throw new Error("integration.task job has an invalid payload");
    }
    // Every query in runTask is scoped by this, so a job without a tenant has
    // nothing to scope by and must not fall through to "global".
    if (!job.tenantId) throw new Error("integration.task job missing tenantId");
    // `force` is deliberately NOT accepted from the payload. A retry of a
    // queued task must never be the thing that books a second shipment —
    // re-running one that succeeded is an explicit human decision, not
    // something a backoff can take on its own.
    const out = await runTask(ctx, job.tenantId, {
      integrationId: p.integrationId,
      task: p.task,
      collection: p.collection,
      itemId: p.itemId,
      settings: p.settings,
      outputMapping: p.outputMapping,
    });
    return { status: out.status, reused: out.reused };
  }
  if (job.type === "integration.sync") {
    const p = job.payload as { syncId?: string };
    if (!p.syncId) throw new Error("integration.sync job missing payload.syncId");
    // Every subsequent query in runSync is scoped by this, so a job without a
    // tenant has nothing to scope by and must not fall through to "global".
    if (!job.tenantId) throw new Error("integration.sync job missing tenantId");
    const out = await runSync(ctx, job.tenantId, p.syncId);
    return { written: out.written, pages: out.pages, complete: out.complete };
  }
  if (job.type === "integration.listing-poll") {
    const p = job.payload as { batchId?: string };
    if (!p.batchId) throw new Error("integration.listing-poll job missing payload.batchId");
    // The verdict is written into a workspace's collection, so a job without a
    // tenant has nothing to scope by and must not fall through to "global".
    if (!job.tenantId) throw new Error("integration.listing-poll job missing tenantId");
    const out = await pollListingBatchRow(ctx, job.tenantId, p.batchId);
    return { applied: out.applied, pending: out.pending, closed: out.closed };
  }
  if (job.type === "payments.reconcile") {
    const p = job.payload as {
      providerId?: string;
      kinds?: PaymentRecordKind[];
      maxPages?: number;
      resume?: boolean;
    };
    if (!p.providerId) throw new Error("payments.reconcile job missing payload.providerId");
    if (!job.tenantId) throw new Error("payments.reconcile job missing tenantId");
    const out = await reconcileProvider(ctx, job.tenantId, {
      providerId: p.providerId,
      kinds: p.kinds,
      maxPages: p.maxPages,
      // A queued reconcile always resumes: the scheduled sweep runs it
      // repeatedly, and restarting from the top each night would re-walk the
      // whole account for nothing.
      resume: p.resume ?? true,
    });
    // A provider-side failure is thrown so the queue retries with backoff
    // rather than recording a silent success.
    if (out.error) throw new Error(`reconcile failed: ${out.error}`);
    return out;
  }
  if (job.type === "agent.turn") {
    // An agent turn re-enters the API to call its tools, so it needs the Hono
    // app. Imported lazily to keep `app.ts → routes → jobs` acyclic, the same
    // way the app defers its own optional route modules.
    const [{ createApp }, { runQueuedAgentTurn }] = await Promise.all([
      import("../app"),
      import("./agents/async-run"),
    ]);
    const app = createApp(ctx.env) as unknown as Parameters<
      typeof runQueuedAgentTurn
    >[1];
    const out = await runQueuedAgentTurn(ctx, app, job.payload);
    // A turn is not idempotent, so a refusal is reported, never retried — the
    // `agent_runs` row already carries the failure the room is watching.
    return out;
  }
  if (job.type === "agent.distill_memory") {
    // Reading the transcript and extracting durable facts is an extra LLM call,
    // so it happens here rather than inside the turn the user is waiting on.
    const p = job.payload as {
      agentId?: string;
      threadId?: string;
      scope?: string;
      model?: string | null;
    };
    if (!p.agentId || !p.threadId) {
      throw new Error("agent.distill_memory job has an invalid payload");
    }
    const { distillSemantic, parseMemoryScope } = await import("./agents/memory");
    return await distillSemantic(ctx, {
      tenantId: job.tenantId,
      agentId: p.agentId,
      threadId: p.threadId,
      scope: parseMemoryScope(p.scope),
      model: p.model ?? null,
    });
  }
  if (
    job.type === "db.backup" ||
    job.type === "db.restore" ||
    job.type === "collection.reindex" ||
    job.type === "geo.backfill"
  ) {
    // Every one of these is scoped to a workspace — a dump, a restore, an index
    // rebuild, a column of addresses. A job without a tenant has nothing to
    // scope by and must not fall through to "global", the same rule the
    // integration and agent branches above state.
    if (!job.tenantId) throw new Error(`${job.type} job missing tenantId`);
    // Lazy, to keep `jobs → jobs-long-running → jobs` acyclic: the handlers
    // enqueue continuations, so they import `enqueueJob` from this module.
    const { runLongRunningJob } = await import("./jobs-long-running");
    return await runLongRunningJob(ctx, job);
  }
  throw new Error(`unknown job type '${job.type}'`);
};

/**
 * Codes that describe the REQUEST, not the weather.
 *
 * `AppError` carries the same taxonomy the HTTP layer maps to 4xx, and a 4xx is
 * by definition something a retry cannot change: the payload names a collection
 * that has no searchable field, the caller's grant is gone, the backup id does
 * not exist. Deliberately narrow — `INTERNAL`, `UNAVAILABLE` and anything that
 * is not an `AppError` at all (a driver blip, a provider timeout, an evicted
 * isolate) keep the full backoff, because those are exactly what retries are
 * for.
 */
const PERMANENT_CODES = new Set(["VALIDATION", "FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"]);

const isPermanentFailure = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && PERMANENT_CODES.has(code);
};

/** Run one claimed job and persist the outcome (succeeded / requeued-with-backoff
 *  / dead_letter). Never throws — failures are recorded on the row. */
export const runJob = async (
  ctx: Ctx,
  job: JobRow,
  policy: JobPolicy,
): Promise<JobStatus> => {
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  try {
    const value = await runHandler(ctx, job);
    await (ctx.db as any)
      .update(t)
      .set({
        status: "succeeded",
        result: value ?? null,
        lastError: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(t.id, job.id));
    await recordActivity(ctx, {
      userId: null,
      tenantId: job.tenantId,
      action: "job.succeeded",
      collection: "jobs",
      itemId: job.id,
      payload: { type: job.type, queue: job.queue, attempts: job.attempts },
    });
    return "succeeded";
  } catch (e) {
    const message = (e as Error).message ?? "job failed";
    // A deterministic refusal is not a transient failure, and backing off from
    // it three times is a minute of waiting per attempt to be told the same
    // thing. A collection with no searchable field will not have one in sixty
    // seconds; a grant that was revoked will not come back on its own. So these
    // dead-letter on the first hearing, where the operator can see the reason,
    // and `retryJob` is still there for once the cause is actually fixed.
    const exhausted = job.attempts >= job.maxAttempts || isPermanentFailure(e);
    if (exhausted) {
      await (ctx.db as any)
        .update(t)
        .set({ status: "dead_letter", lastError: message, completedAt: now, updatedAt: now })
        .where(eq(t.id, job.id));
    } else {
      const next = new Date(Date.now() + backoffMs(job.attempts, policy));
      await (ctx.db as any)
        .update(t)
        .set({
          status: "pending",
          lastError: message,
          claimedAt: null,
          runAt: tsValue(next, ctx.dialect),
          updatedAt: now,
        })
        .where(eq(t.id, job.id));
    }
    await recordActivity(ctx, {
      userId: null,
      tenantId: job.tenantId,
      action: exhausted ? "job.dead_letter" : "job.failed",
      collection: "jobs",
      itemId: job.id,
      payload: { type: job.type, queue: job.queue, attempts: job.attempts, error: message },
    });
    // A dead-lettered job is otherwise only visible in the activity feed. Push
    // it onto the `system` event channel too so operators can wire a proactive
    // alert (a webhook → Slack/PagerDuty, a flow, an event function) instead of
    // polling. Guards:
    //  - `webhook.deliver` jobs are excluded: their failures already show up in
    //    the delivery log + auto-disable, and re-publishing would let a down
    //    alert endpoint feed its own dead-letter back into the channel in a loop.
    //  - Only tenant-scoped jobs publish. A null-tenant (system/maintenance) job
    //    would fan out UNSCOPED in dispatchWebhooks — i.e. to EVERY tenant's
    //    `system:*` webhook — leaking failure metadata across tenants. Those
    //    stay in the activity feed (+ cloud report) only.
    //  - Best-effort: publishEvent awaits a DO fetch that can reject on Workers;
    //    runJob's contract is "never throws", so a failed alert must not break it.
    if (exhausted && job.type !== "webhook.deliver" && job.tenantId) {
      try {
        await publishEvent(
          ctx.env,
          "system",
          {
            event: "job.dead_letter",
            data: {
              jobId: job.id,
              type: job.type,
              queue: job.queue,
              tenantId: job.tenantId,
              attempts: job.attempts,
              error: message,
            },
          },
          { db: ctx.db, dialect: ctx.dialect, fullCtx: ctx, tenantId: job.tenantId },
        );
      } catch {
        /* alert is best-effort — the dead_letter activity row is the record */
      }
    }
    return exhausted ? "dead_letter" : "pending";
  }
};

/** Drain the queue for one tick: claim a batch and run them concurrently.
 *  Called from `cronTick` with the already-built ctx. */
export const processJobs = async (ctx: Ctx): Promise<void> => {
  const policy = jobPolicy(ctx.env);
  let claimed: JobRow[];
  try {
    claimed = await claimDueJobs(ctx, policy);
  } catch (e) {
    console.error("[jobs] claim failed", e);
    return;
  }
  await Promise.all(
    claimed.map(async (job) => {
      try {
        await runJob(ctx, job, policy);
      } catch (e) {
        console.error(`[job:${job.id}] crashed`, e);
      }
    }),
  );
};

/** Entry used by runtimes that don't already hold a ctx (none today — kept for
 *  symmetry with cronTick's standalone callers). */
export const processJobsWithEnv = async (env: Env): Promise<void> => {
  const ctx = await buildContext(env);
  await processJobs(ctx);
};

// ── Admin / API surface ───────────────────────────────────────────────────

export interface ListJobsInput {
  tenantId?: string | null;
  queue?: string;
  status?: JobStatus;
  limit?: number;
}

export const listJobs = async (ctx: Ctx, input: ListJobsInput): Promise<JobRow[]> => {
  const t = tableFor(ctx.dialect);
  const conds = [] as unknown[];
  if (input.tenantId !== undefined) conds.push(eq(t.tenantId, input.tenantId as any));
  if (input.queue) conds.push(eq(t.queue, input.queue));
  if (input.status) conds.push(eq(t.status, input.status));
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const q = (ctx.db as any).select().from(t);
  const rows = (await (conds.length ? q.where(and(...(conds as any))) : q)
    .orderBy(desc(t.createdAt))
    .limit(limit)) as JobRow[];
  return rows;
};

export const getJob = async (
  ctx: Ctx,
  id: string,
  tenantId?: string | null,
): Promise<JobRow | null> => {
  const t = tableFor(ctx.dialect);
  const where = tenantId !== undefined
    ? and(eq(t.id, id), eq(t.tenantId, tenantId as any))
    : eq(t.id, id);
  const rows = (await (ctx.db as any).select().from(t).where(where).limit(1)) as JobRow[];
  return rows[0] ?? null;
};

/** Requeue a failed / dead-lettered job: reset to pending, clear attempts, run
 *  immediately. No-op (returns false) for jobs that are pending/active/succeeded. */
export const retryJob = async (
  ctx: Ctx,
  id: string,
  tenantId?: string | null,
): Promise<boolean> => {
  const job = await getJob(ctx, id, tenantId);
  if (!job || (job.status !== "failed" && job.status !== "dead_letter" && job.status !== "cancelled")) {
    return false;
  }
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({ status: "pending", attempts: 0, claimedAt: null, lastError: null, runAt: now, updatedAt: now, completedAt: null })
    .where(eq(t.id, id));
  return true;
};

/** Cancel a not-yet-run job. Only `pending` jobs can be cancelled. */
export const cancelJob = async (
  ctx: Ctx,
  id: string,
  tenantId?: string | null,
): Promise<boolean> => {
  const job = await getJob(ctx, id, tenantId);
  if (!job || job.status !== "pending") return false;
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({ status: "cancelled", claimedAt: null, completedAt: now, updatedAt: now })
    .where(eq(t.id, id));
  return true;
};

export const purgeJob = async (
  ctx: Ctx,
  id: string,
  tenantId?: string | null,
): Promise<boolean> => {
  const job = await getJob(ctx, id, tenantId);
  if (!job) return false;
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
  return true;
};

/**
 * Delete finished job rows past their retention window.
 *
 * Nothing pruned this table before, so on a busy workspace it outgrew the user
 * data — and on D1 that is the whole database. Two clocks, because the rows
 * answer different questions: a `succeeded` job is bookkeeping, a `failed` or
 * `dead_letter` one is forensics somebody may still need to read.
 *
 * **`pending` and `active` are never touched at any setting.** A delayed or
 * scheduled job legitimately carries an old `created_at` and a future `run_at`,
 * so a status-blind DELETE here would quietly eat a customer's scheduled work —
 * the one failure mode of this function that would not look like a bug.
 *
 * Filters on `updated_at`, not `completed_at`: `completed_at` is nullable, and a
 * NULL never satisfies `<`, so a terminal row that somehow missed it would be
 * kept forever. `updated_at` is NOT NULL and, for a terminal job, is when it
 * terminated.
 *
 * Same signature and failure shape as `pruneOldSpans` — a retention of `0` (or
 * negative) disables that arm, and a DB error is logged and reported rather
 * than thrown, so one bad prune cannot wedge the daily sweep.
 */
export const pruneFinishedJobs = async (
  ctx: DbCtx,
  retentionDays: number,
  deadLetterRetentionDays: number,
): Promise<{ ok: boolean; finished: boolean; failed: boolean }> => {
  const t = tableFor(ctx.dialect);
  const out = { ok: true, finished: false, failed: false };

  const sweep = async (statuses: string[], days: number): Promise<boolean> => {
    const d = Math.floor(days);
    if (!Number.isFinite(d) || d <= 0) return false;
    const cutoff = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    await (ctx.db as any)
      .delete(t)
      .where(and(inArray(t.status, statuses), lt(t.updatedAt, cutoff)));
    return true;
  };

  try {
    out.finished = await sweep(["succeeded", "cancelled"], retentionDays);
    out.failed = await sweep(["failed", "dead_letter"], deadLetterRetentionDays);
  } catch (e) {
    console.error("[jobs] prune failed", e);
    out.ok = false;
  }
  return out;
};

export { asMs };
