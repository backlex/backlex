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
import { callClaudeTools } from "../../mcp/ai-client";
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
import { retrieveMemory, storeMemory } from "./memory";
import {
  appendMessage,
  ensureThreadTitle,
  getAgent,
  listMessages,
  setThreadStatus,
  type AgentRow,
  type MessageRow,
} from "./store";

export interface RunTurnInput {
  ctx: Ctx;
  agentId: string;
  threadId: string;
  tenantId: string;
  /** The new end-user message that kicks off this turn. */
  message: string;
  /** Identity for tool calls — the in-process sub-fetch forwarder built by the
   *  route from the original request (carries the caller's session / key). */
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

/** Rebuild the AI-SDK message history from the persisted thread. We carry
 *  forward the user turns and the assistant's final answers; prior turns' tool
 *  scratchpad isn't reconstructed into native tool-call/result parts (the model
 *  gets a fresh tool catalog each turn), which keeps the sequence valid. */
const buildMessages = (messages: MessageRow[]): ModelMessage[] => {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && !m.toolName && m.content)
      out.push({ role: "assistant", content: m.content });
  }
  return out;
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
 * Run a single end-user turn against an agent to completion (final answer or
 * max-steps). Persists the user message, every tool step, and the final answer.
 */
export const runAgentTurn = async (
  input: RunTurnInput,
): Promise<RunTurnResult> => {
  const { ctx, agentId, threadId, tenantId, message, fetchInternal } = input;
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
  const channel = `agent:thread:${threadId}`;
  const emit = async (event: string, data: unknown): Promise<void> => {
    try {
      await publishEvent(ctx.env, channel, { event, data });
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

  // Semantic memory (opt-in): retrieve the most relevant past snippets BEFORE
  // we persist this turn's user message (so it can't retrieve itself), then
  // fold them into the system prompt. No-op when memory is off or no embedding
  // provider is configured.
  if (agent.memory) {
    const snippets = await retrieveMemory(ctx, threadId, message);
    if (snippets.length) {
      system +=
        "\n\nRelevant context from earlier in this conversation (may help, " +
        "ignore if not):\n" +
        snippets.map((s) => `  - ${s}`).join("\n");
    }
  }

  const userMsg = await appendMessage(ctx, {
    threadId,
    tenantId,
    role: "user",
    content: message,
    userId: input.auth.userId,
  });
  // Label the thread with its opening prompt so the history picker reads as
  // text instead of a uuid. No-op once the thread has a title.
  await ensureThreadTitle(ctx, threadId);
  await setThreadStatus(ctx, threadId, "running");
  // Threads are team-visible: everyone watching this one sees the question
  // appear and who asked it, not just the person who sent it.
  await emit("agent.message", {
    id: userMsg.id,
    role: "user",
    content: message,
    userId: input.auth.userId,
  });
  await emit("agent.start", { threadId, agentId, userId: input.auth.userId });
  if (agent.memory) await storeMemory(ctx, threadId, userMsg.id, message);

  const steps: RunStep[] = [];
  const maxSteps = Math.max(1, Math.min(agent.maxSteps || 8, 25));

  // Running conversation the model sees, seeded from the persisted thread. The
  // loop appends this turn's assistant tool-call and tool-result messages so
  // each iteration builds on the last with proper roles (not a flat re-prompt).
  const messages = buildMessages(await listMessages(ctx, threadId));
  // Per-turn duplicate-call guard: same tool + same args → short-circuit rather
  // than re-running (a weak model can otherwise spin on the identical call).
  const called = new Set<string>();

  try {
    for (let i = 0; i < maxSteps; i++) {
      const reply = await callClaudeTools(aiEnv, {
        system,
        messages,
        tools: toolDefs,
        model,
        maxTokens: 4096,
      });
      const usage = {
        tokensIn: reply.usage?.input_tokens ?? null,
        tokensOut: reply.usage?.output_tokens ?? null,
      };

      // No tool calls → the model produced its final answer.
      if (reply.toolCalls.length === 0) {
        const answer =
          reply.text.trim() ||
          "I wasn't able to produce an answer for that request.";
        const msg = await appendMessage(ctx, {
          threadId,
          tenantId,
          role: "assistant",
          content: answer,
          ...usage,
        });
        await setThreadStatus(ctx, threadId, "idle");
        if (agent.memory) await storeMemory(ctx, threadId, msg.id, answer);
        await emit("agent.final", { answer });
        return { answer, steps, stoppedReason: "final" };
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
        await emit("agent.step", step);
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
      content: answer,
    });
    await setThreadStatus(ctx, threadId, "idle");
    await emit("agent.final", { answer, stoppedReason: "max_steps" });
    return { answer, steps, stoppedReason: "max_steps" };
  } catch (e) {
    await setThreadStatus(ctx, threadId, "error");
    await emit("agent.error", {
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
};
