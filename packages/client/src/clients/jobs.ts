import type { Job, JobProgress, JobStatus } from "../types";
import type { ClientCore } from "../core";

/** A job is finished when it can no longer change on its own. `pending` and
 *  `active` can; these four cannot. */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
]);

export interface WaitForOptions {
  /** Gap between polls. Default 3s — the queue's own tick is 30-60s, so
   *  anything tighter mostly measures the network. */
  intervalMs?: number;
  /** Give up after this long and throw. Default 10 minutes. Giving up is not
   *  cancelling: the job keeps running, and `jobs.get` still has the answer. */
  timeoutMs?: number;
  /** Called on every poll that moved the job's progress on. */
  onProgress?: (progress: JobProgress, job: Job) => void;
  /** Abort the wait early. Same semantics as the timeout — the job is
   *  unaffected. */
  signal?: AbortSignal;
}

/** Durable background job queue (admin-scoped). See `createClient`. */
export interface JobsClient {
  /** Enqueue a durable background job. */
  enqueue(input: {
    type: "function" | "webhook.deliver";
    payload?: Record<string, unknown>;
    queue?: string;
    runAt?: string;
    maxAttempts?: number;
    priority?: number;
  }): Promise<{ id: string }>;
  /** List jobs (newest first), optionally filtered by queue/status. */
  list(q?: { queue?: string; status?: JobStatus; limit?: number }): Promise<{ jobs: Job[] }>;
  /** Fetch a single job by id. */
  get(id: string): Promise<Job>;
  /** Requeue a failed / dead-lettered / cancelled job. */
  retry(id: string): Promise<{ ok: boolean }>;
  /** Cancel a pending job. */
  cancel(id: string): Promise<{ ok: boolean }>;
  /** Delete a job row. */
  remove(id: string): Promise<{ ok: boolean }>;
  /**
   * Poll a job until it finishes, and hand back the final row.
   *
   * The counterpart to every `?async=1` route: those answer with a `jobId` and
   * nothing else, because the whole point is that the caller may leave. This is
   * for the caller that would rather wait — a script, a CI step, a CLI command.
   * It resolves on ANY terminal status, including `dead_letter`; a job that
   * failed is an answer, not an exception, and `lastError` says why. Only the
   * wait itself throws, on timeout or abort.
   */
  waitFor(id: string, options?: WaitForOptions): Promise<Job>;
}

export const makeJobs = (core: ClientCore): JobsClient => {
  const jobs: JobsClient = {
    /** Enqueue a durable background job. `type` is `function` (run a named
     *  function with `payload.name` + `payload.input`) or `webhook.deliver`.
     *  Jobs retry with backoff and dead-letter after `maxAttempts`. Pass
     *  `runAt` (ISO string) to schedule for later. Admin-scoped. */
    enqueue: (input: {
      type: "function" | "webhook.deliver";
      payload?: Record<string, unknown>;
      queue?: string;
      runAt?: string;
      maxAttempts?: number;
      priority?: number;
    }) => core.request<{ id: string }>("POST", "/api/jobs", input),
    /** List jobs (newest first), optionally filtered by queue/status. */
    list: (q?: { queue?: string; status?: JobStatus; limit?: number }) => {
      const params = new URLSearchParams();
      if (q?.queue) params.set("queue", q.queue);
      if (q?.status) params.set("status", q.status);
      if (q?.limit != null) params.set("limit", String(q.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return core.request<{ jobs: Job[] }>("GET", `/api/jobs${suffix}`);
    },
    /** Fetch a single job by id. */
    get: (id: string) => core.request<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`),
    /** Requeue a failed / dead-lettered / cancelled job to run again. */
    retry: (id: string) =>
      core.request<{ ok: boolean }>("POST", `/api/jobs/${encodeURIComponent(id)}/retry`),
    /** Cancel a pending job. */
    cancel: (id: string) =>
      core.request<{ ok: boolean }>("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`),
    /** Delete a job row. */
    remove: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `/api/jobs/${encodeURIComponent(id)}`),
    /** Poll until the job reaches a terminal status. See the interface. */
    waitFor: async (id: string, options: WaitForOptions = {}) => {
      const intervalMs = options.intervalMs ?? 3000;
      const timeoutMs = options.timeoutMs ?? 600_000;
      const deadline = Date.now() + timeoutMs;
      let lastSeen = "";
      for (;;) {
        if (options.signal?.aborted) {
          throw new Error(`Stopped waiting for job ${id}; it is still running.`);
        }
        const job = await jobs.get(id);
        if (job.progress && options.onProgress) {
          // Only on change, so a caller printing a line per callback does not
          // print the same line every three seconds for ten minutes.
          const stamp = JSON.stringify(job.progress);
          if (stamp !== lastSeen) {
            lastSeen = stamp;
            options.onProgress(job.progress, job);
          }
        }
        if (TERMINAL.has(job.status)) return job;
        if (Date.now() + intervalMs > deadline) {
          throw new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for job ${id} (still ${job.status}). It is still running — read it with jobs.get("${id}").`,
          );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };

  return jobs;
};
