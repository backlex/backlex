/**
 * Agent run loop — a reason→act cycle built on native tool calling. Each turn,
 * `callClaudeTools` hands the model the running conversation plus the agent's
 * tool catalog (as real Anthropic/gateway tools) and returns either tool calls
 * or a final answer. The runner executes the calls itself (so permissions, the
 * allow-list, dedup, and step persistence stay under our control), appends the
 * observations to the transcript, and loops. Every step is persisted to
 * `agent_messages` as it happens, so a thread is a complete, resumable
 * transcript the UI can replay.
 *
 * Native tool calling replaced the older hand-rolled JSON ReAct loop, which
 * flattened the whole thread into one prompt and asked the model to emit
 * `{thought, action, args}` JSON — fragile (a long tool payload truncated mid-
 * JSON and leaked as the "answer") and prone to repeating identical calls.
 *
 * The loop runs synchronously inside the request that posts a message, reusing
 * that request's identity for tool calls via `fetchInternal` (the same
 * in-process sub-fetch the MCP + Ask-AI surfaces use, so permissions, tenant
 * resolution, and the permission DSL all apply unchanged).
 */
import { callClaudeTools, type AiEffort } from "../../mcp/ai-client";
import { allTools } from "../../mcp/tools";
import type { McpTool, ToolCtx } from "../../mcp/types";
import type { ModelMessage } from "ai";
import {
  GLOBAL_AI_CONFIG_ID,
  applyAiOverride,
  resolveAiOverride,
} from "../ai-config";
import { publishEvent } from "../events";
import type { Ctx } from "../../context";
import {
  parseMemoryScope,
  retrieveEpisodic,
  retrieveSemantic,
  scheduleDistillation,
  storeEpisodic,
} from "./memory";
import {
  appendMessage,
  getAgent,
  listAgents,
  listAuthors,
  listMessages,
  setRunStatus,
  setThreadStatus,
  syncThreadStatus,
  touchRun,
  type AgentRow,
  type MessageRow,
} from "./store";

export interface RunTurnInput {
  ctx: Ctx;
  agentId: string;
  threadId: string;
  tenantId: string;
  /** The `agent_runs` row this turn holds — its per-agent lock, its status, and
   *  what a client polls. Claimed by the caller before the turn starts. */
  runId: string;
  /** The end-user message that triggered this turn. Already persisted by the
   *  caller: one message in a room can trigger several agents, so appending it
   *  here would write it once per responder. */
  message: string;
  /** Identity for tool calls — the in-process sub-fetch forwarder built by the
   *  route from the original request (carries the caller's session / key), or
   *  by the background worker from a short-lived agent-run token. */
  fetchInternal: (path: string, init?: RequestInit) => Promise<Response>;
  /** Auth used to log activity + author the user message. */
  auth: { userId: string | null };
}

export interface RunStep {
  thought?: string;
  tool: string;
  args: Record<string, unknown>;
  observation: string;
  isError: boolean;
}

export interface RunTurnResult {
  answer: string;
  steps: RunStep[];
  stoppedReason: "final" | "max_steps" | "error";
  /** Input tokens this turn that were served from the prompt cache (~0.1× of
   *  full input price). Zero on the managed-cloud path, which doesn't cache. */
  cachedTokens: number;
}

// Default agent model. Sonnet 5 is the balanced pick for multi-step agentic
// reasoning — the old Haiku default was too weak here and looped on identical
// tool calls. Gateway-prefixed; `resolveModelId` strips the prefix for a direct
// Anthropic key.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/** Native tools carry their own JSON-Schema, so the system prompt is just the
 *  persona plus a short loop instruction — no hand-written tool catalog. */
const buildSystem = (agent: AgentRow, hasTools: boolean): string => {
  const persona =
    agent.systemPrompt?.trim() ||
    "You are a helpful AI agent operating inside a backlex workspace.";
  const loop = hasTools
    ? "\n\nYou can call the provided tools to read or act on the workspace. " +
      "Call a tool only when you need its data, and prefer finishing once you " +
      "can answer. Don't repeat a tool call with the exact same arguments — " +
      "reuse the result you already have. When you have enough information, " +
      "STOP calling tools and reply with a CONCISE, well-structured summary in " +
      "plain text — describe what you found or did and the outcome. Do NOT paste " +
      "raw tool output or JSON back; that summary is your final answer."
    : "\n\nYou have no tools — answer from your own knowledge.";
  return persona + loop;
};

/** Anthropic/gateway tool names must match `[a-zA-Z0-9_-]{1,64}`, but MCP tool
 *  names are dotted (`schema.list_collections`). Sanitize to a native-safe id,
 *  disambiguating any collisions, and keep a map back to the real MCP tool. */
const buildToolMap = (
  tools: McpTool[],
): { defs: { name: string; description: string; inputSchema: unknown }[]; byNative: Map<string, McpTool> } => {
  const byNative = new Map<string, McpTool>();
  const defs: { name: string; description: string; inputSchema: unknown }[] = [];
  for (const t of tools) {
    let native = t.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    while (byNative.has(native)) native = native.slice(0, 60) + "_" + defs.length;
    byNative.set(native, t);
    defs.push({
      name: native,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    });
  }
  return { defs, byNative };
};

/**
 * Rebuild the AI-SDK message history from the persisted thread, from the point
 * of view of ONE agent in the room.
 *
 * A room's transcript is a group conversation: teammates and other agents both
 * speak in it. For the agent about to answer, only its OWN replies are
 * `assistant`; everything else — humans and sibling agents alike — is `user`
 * input, prefixed with the speaker so the model can tell them apart ("Ayşe:",
 * "@data-buddy:"). Consecutive same-role rows are merged, since a room can
 * easily produce several human messages in a row.
 *
 * Prior turns' tool scratchpad isn't reconstructed into native tool-call/result
 * parts (the model gets a fresh tool catalog each turn), which keeps the
 * sequence valid.
 */
const buildMessages = (
  messages: MessageRow[],
  selfAgentId: string,
  speakerLabel: (m: MessageRow) => string | null,
): ModelMessage[] => {
  const out: ModelMessage[] = [];
  const push = (role: "user" | "assistant", content: string): void => {
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${content}`;
      return;
    }
    out.push({ role, content });
  };
  for (const m of messages) {
    if (m.toolName) continue; // tool scratchpad is not replayed
    if (!m.content) continue;
    if (m.role === "assistant" && m.agentId === selfAgentId) {
      push("assistant", m.content);
      continue;
    }
    if (m.role === "assistant" || m.role === "user") {
      const label = speakerLabel(m);
      push("user", label ? `${label}: ${m.content}` : m.content);
    }
  }
  return out;
};

/**
 * Build the "who said this" prefix resolver a room transcript needs, in two
 * queries instead of one per message: the team members behind the `user_id`s,
 * and the workspace's agents behind the `agent_id`s.
 */
const buildSpeakerLabeller = async (
  ctx: Ctx,
  tenantId: string,
  messages: MessageRow[],
): Promise<(m: MessageRow) => string | null> => {
  const authors = await listAuthors(ctx, messages.map((m) => m.userId));
  const byUser = new Map(authors.map((a) => [a.id, a.name || a.email || null]));
  const needsAgents = messages.some((m) => m.role === "assistant" && m.agentId);
  const agents = needsAgents ? await listAgents(ctx, tenantId) : [];
  const byAgent = new Map(
    agents.map((a) => [a.id, a.handle ? `@${a.handle}` : a.name]),
  );
  return (m) => {
    if (m.role === "assistant") return m.agentId ? (byAgent.get(m.agentId) ?? null) : null;
    return m.userId ? (byUser.get(m.userId) ?? null) : null;
  };
};

/** Stable key for the per-turn duplicate-call guard. */
const argsKey = (args: Record<string, unknown>): string =>
  JSON.stringify(args, Object.keys(args).sort());

/** Pull a plain-text rendering out of an MCP ToolResult for the observation the
 *  model reads back. Prefers `structuredContent` (machine shape) but falls back
 *  to the concatenated text content. Caps length so a huge list can't blow the
 *  next prompt's context. */
const OBSERVATION_CAP = 6_000;
const renderObservation = (result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}): { text: string; isError: boolean } => {
  let text: string;
  if (result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent);
  } else {
    text = (result.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  if (text.length > OBSERVATION_CAP) {
    text = `${text.slice(0, OBSERVATION_CAP)}… (truncated)`;
  }
  return { text, isError: Boolean(result.isError) };
};

/**
 * Run one agent's turn to completion (final answer or max-steps). Persists
 * every tool step and the final answer, attributed to this agent.
 *
 * The triggering user message is persisted by the CALLER, not here: in a room
 * one message can wake several agents, and each of them runs one of these.
 */
export const runAgentTurn = async (
  input: RunTurnInput,
): Promise<RunTurnResult> => {
  const { ctx, agentId, threadId, tenantId, runId, message, fetchInternal } = input;
  const agent = await getAgent(ctx, agentId, tenantId);
  if (!agent) throw new Error("agent not found");

  // The agent's allow-list, resolved against the live registry. Unknown names
  // (a tool removed since the agent was authored) are simply dropped. Native
  // tool names are sanitized (dots → underscores) with a map back to the MCP
  // tool the model's call resolves to.
  const tools = allTools.filter((t) => agent.tools.includes(t.name));
  const { defs: toolDefs, byNative } = buildToolMap(tools);
  let system = buildSystem(agent, tools.length > 0);

  // Live progress channel — clients subscribe to `agent:thread:<id>` to watch
  // steps stream in. Best-effort: a publish failure never breaks the turn.
  // Every frame carries `agentId` + `runId`: a room streams several turns at
  // once, so a client has to know which agent a step belongs to.
  const channel = `agent:thread:${threadId}`;
  const emit = async (
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await publishEvent(ctx.env, channel, {
        event,
        data: { ...data, agentId, runId },
      });
    } catch {
      /* realtime is best-effort */
    }
  };

  // Bring-your-own AI key (workspace override) wins over the deployment default,
  // mirroring the Ask-AI planner.
  const override = await resolveAiOverride(
    { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
    tenantId ?? GLOBAL_AI_CONFIG_ID,
  );
  const aiEnv = override ? applyAiOverride(ctx.env, override) : ctx.env;
  const model = agent.model || DEFAULT_MODEL;

  const toolCtx: ToolCtx = {
    fetchInternal,
    mode: "admin",
    env: ctx.env,
    guards: { allowlist: null, readOnly: false },
  };

  // Memory (opt-in), in two passes. They're folded in under separate headings
  // because they answer different questions and the model should weigh them
  // differently: episodes are "what was said" (fallible, conversational),
  // facts are "what is true" (durable, already filtered). Merging them into one
  // bullet list invites the model to treat a stray remark as settled fact.
  // Episodic recall is always thread-scoped so a room-mate's recollection never
  // leaks into this persona; semantic reach follows the agent's `memoryScope`.
  // No-op when memory is off or no embedding provider is configured.
  const memoryScope = parseMemoryScope(agent.memoryScope);
  if (agent.memory) {
    const [facts, snippets] = await Promise.all([
      retrieveSemantic(ctx, agentId, memoryScope, threadId, message),
      retrieveEpisodic(ctx, threadId, agentId, message),
    ]);
    if (facts.length) {
      system +=
        "\n\nWhat you have learned previously (treat as established unless the " +
        "user corrects it):\n" +
        facts.map((s) => `  - ${s}`).join("\n");
    }
    if (snippets.length) {
      system +=
        "\n\nRelevant context from earlier in this conversation (may help, " +
        "ignore if not):\n" +
        snippets.map((s) => `  - ${s}`).join("\n");
    }
  }

  await setRunStatus(ctx, runId, "running");
  await setThreadStatus(ctx, threadId, "running");
  await emit("agent.start", { threadId, userId: input.auth.userId });
  if (agent.memory) {
    await storeEpisodic(ctx, threadId, agentId, `${runId}:q`, message);
  }

  const steps: RunStep[] = [];
  let cachedTokens = 0;
  const maxSteps = Math.max(1, Math.min(agent.maxSteps || 8, 25));

  // Running conversation the model sees, seeded from the persisted thread and
  // rendered from THIS agent's point of view (see buildMessages). The loop
  // appends this turn's assistant tool-call and tool-result messages so each
  // iteration builds on the last with proper roles (not a flat re-prompt).
  const history = await listMessages(ctx, threadId);
  const speakerLabel = await buildSpeakerLabeller(ctx, tenantId, history);
  const messages = buildMessages(history, agentId, speakerLabel);
  // Per-turn duplicate-call guard: same tool + same args → short-circuit rather
  // than re-running (a weak model can otherwise spin on the identical call).
  const called = new Set<string>();

  try {
    for (let i = 0; i < maxSteps; i++) {
      // Heartbeat the run so a long-but-healthy turn isn't mistaken for a dead
      // isolate and taken over (see STALE_RUN_MS in the store).
      await touchRun(ctx, runId);
      const reply = await callClaudeTools(aiEnv, {
        system,
        messages,
        tools: toolDefs,
        model,
        maxTokens: 4096,
        effort: agent.effort as AiEffort | undefined,
      });
      const usage = {
        tokensIn: reply.usage?.input_tokens ?? null,
        tokensOut: reply.usage?.output_tokens ?? null,
      };
      // Prompt-cache hits across the loop's steps — the whole point of the
      // caching option, so make it observable rather than inferred.
      cachedTokens += reply.usage?.cache_read_input_tokens ?? 0;

      // No tool calls → the model produced its final answer.
      if (reply.toolCalls.length === 0) {
        const answer =
          reply.text.trim() ||
          "I wasn't able to produce an answer for that request.";
        const msg = await appendMessage(ctx, {
          threadId,
          tenantId,
          role: "assistant",
          agentId,
          content: answer,
          ...usage,
        });
        await setRunStatus(ctx, runId, "done");
        await syncThreadStatus(ctx, threadId);
        if (agent.memory) {
          await storeEpisodic(ctx, threadId, agentId, msg.id, answer);
          // Distillation is an extra LLM call, so it runs out of band on the
          // job queue rather than making the user wait for an answer they
          // already have. The job itself is a no-op until enough new transcript
          // has accumulated (see DISTILL_EVERY_MESSAGES).
          await scheduleDistillation(ctx, {
            tenantId,
            agentId,
            threadId,
            scope: memoryScope,
            model: agent.model,
          });
        }
        await emit("agent.final", { answer });
        return { answer, steps, stoppedReason: "final", cachedTokens };
      }

      // Reflect the model's assistant turn (any text + its tool calls) back into
      // the conversation so the tool results below line up by id.
      messages.push({
        role: "assistant",
        content: [
          ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
          ...reply.toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.args,
          })),
        ],
      });

      // Usage is per model turn — attach it to the first persisted assistant
      // row of this turn only, so the UI's token total doesn't double-count.
      let usageAttached = false;
      for (const call of reply.toolCalls) {
        const mcpTool = byNative.get(call.name);
        const rowUsage = usageAttached ? {} : usage;
        usageAttached = true;

        await appendMessage(ctx, {
          threadId,
          tenantId,
          role: "assistant",
          agentId,
          content: reply.text,
          toolName: mcpTool?.name ?? call.name,
          toolArgs: call.args,
          ...rowUsage,
        });

        let observation: { text: string; isError: boolean };
        const key = `${call.name}:${argsKey(call.args)}`;
        if (!mcpTool) {
          observation = {
            text: `Unknown tool "${call.name}" — pick one from the provided tools.`,
            isError: true,
          };
        } else if (called.has(key)) {
          observation = {
            text: `Already called ${mcpTool.name} with these exact arguments this turn — reuse the earlier result or finish with your answer.`,
            isError: false,
          };
        } else {
          try {
            observation = renderObservation(
              await mcpTool.handler(call.args, toolCtx),
            );
          } catch (e) {
            observation = {
              text: e instanceof Error ? e.message : String(e),
              isError: true,
            };
          }
        }
        called.add(key);

        await appendMessage(ctx, {
          threadId,
          tenantId,
          role: "tool",
          agentId,
          content: observation.text,
          toolName: mcpTool?.name ?? call.name,
          toolResult: observation.text,
        });
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.name,
              output: { type: "text", value: observation.text },
            },
          ],
        });
        const step: RunStep = {
          thought: reply.text,
          tool: mcpTool?.name ?? call.name,
          args: call.args,
          observation: observation.text,
          isError: observation.isError,
        };
        steps.push(step);
        await emit("agent.step", { ...step });
      }
    }

    // Loop exhausted without a final answer.
    const answer =
      "I reached the maximum number of steps for this turn without finishing. " +
      "Try narrowing the request or raising the agent's step limit.";
    await appendMessage(ctx, {
      threadId,
      tenantId,
      role: "assistant",
      agentId,
      content: answer,
    });
    await setRunStatus(ctx, runId, "done");
    await syncThreadStatus(ctx, threadId);
    await emit("agent.final", { answer, stoppedReason: "max_steps" });
    return { answer, steps, stoppedReason: "max_steps", cachedTokens };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setRunStatus(ctx, runId, "error", message);
    await syncThreadStatus(ctx, threadId);
    await emit("agent.error", { message });
    throw e;
  }
};
