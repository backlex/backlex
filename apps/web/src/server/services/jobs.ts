import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { buildContext } from "../context";
import { findByName } from "./functions";
import { runFunction } from "./sandbox";
import { deliverWebhookById } from "./webhooks";
import { recordActivity } from "./activity";

const SYSTEM_AUTH: AuthSubject = { userId: null, email: null, roles: [] };

/** Built-in handler discriminators. `function` runs a named user function in the
 *  sandbox; `webhook.deliver` re-attempts a single outbound webhook (so webhooks
 *  inherit the queue's retry + dead-letter). */
export type JobType = "function" | "webhook.deliver";

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
      RETURNING ${sql.identifier("id")},
                ${sql.identifier("tenant_id")} AS "tenantId",
                ${sql.identifier("queue")},
                ${sql.identifier("type")},
                ${sql.identifier("payload")},
                ${sql.identifier("status")},
                ${sql.identifier("priority")},
                ${sql.identifier("run_at")} AS "runAt",
                ${sql.identifier("attempts")},
                ${sql.identifier("max_attempts")} AS "maxAttempts"
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
  throw new Error(`unknown job type '${job.type}'`);
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
    const exhausted = job.attempts >= job.maxAttempts;
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

export { asMs };
