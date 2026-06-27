/**
 * Agent run loop — a durable-ish reason→act cycle built on the existing pieces:
 * `callClaude` for the LLM turn (gateway / direct Anthropic / managed-cloud, all
 * already wired) and the MCP tool registry (`allTools`) for actions. Each step
 * is persisted to `agent_messages` as it happens, so a thread is a complete,
 * resumable transcript and the UI can replay every thought / tool call.
 *
 * Phase 1 runs the loop synchronously inside the request that posts a message,
 * reusing that request's identity for tool calls via `fetchInternal` (the same
 * in-process sub-fetch the MCP + Ask-AI surfaces use, so permissions, tenant
 * resolution, and the permission DSL all apply unchanged). Tool calls are
 * additionally constrained to the agent's own `tools` allow-list. Streaming and
 * a job-queue-backed async path layer on top of this in Phase 2.
 */
import { callClaude, extractJson } from "../../mcp/ai-client";
import { allTools } from "../../mcp/tools";
import type { McpTool, ToolCtx } from "../../mcp/types";
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

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

/** Render one tool for the system-prompt catalog: name, description, and the
 *  JSON-Schema property keys so the model knows the arg shape without us
 *  re-describing it. */
const describeTool = (t: McpTool): string => {
  const props = t.inputSchema?.properties ?? {};
  const keys = Object.keys(props);
  const required = new Set(t.inputSchema?.required ?? []);
  const argList = keys
    .map((k) => {
      const spec = props[k] as { type?: string } | undefined;
      const typ = spec?.type ?? "any";
      return `${k}${required.has(k) ? "" : "?"}: ${typ}`;
    })
    .join(", ");
  return `  - ${t.name}: ${t.description}${argList ? `\n    args: { ${argList} }` : ""}`;
};

const buildSystem = (agent: AgentRow, tools: McpTool[]): string => {
  const persona =
    agent.systemPrompt?.trim() ||
    "You are a helpful AI agent operating inside a backlex workspace.";
  const catalog = tools.length
    ? tools.map(describeTool).join("\n")
    : "  (no tools available — answer from your own knowledge)";
  return (
    `${persona}\n\n` +
    "You work in a reason→act loop. On EACH turn output EXACTLY one fenced " +
    "JSON block (```json ... ```) and nothing else, with this shape:\n" +
    '  { "thought": string, "action": string, "args": object }\n' +
    "where `action` is either the name of ONE tool from the list below (to " +
    'call it with `args`), or the literal "final" to finish. When `action` is ' +
    '"final", put your complete user-facing answer in `args.answer` (a string). ' +
    "Call a tool only when you need its data; prefer finishing once you can " +
    "answer. Never invent a tool name or an argument the schema doesn't list.\n\n" +
    "Available tools:\n" +
    catalog
  );
};

/** Flatten the persisted thread into a transcript the single-turn `callClaude`
 *  can consume. Tool steps render as Action/Observation pairs so the model sees
 *  its own scratchpad on the next iteration. */
const renderTranscript = (messages: MessageRow[]): string => {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`User: ${m.content}`);
    } else if (m.role === "assistant" && m.toolName) {
      const args = m.toolArgs ? JSON.stringify(m.toolArgs) : "{}";
      if (m.content) lines.push(`Thought: ${m.content}`);
      lines.push(`Action: ${m.toolName} ${args}`);
    } else if (m.role === "assistant") {
      lines.push(`Assistant: ${m.content}`);
    } else if (m.role === "tool") {
      lines.push(`Observation: ${m.content}`);
    }
  }
  return lines.join("\n");
};

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

interface ParsedAction {
  thought: string;
  action: string;
  args: Record<string, unknown>;
}

const parseAction = (text: string): ParsedAction => {
  const parsed = extractJson(text) as {
    thought?: unknown;
    action?: unknown;
    args?: unknown;
  };
  const action = typeof parsed.action === "string" ? parsed.action : "final";
  const thought = typeof parsed.thought === "string" ? parsed.thought : "";
  const args =
    parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
      ? (parsed.args as Record<string, unknown>)
      : {};
  return { thought, action, args };
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
  // (a tool removed since the agent was authored) are simply dropped.
  const tools = allTools.filter((t) => agent.tools.includes(t.name));
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  let system = buildSystem(agent, tools);

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
  });
  await setThreadStatus(ctx, threadId, "running");
  await emit("agent.start", { threadId, agentId });
  if (agent.memory) await storeMemory(ctx, threadId, userMsg.id, message);

  const steps: RunStep[] = [];
  const maxSteps = Math.max(1, Math.min(agent.maxSteps || 8, 25));

  try {
    for (let i = 0; i < maxSteps; i++) {
      const transcript = renderTranscript(await listMessages(ctx, threadId));
      const reply = await callClaude(aiEnv, {
        system,
        user: `${transcript}\n\nRespond with the next JSON action.`,
        model,
        maxTokens: 1500,
      });
      const usage = {
        tokensIn: reply.usage?.input_tokens ?? null,
        tokensOut: reply.usage?.output_tokens ?? null,
      };

      let parsed: ParsedAction;
      try {
        parsed = parseAction(reply.text);
      } catch {
        // Model didn't return parseable JSON — treat the raw reply as the
        // final answer rather than failing the whole turn.
        const answer = reply.text.trim();
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

      if (parsed.action === "final" || !toolByName.has(parsed.action)) {
        const answer =
          typeof parsed.args.answer === "string" && parsed.args.answer.trim()
            ? (parsed.args.answer as string)
            : parsed.thought ||
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

      // Tool step — record the model's decision, run the tool, record the
      // observation.
      const tool = toolByName.get(parsed.action)!;
      await appendMessage(ctx, {
        threadId,
        tenantId,
        role: "assistant",
        content: parsed.thought,
        toolName: parsed.action,
        toolArgs: parsed.args,
        ...usage,
      });

      let observation: { text: string; isError: boolean };
      try {
        const result = await tool.handler(parsed.args, toolCtx);
        observation = renderObservation(result);
      } catch (e) {
        observation = {
          text: e instanceof Error ? e.message : String(e),
          isError: true,
        };
      }
      await appendMessage(ctx, {
        threadId,
        tenantId,
        role: "tool",
        content: observation.text,
        toolName: parsed.action,
        toolResult: observation.text,
      });
      const step: RunStep = {
        thought: parsed.thought,
        tool: parsed.action,
        args: parsed.args,
        observation: observation.text,
        isError: observation.isError,
      };
      steps.push(step);
      await emit("agent.step", step);
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
