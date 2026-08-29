/**
 * Sending a message to a conversation — the one place that decides who answers
 * and starts their turns.
 *
 * Every surface (REST, SDK, GraphQL, MCP, CLI) funnels through here rather than
 * re-implementing routing, the per-agent lock, or the async hand-off. A message
 * is persisted once no matter how many agents it wakes; each responder then
 * gets its own `agent_runs` row, and runs for different agents proceed in
 * parallel.
 *
 * Two execution modes:
 *  - **sync** (the default, and the only shape the pre-rooms API had): the turn
 *    runs inside this request and its result comes back in the response. Kept
 *    unchanged so the SDK / CLI / MCP / GraphQL callers that expect an answer
 *    keep getting one.
 *  - **async** (`async: true`): each turn is queued and started in the
 *    background; the caller gets run ids immediately and watches the room's
 *    realtime channel. This is what a multi-agent room needs — three agents
 *    can't take turns holding one HTTP response open.
 */
import type { Hono } from "hono";
import { AppError } from "@backlex/core";
import type { KeyGuards } from "../../mcp/guards";
import type { Ctx } from "../../context";
import type { Env } from "../../env";
import { makeInternalFetch } from "../../mcp/internal-fetch";
import { publishEvent } from "../events";
import { enqueueAgentTurn, runQueuedAgentTurn } from "./async-run";
import { resolveResponders } from "./mentions";
import { runAgentTurn, type RunTurnResult } from "./runner";
import { aiMeterForTenant, assertAiQuota } from "../usage";
import {
  appendMessage,
  claimRun,
  ensureThreadTitle,
  getThread,
  listAgents,
  listThreadAgentIds,
  type AgentRow,
  type ThreadRow,
} from "./store";

export interface SendMessageInput {
  ctx: Ctx;
  /** The Hono app, so a turn's tool calls can re-enter the API in-process. */
  app: Hono;
  env: Env;
  tenantId: string;
  threadId: string;
  message: string;
  /** Who asked, and what bounds them. `guards` is the caller's effective MCP
   *  guards (key + role); it travels with the turn and, for a background turn,
   *  onto the job payload — the calling credential is gone by then. */
  auth: { userId: string | null; guards: KeyGuards };
  /** The request this send arrived on — its identity is what a sync turn's
   *  tool calls inherit. */
  request: Request;
  /** Bypass routing and run exactly these agents. Used by the surfaces that
   *  name an agent explicitly (`runAgent`, `agents.run`, `backlex agents run`)
   *  — there the caller's intent IS the routing, and a room's mention-only mode
   *  must not silently swallow the request. */
  forceAgentIds?: string[];
  /** Run the turns in the background and answer immediately. */
  async?: boolean;
  /** Keeps the isolate alive for background turns. Absent on runtimes without
   *  an ExecutionContext (Bun/Node), where a dangling promise runs anyway. */
  background?: (p: Promise<unknown>) => void;
}

export interface SendMessageResult {
  /** The persisted user message — one row, however many agents answer it. */
  messageId: string;
  /** Turns that were started, in responder order. */
  runs: { runId: string; agentId: string }[];
  /** Agents that were asked to answer but are already mid-turn. */
  busy: { agentId: string; runId: string }[];
  /** Completed turns — sync mode only; empty when the runs were queued. */
  turns: RunTurnResult[];
}

/** A room's agents. Falls back to the legacy single-agent pin so a thread
 *  created before rooms (or via `POST /agents/:id/threads`) still resolves its
 *  one participant even if the membership row is missing. */
export const threadParticipants = async (
  ctx: Ctx,
  tenantId: string,
  thread: ThreadRow,
): Promise<AgentRow[]> => {
  const ids = await listThreadAgentIds(ctx, thread.id);
  const wanted = new Set(ids.length > 0 ? ids : thread.agentId ? [thread.agentId] : []);
  if (wanted.size === 0) return [];
  const all = await listAgents(ctx, tenantId);
  // Preserve membership order (oldest first) rather than the agents' own order.
  const byId = new Map(all.map((a) => [a.id, a]));
  return [...wanted].map((id) => byId.get(id)).filter((a): a is AgentRow => !!a);
};

export const sendMessage = async (
  input: SendMessageInput,
): Promise<SendMessageResult> => {
  const { ctx, app, env, tenantId, threadId, message, auth } = input;

  const thread = await getThread(ctx, threadId, tenantId);
  if (!thread) throw new AppError("NOT_FOUND", "Thread not found");

  const participants = await threadParticipants(ctx, tenantId, thread);
  let responders: string[];
  if (input.forceAgentIds && input.forceAgentIds.length > 0) {
    // Naming an agent is only a routing override, never a way to pull an
    // outsider into someone else's room.
    const member = new Set(participants.map((a) => a.id));
    const stranger = input.forceAgentIds.find((id) => !member.has(id));
    if (stranger) {
      throw new AppError(
        "VALIDATION",
        `agent ${stranger} is not part of this conversation`,
      );
    }
    responders = input.forceAgentIds;
  } else {
    // The mention router GENERATES to decide who should answer, so it is a
    // spend like any other. Checked here rather than inside `resolveResponders`
    // for the same reason that function takes its meter as a parameter: it is
    // deliberately context-free, and the workspace is known at this seam.
    await assertAiQuota(ctx, env, tenantId);
    responders = await resolveResponders({
      env,
      thread,
      participants,
      message,
      meter: aiMeterForTenant(ctx, tenantId),
    });
  }

  // The message lands once, before any turn starts, so every viewer sees it
  // immediately and each responder's transcript already contains it.
  const userMsg = await appendMessage(ctx, {
    threadId,
    tenantId,
    role: "user",
    content: message,
    userId: auth.userId,
  });
  await ensureThreadTitle(ctx, threadId);
  const channel = `agent:thread:${threadId}`;
  const emit = async (event: string, data: Record<string, unknown>) => {
    try {
      await publishEvent(env, channel, { event, data });
    } catch {
      /* realtime is best-effort */
    }
  };
  await emit("agent.message", {
    id: userMsg.id,
    role: "user",
    content: message,
    userId: auth.userId,
  });

  const result: SendMessageResult = {
    messageId: userMsg.id,
    runs: [],
    busy: [],
    turns: [],
  };
  // Nobody was addressed — a room on `mention` routing is a perfectly good
  // human-to-human thread, so this is a normal outcome, not an error.
  if (responders.length === 0) return result;

  for (const agentId of responders) {
    const claim = await claimRun(ctx, {
      tenantId,
      threadId,
      agentId,
      startedBy: auth.userId,
      triggerMessageId: userMsg.id,
    });
    if (!claim.ok) {
      result.busy.push({ agentId, runId: claim.heldBy.id });
      continue;
    }
    result.runs.push({ runId: claim.run.id, agentId });
  }

  // Everyone asked is already mid-turn. Surfaced as a conflict so the single-
  // agent case keeps returning the 409 the API has always returned.
  if (result.runs.length === 0 && result.busy.length > 0) {
    throw new AppError(
      "CONFLICT",
      responders.length === 1
        ? "A turn is already running on this thread"
        : "Every agent asked to answer is already running a turn",
    );
  }

  const origin = new URL(input.request.url).origin;

  if (input.async) {
    // Queued for durability, then started inline so the common case has no
    // queue latency. The scheduled tick only ever picks up a turn whose isolate
    // died before it could start — see `runQueuedAgentTurn`'s status guard.
    if (!auth.userId) {
      throw new AppError(
        "VALIDATION",
        "Background turns need a signed-in user — an API key must send the message synchronously",
      );
    }
    for (const run of result.runs) {
      const payload = {
        runId: run.runId,
        threadId,
        agentId: run.agentId,
        message,
        runAs: { userId: auth.userId, tenantId },
        // Stamped from the request that asked for the turn. A background turn
        // re-enters as the user via a run token, which carries no key — so a
        // read-only credential's restriction only survives because it is
        // written down here.
        guards: auth.guards,
        origin,
      };
      await enqueueAgentTurn(ctx, payload);
      await emit("agent.queued", { agentId: run.agentId, runId: run.runId });
      const started = runQueuedAgentTurn(ctx, app, payload).catch(() => ({
        ok: false,
      }));
      if (input.background) input.background(started);
      else void started;
    }
    return result;
  }

  // Sync: the caller waits. Several responders run one after another rather
  // than concurrently — a synchronous caller is already waiting on the wire,
  // and serial keeps the transcript readable.
  const fetchInternal = makeInternalFetch(app, input.request, env);
  for (const run of result.runs) {
    result.turns.push(
      await runAgentTurn({
        ctx,
        agentId: run.agentId,
        threadId,
        tenantId,
        runId: run.runId,
        message,
        fetchInternal,
        auth,
      }),
    );
  }
  return result;
};