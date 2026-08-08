import type { Job, JobStatus } from "../types";
import type { ClientCore } from "../core";

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
  };

  return jobs;
};
