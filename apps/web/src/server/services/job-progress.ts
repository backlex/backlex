/**
 * How far a long-running job has got — and the lease heartbeat that keeps it
 * from being run twice.
 *
 * Those are one mechanism on purpose. The queue re-claims any job that has been
 * `active` longer than `JOB_LEASE_MS` (300s by default), because a job whose
 * isolate died has to come back somehow. The cron fires every minute. So a
 * backup, a restore or a reindex that takes more than five minutes — which is
 * the entire reason those moved onto the queue — would be claimed and started a
 * SECOND time while the first copy was still running, and neither copy would
 * know. Restamping `claimed_at` on every progress write is what says "still
 * alive"; a job that reports has a live lease, one that has genuinely stopped
 * reporting is genuinely reclaimable.
 *
 * Which is why the reporting cadence is a correctness constraint, not a
 * cosmetic one: **report at least once per lease window, and once per BATCH
 * rather than once per row.** A per-row write on a 100k-row walk costs more
 * than the walk; a walk that reports only at the end has no lease at all.
 */
import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";

export interface JobProgress {
  /** Units finished so far. Whatever the handler counts in — tables, batches,
   *  rows — as long as it matches `total`. */
  done: number;
  /** The denominator, or null when the walk genuinely cannot know its length
   *  until it reaches the end. A made-up total is worse than none: it renders
   *  as a percentage that is simply wrong. */
  total: number | null;
  /** Which part of a multi-part job is running (`"fts"`, `"vector"`, …). */
  phase?: string;
  /** The current unit, for a human reading the row: a table name, a slug. */
  note?: string;
}

/** What a handler is handed so it can report without knowing its own job id. */
export type ProgressReporter = (p: JobProgress) => Promise<void>;

/**
 * Persist a progress snapshot and restamp the lease.
 *
 * Best-effort by contract: a progress write that fails must never fail the work
 * it was describing. The cost of swallowing it is a stale reading in the admin;
 * the cost of throwing is a completed backup recorded as a failure.
 */
export const reportJobProgress = async (
  ctx: Ctx,
  jobId: string,
  progress: JobProgress,
): Promise<void> => {
  try {
    const t = ctx.dialect === "pg" ? pg.schema.jobs : sqlite.schema.jobs;
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await (ctx.db as any)
      .update(t)
      .set({ progress, updatedAt: now, claimedAt: now })
      .where(eq(t.id, jobId));
  } catch (e) {
    console.error(`[job:${jobId}] progress write failed`, e);
  }
};

/** Bind a reporter to one job. Handlers take this rather than a job id so they
 *  cannot write to the wrong row, and so a caller with no job (the synchronous
 *  route path) can pass a no-op instead of threading nulls. */
export const progressReporterFor = (ctx: Ctx, jobId: string): ProgressReporter =>
  (p) => reportJobProgress(ctx, jobId, p);

/** The reporter a synchronous caller passes: the work is identical, there is
 *  simply no row to write the answer onto. */
export const noProgress: ProgressReporter = async () => {};
