/**
 * The MCP Tasks extension (`io.modelcontextprotocol/tasks`).
 *
 * Not every tool call returns in time. A client and the intermediaries between
 * it and us both impose timeouts, so an operation measured in minutes cannot be
 * a held-open connection — it has to be a durable handle the client polls.
 *
 * **This server does not need a task table, and that is the whole design.** The
 * extension is the protocol shape of something already here: two durable,
 * tenant-scoped run records that outlive any connection.
 *
 *   `run:<id>`  →  `agent_runs`, one agent turn
 *   `job:<id>`  →  the durable job queue
 *
 * The id carries its own kind so `tasks/get` knows which store to read without a
 * lookup table, and so a third handle can be added later without a migration.
 * The spec blesses exactly this: *"if your server wraps an API that already uses
 * job IDs, return a task when you create the job."*
 *
 * ## The rule that matters most
 *
 * **Never hand a task to a client that did not ask for one.** A `CreateTaskResult`
 * is a different result shape; a client that has not opted in will read
 * `resultType: "task"` as a failed call, or worse, as the answer. Opt-in is
 * per-request, in `_meta`, and `clientWantsTasks` is the only gate — a tool must
 * not decide this for itself.
 */
import { getJob, cancelJob, type JobStatus } from "../services/jobs";
import { getRun } from "../services/agents/store";
import type { Ctx } from "../context";
import { MCP_META } from "./protocol";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** `working` and `input_required` are live; the other three are terminal — once
 *  reached, a task's state does not change. */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  /** How long the handle stays resolvable. Both stores keep their rows well
   *  past this; the number is a hint for how long a client should bother. */
  ttlMs: number;
  /** What to wait between polls. Sized to how fast the underlying thing moves:
   *  an agent turn changes on the order of seconds. */
  pollIntervalMs: number;
  /** Present only on `completed` — what the original call would have returned. */
  result?: unknown;
  /** Present only on `failed` — a JSON-RPC error object. */
  error?: { code: number; message: string };
}

const TTL_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 2_000;

/**
 * Did this request opt in? Per-request, from `_meta`, and never inferred.
 *
 * `2026-07-28` moved capabilities out of a handshake and into every request, so
 * this is read fresh each time rather than remembered — which is also why a
 * server cannot cache "this client does tasks" across calls.
 */
export const clientWantsTasks = (body: { params?: unknown }): boolean => {
  const params = body.params as { _meta?: Record<string, unknown> } | undefined;
  const caps = params?._meta?.[MCP_META.clientCapabilities] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return Boolean(caps?.extensions && TASKS_EXTENSION in caps.extensions);
};

/** The handle a `CreateTaskResult` carries. */
export const taskIdForRun = (runId: string): string => `run:${runId}`;
export const taskIdForJob = (jobId: string): string => `job:${jobId}`;

const parseTaskId = (taskId: string): { kind: "run" | "job"; id: string } | null => {
  const at = taskId.indexOf(":");
  if (at < 1) return null;
  const kind = taskId.slice(0, at);
  const id = taskId.slice(at + 1);
  if (!id || (kind !== "run" && kind !== "job")) return null;
  return { kind, id };
};

/** `agent_runs.status` → task status. `queued` and `running` are both `working`:
 *  the distinction is ours, not the client's, and it belongs in the message. */
const fromRunStatus = (s: "queued" | "running" | "done" | "error"): TaskStatus =>
  s === "done" ? "completed" : s === "error" ? "failed" : "working";

/** Job status → task status. `dead_letter` is `failed`: from the client's side a
 *  job that exhausted its retries has failed, and saying `cancelled` would imply
 *  somebody chose it. */
const fromJobStatus = (s: JobStatus): TaskStatus =>
  s === "succeeded"
    ? "completed"
    : s === "failed" || s === "dead_letter"
      ? "failed"
      : s === "cancelled"
        ? "cancelled"
        : "working";

const base = (taskId: string, status: TaskStatus, statusMessage?: string): Task => ({
  taskId,
  status,
  ...(statusMessage ? { statusMessage } : {}),
  ttlMs: TTL_MS,
  pollIntervalMs: POLL_MS,
});

/**
 * Read one task. Returns `null` when the handle names nothing this caller may
 * see — an unknown id and another workspace's id are deliberately the same
 * answer, so a task id cannot be used to probe for existence.
 */
export const getTask = async (
  ctx: Ctx,
  tenantId: string | null,
  taskId: string,
): Promise<Task | null> => {
  const parsed = parseTaskId(taskId);
  if (!parsed || !tenantId) return null;

  if (parsed.kind === "run") {
    const run = await getRun(ctx, parsed.id, tenantId);
    if (!run) return null;
    const status = fromRunStatus(run.status);
    const task = base(taskId, status, `agent run is ${run.status}`);
    if (status === "failed") {
      task.error = { code: -32603, message: run.error ?? "the turn failed" };
    }
    if (status === "completed") {
      // The turn's own record is the result. A client that polled instead of
      // blocking gets the same thing a blocking caller would have.
      task.result = { runId: run.id, status: run.status };
    }
    return task;
  }

  const job = await getJob(ctx, parsed.id, tenantId);
  if (!job) return null;
  const status = fromJobStatus(job.status);
  const task = base(taskId, status, `job is ${job.status}`);
  if (status === "failed") {
    task.error = { code: -32603, message: job.lastError ?? `job ${job.status}` };
  }
  if (status === "completed") task.result = { jobId: job.id, status: job.status };
  return task;
};

/**
 * Cancellation is cooperative by contract: acknowledge the intent, honour it
 * where the underlying store can, and do not promise the work stopped. An agent
 * turn is deliberately NOT cancellable — its tool calls have already happened,
 * and `async-run.ts` refuses to replay a turn for the same reason.
 */
export const cancelTask = async (
  ctx: Ctx,
  tenantId: string | null,
  taskId: string,
): Promise<boolean> => {
  const parsed = parseTaskId(taskId);
  if (!parsed || !tenantId) return false;
  if (parsed.kind === "job") {
    try {
      await cancelJob(ctx, parsed.id, tenantId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
};
