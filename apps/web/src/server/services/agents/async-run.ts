/**
 * Running an agent turn **after** the request that asked for it has answered.
 *
 * Why async at all: a room can wake several agents with one message, and a turn
 * is a multi-step loop against an LLM. Holding the HTTP response open for the
 * slowest of N turns makes the composer feel broken, and on an edge runtime it
 * risks the response deadline outright.
 *
 * How it runs: the route enqueues a durable `agent.turn` job and then starts it
 * **inline** via `waitUntil`, so the common case has no queue latency at all.
 * The scheduled tick is only the safety net for a turn whose isolate died — and
 * because a turn is NOT idempotent (its tool calls can have side effects), the
 * recovery path never replays one. `agent_runs.status` is the guard: a job only
 * runs a turn it finds still `queued`, and anything else is failed, not redone.
 *
 * How it authenticates: the enqueuing user's id travels on the job, and the
 * worker mints a short-lived agent-run token to re-enter the API with (see
 * `lib/jwt`). Roles are resolved from the DB on every sub-request, so the turn
 * can never exceed the starting USER's permissions — that is the guarantee that
 * makes agent tool calls safe.
 *
 * Re-entering as the user answers "whose permissions", but not "under which MCP
 * guards" — a run token carries no API key, and by the time this runs the
 * calling credential is gone. So the caller's effective guards are stamped onto
 * the payload at enqueue time and enforced from there. Without that, a
 * read-only credential (including an OAuth token granted `mcp:read` but not
 * `mcp:write`) could write through an agent by asking it to. See the caution in
 * `docs/agents.md` and `tests/agent-guard-contract.test.ts`.
 */
import type { Hono } from "hono";
import { signAgentRunToken } from "../../lib/jwt";
import type { KeyGuards } from "../../mcp/guards";
import { makeDetachedFetch } from "../../mcp/internal-fetch";
import type { Ctx } from "../../context";
import { enqueueJob } from "../jobs";
import { runAgentTurn } from "./runner";
import { getRun, setRunJobId, setRunStatus, syncThreadStatus } from "./store";

/** What an `agent.turn` job carries. `runAs` is stamped from the enqueuing
 *  request — a client never supplies it. */
export interface AgentTurnPayload {
  runId: string;
  threadId: string;
  agentId: string;
  message: string;
  runAs: { userId: string; tenantId: string };
  /** The caller's effective MCP guards, stamped from the enqueuing request.
   *  A client never supplies this either — it is read off the server-resolved
   *  `c.var.auth`, so it cannot be widened from outside. */
  guards: KeyGuards;
  /** Origin used to build sub-request URLs. Only the URL is derived from it —
   *  the sub-fetch never leaves the process. */
  origin: string;
}

export const AGENT_TURN_JOB = "agent.turn" as const;

const isKeyGuards = (g: unknown): g is KeyGuards => {
  const v = g as Partial<KeyGuards> | null;
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof v.readOnly === "boolean" &&
      (v.allowlist === null || Array.isArray(v.allowlist)) &&
      (v.roleAllowlist == null || Array.isArray(v.roleAllowlist)),
  );
};

const isAgentTurnPayload = (p: unknown): p is AgentTurnPayload => {
  const v = p as Partial<AgentTurnPayload> | null;
  return Boolean(
    v &&
      typeof v.runId === "string" &&
      typeof v.threadId === "string" &&
      typeof v.agentId === "string" &&
      typeof v.message === "string" &&
      v.runAs &&
      typeof v.runAs.userId === "string" &&
      typeof v.runAs.tenantId === "string" &&
      // A payload written before guards were carried has none. Refusing it
      // rather than defaulting to unrestricted is the safe direction: the only
      // such rows are queued turns spanning the deploy, and a refused turn is
      // visible on its `agent_runs` row while a silently-unguarded one is not.
      isKeyGuards(v.guards),
  );
};

/**
 * Queue one agent's turn. `maxAttempts: 1` is deliberate: a turn that dies
 * mid-flight must fail visibly rather than re-run its tool calls.
 */
export const enqueueAgentTurn = async (
  ctx: Ctx,
  payload: AgentTurnPayload,
): Promise<{ jobId: string }> => {
  const { id } = await enqueueJob(ctx, {
    type: AGENT_TURN_JOB,
    queue: "agents",
    tenantId: payload.runAs.tenantId,
    payload: payload as unknown as Record<string, unknown>,
    maxAttempts: 1,
  });
  await setRunJobId(ctx, payload.runId, id);
  return { jobId: id };
};

/**
 * Execute a queued turn. Shared by the inline `waitUntil` path and the job
 * dispatcher, so both take the same status guard and the same identity.
 *
 * Never throws: a failed turn is recorded on its `agent_runs` row (and streamed
 * to the room as `agent.error`), which is what clients watch. Throwing would
 * only make the job queue retry work that must not be retried.
 */
export const runQueuedAgentTurn = async (
  ctx: Ctx,
  app: Hono,
  payload: unknown,
): Promise<{ ok: boolean; reason?: string }> => {
  if (!isAgentTurnPayload(payload)) {
    return { ok: false, reason: "invalid agent.turn payload" };
  }
  const { runId, threadId, agentId, message, runAs, guards, origin } = payload;

  const run = await getRun(ctx, runId, runAs.tenantId);
  if (!run) return { ok: false, reason: "run not found" };
  if (run.status !== "queued") {
    // Either it's already running (the inline path won the race and this is the
    // scheduled tick catching up) or its isolate died mid-turn. Neither may be
    // replayed — the tool calls of a half-finished turn already happened.
    if (run.status === "running") {
      await setRunStatus(ctx, runId, "error", "the turn stopped before finishing");
      await syncThreadStatus(ctx, threadId);
    }
    return { ok: false, reason: `run is ${run.status}` };
  }

  const token = await signAgentRunToken(ctx.env.AUTH_SECRET, {
    sub: runAs.userId,
    tid: runAs.tenantId,
    rid: runId,
  });
  const fetchInternal = makeDetachedFetch(app, ctx.env, {
    origin,
    token,
    tenantId: runAs.tenantId,
  });

  try {
    await runAgentTurn({
      ctx,
      agentId,
      threadId,
      tenantId: runAs.tenantId,
      runId,
      message,
      fetchInternal,
      auth: { userId: runAs.userId, guards },
    });
    return { ok: true };
  } catch (e) {
    // runAgentTurn already marked the run + emitted `agent.error`; swallow so a
    // provider outage doesn't turn into a retry storm.
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
};
