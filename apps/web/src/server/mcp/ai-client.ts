/**
 * Tiny AI-SDK caller for the `ai.*` tools + the Ask AI planner. Routes
 * through Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set (one key →
 * Anthropic / OpenAI / Google / …), falling back to the direct Anthropic
 * provider when only the legacy `ANTHROPIC_API_KEY` is configured. The
 * AI-SDK runtime is tiny and runs identically under Bun, CF Workers,
 * Vercel, and Netlify so the same code path lights up every target.
 *
 * Model strings: gateway mode uses provider-prefixed ids
 * (`anthropic/claude-haiku-4-5`); direct mode passes a bare Anthropic id
 * (`claude-haiku-4-5-20251001`). A caller's `model` field that contains
 * no `/` is treated as a bare Anthropic id and auto-prefixed in gateway
 * mode so old persisted settings keep working.
 */
import { generateText, jsonSchema, tool, type JSONValue, type ModelMessage } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createAnthropic } from "@ai-sdk/anthropic";
import { AppError } from "@backlex/core";
import { cloudConfigured, cloudPost, reportToCloud } from "../lib/cloud-report";
import type { Env } from "../env";

const DEFAULT_GATEWAY_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_DIRECT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 4096;

export interface ClaudeRequest {
  system?: string;
  user: string;
  /** Override the default model. Cheap/fast operations stay on Haiku; tools
   *  that want richer reasoning (schema design from prose) can opt up. In
   *  gateway mode pass either a bare id (`claude-sonnet-4-6`) or a
   *  provider-prefixed id (`openai/gpt-5`). */
  model?: string;
  maxTokens?: number;
  /** Reasoning effort; ignored on models that don't support it. */
  effort?: AiEffort;
}

export interface ClaudeResponse {
  text: string;
  /** Token counts surfaced for callers that want to show usage in their
   *  tool output. Field names mirror the legacy Anthropic shape so the
   *  existing `structuredContent.usage` consumers keep working.
   *  `cache_read_input_tokens` is the part served from the prompt cache at
   *  ~0.1× — the savings, made visible. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

type Provider = "gateway" | "anthropic";

const pickProvider = (env: Env): { kind: Provider; key: string } => {
  const gw = env.AI_GATEWAY_API_KEY?.trim();
  if (gw) return { kind: "gateway", key: gw };
  const direct = env.ANTHROPIC_API_KEY?.trim();
  if (direct) return { kind: "anthropic", key: direct };
  throw new AppError(
    "UNAVAILABLE",
    "No AI provider configured for this workspace — set AI_GATEWAY_API_KEY (recommended, multi-provider) or the legacy ANTHROPIC_API_KEY on the backlex deployment.",
  );
};

/** Reasoning effort. Lower effort = fewer thinking tokens and fewer, more
 *  consolidated tool calls — the cheapest quality/cost dial there is. */
export type AiEffort = "low" | "medium" | "high";

export const AI_EFFORTS: readonly AiEffort[] = ["low", "medium", "high"] as const;

/** `output_config.effort` is GA only on the newer Claude tiers — sending it to
 *  Haiku 4.5 or Sonnet 4.5 is a 400, not a no-op. Gate on the resolved id so a
 *  workspace that picked a cheap model can't break its own agent by setting
 *  effort. (Matches with or without a gateway `anthropic/` prefix.) */
const EFFORT_CAPABLE = /claude-(opus-4-[5-9]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

/**
 * Provider options for the Anthropic path. The gateway forwards `providerOptions`
 * verbatim, so the same object works for both `createGateway` and `createAnthropic`,
 * and a non-Anthropic gateway model simply ignores the `anthropic` key.
 *
 * `cacheControl` turns on the API's automatic prompt caching: a breakpoint is
 * placed on the request's last cacheable block, so the NEXT call re-reads that
 * whole prefix at ~0.1× of input price instead of paying full freight. That is
 * exactly the agent loop's shape — every step re-sends the system prompt, the
 * tool schemas, and the transcript so far, growing by one step each time. It is
 * also safe to set unconditionally: a prefix below the model's minimum simply
 * doesn't cache (no error), and the ~1.25× write premium pays for itself on the
 * second call of any multi-step turn.
 */
export const anthropicProviderOptions = (
  modelId: string,
  effort?: AiEffort,
): { anthropic: Record<string, JSONValue> } => ({
  anthropic: {
    cacheControl: { type: "ephemeral" },
    ...(effort && EFFORT_CAPABLE.test(modelId) ? { effort } : {}),
  },
});

const resolveModelId = (provider: Provider, model: string | undefined): string => {
  if (provider === "gateway") {
    if (!model) return DEFAULT_GATEWAY_MODEL;
    return model.includes("/") ? model : `anthropic/${model}`;
  }
  // Direct Anthropic — strip any leading `anthropic/` prefix coming from a
  // UI that still ships gateway-style ids, then fall back to the dated id.
  if (!model) return DEFAULT_DIRECT_MODEL;
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
};

/**
 * Managed-cloud generation path. On a provisioned cloud project the customer
 * brings no AI key, so generation runs on the platform's Workers AI via the
 * control-plane gateway (neuron-metered + hard-capped per plan) instead of
 * Anthropic. The Anthropic-style model id is ignored unless the caller passed
 * an explicit Workers AI id (`@cf/...`); otherwise the gateway's default
 * generation model is used. The gateway meters authoritatively, so we do NOT
 * also reportToCloud here (that would double-count).
 */
const callCloudGeneration = async (
  env: Env,
  { system, user, model }: ClaudeRequest,
): Promise<ClaudeResponse> => {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const cfModel = model && model.startsWith("@cf/") ? model : undefined;
  let res: Response;
  try {
    res = await cloudPost(env, "/api/internal/ai/generate", { messages, ...(cfModel ? { model: cfModel } : {}) });
  } catch (e) {
    throw new AppError("UNAVAILABLE", `Cloud AI gateway unreachable: ${e instanceof Error ? e.message : "error"}`);
  }
  if (!res.ok) {
    let message = `Cloud AI gateway returned ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j?.error?.message) message = j.error.message;
    } catch {
      // keep status-based message
    }
    // 402 = monthly AI budget exhausted.
    throw new AppError(res.status === 402 ? "VALIDATION" : "UNAVAILABLE", message);
  }
  const json = (await res.json()) as { response?: string };
  return { text: json.response ?? "" };
};

export const callClaude = async (
  env: Env,
  { system, user, model, maxTokens, effort }: ClaudeRequest,
): Promise<ClaudeResponse> => {
  // A direct provider key wins over the managed cloud gateway. On self-host
  // that's the deployment's env key; on managed cloud it only appears when a
  // workspace brought its own key (overlaid via applyAiOverride from
  // services/ai-config), which is exactly the opt-out from the metered/capped
  // platform gateway. With no direct key, a cloud project falls back to the
  // gateway; self-host with no key throws the helpful "set a key" error below.
  const hasDirectKey = Boolean(
    env.AI_GATEWAY_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim(),
  );
  if (!hasDirectKey && cloudConfigured(env))
    return callCloudGeneration(env, { system, user, model, maxTokens });

  const provider = pickProvider(env);
  const modelId = resolveModelId(provider.kind, model);
  // createGateway / createAnthropic let us inject the key from `env`
  // instead of relying on `process.env`, which doesn't exist on CF Workers.
  const aiModel =
    provider.kind === "gateway"
      ? createGateway({ apiKey: provider.key })(modelId)
      : createAnthropic({ apiKey: provider.key })(modelId);

  try {
    const result = await generateText({
      model: aiModel,
      system,
      messages: [{ role: "user", content: user }],
      maxOutputTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      providerOptions: anthropicProviderOptions(modelId, effort),
    });
    // Opt-in: self-report token usage to the cloud control plane (no-op
    // unless provisioned). Fire-and-forget — never blocks the response.
    void reportToCloud(env, {
      kind: "ai_usage",
      tokensIn: result.usage?.inputTokens,
      tokensOut: result.usage?.outputTokens,
    });
    return {
      text: result.text,
      usage: {
        input_tokens: result.usage?.inputTokens,
        output_tokens: result.usage?.outputTokens,
        cache_read_input_tokens: result.usage?.cachedInputTokens,
      },
    };
  } catch (e) {
    // AI SDK throws `AISDKError` subclasses with a `.message`. Surface as
    // AppError so the global error handler maps it consistently. UNAVAILABLE
    // is the closest fit for upstream provider failures (rate limit, model
    // busy, transient 5xx); the original message is preserved.
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError(
      "UNAVAILABLE",
      `AI provider call failed (${provider.kind}, ${modelId}): ${msg.slice(0, 500)}`,
    );
  }
};

/** A tool the model may call, described by a raw JSON Schema. `name` must be a
 *  native-tool-safe id (`[a-zA-Z0-9_-]{1,64}`) — the agent runner sanitizes the
 *  dotted MCP names (`schema.list_collections`) before handing them here. */
export interface ClaudeToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (an object schema). */
  inputSchema: unknown;
}

/** One tool call the model decided to make this turn. Args are the parsed input. */
export interface ModelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ClaudeToolsRequest {
  system?: string;
  /** Full conversation so far, in AI-SDK model-message shape. */
  messages: ModelMessage[];
  /** Tools the model may call this turn. Omit/empty → plain completion. */
  tools?: ClaudeToolDef[];
  model?: string;
  maxTokens?: number;
  /** Reasoning effort; ignored on models that don't support it. */
  effort?: AiEffort;
}

export interface ClaudeToolsResponse {
  /** Any assistant text produced alongside (or instead of) tool calls. */
  text: string;
  /** Tool calls the model made — empty when it produced a final answer. */
  toolCalls: ModelToolCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Flatten a model-message transcript to a single prompt for the managed-cloud
 *  text path, which can't do native tool calling. */
const flattenMessages = (messages: ModelMessage[]): string => {
  const parts: string[] = [];
  for (const m of messages) {
    const content =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<Record<string, unknown>>)
            .map((p) => {
              if (typeof p.text === "string") return p.text;
              const out = p.output as { value?: unknown } | undefined;
              if (out && typeof out.value === "string") return out.value;
              return JSON.stringify(p);
            })
            .join("\n");
    parts.push(`${m.role}: ${content}`);
  }
  return parts.join("\n");
};

/** System-prompt catalog + instruction for the JSON-simulated tool loop used on
 *  the managed-cloud text path (Workers AI can't do native tool calling). The
 *  model emits a single `{tool, args}` JSON block to call a tool, or plain text
 *  to finish — the same contract the runner's native path expresses natively. */
const cloudToolInstruction = (tools: ClaudeToolDef[]): string => {
  const catalog = tools
    .map((t) => {
      const props =
        (t.inputSchema as { properties?: Record<string, { type?: string }> })
          ?.properties ?? {};
      const args = Object.keys(props)
        .map((k) => `${k}: ${props[k]?.type ?? "any"}`)
        .join(", ");
      return `  - ${t.name}: ${t.description}${args ? `\n    args: { ${args} }` : ""}`;
    })
    .join("\n");
  return (
    "\n\nYou can use tools. To CALL a tool, reply with ONLY a fenced json " +
    'block:\n```json\n{ "tool": "<tool name>", "args": { ... } }\n```\nand ' +
    "nothing else. To give your FINAL answer, reply with plain text and NO " +
    "json block. Don't repeat a tool call with identical args. Available tools:\n" +
    catalog
  );
};

/** Default Workers AI model for managed-cloud agent turns. GLM-5.2 (Z.ai) is
 *  the strongest Cloudflare-hosted model for the code-writing agent use case —
 *  flagship coding + tool use. It is also the priciest on output neurons, so it
 *  burns plan budget fast; an agent can pick a cheaper whitelisted `@cf/*` model
 *  (Qwen3-30B, gpt-oss, Llama) to trade quality for cost. Still a Workers AI
 *  model, still neuron-metered + plan-capped. */
const CLOUD_DEFAULT_AGENT_MODEL = "@cf/zai-org/glm-5.2";

/** Resolve the Workers AI model for a managed-cloud agent turn: honour an
 *  explicit `@cf/*` pick, else use the strong agent default (never the platform
 *  8B default, and never a Claude/gateway id the metered path can't run). */
const pickCloudModel = (model?: string): string =>
  model?.startsWith("@cf/") ? model : CLOUD_DEFAULT_AGENT_MODEL;

/** Pull EVERY `{ "tool": …, "args": … }` object out of a reply. Reasoning models
 *  (GLM-5.2) batch several tool calls in one turn with messy fences and stray
 *  braces, so a single fenced-block parse fails (invalid JSON → the whole reply
 *  leaks as the "answer"). Brace-match each object independently instead — the
 *  runner executes them all, then loops for the next turn. */
const parseCloudToolCalls = (text: string): ModelToolCall[] => {
  const calls: ModelToolCall[] = [];
  const marker = /"tool"\s*:/g;
  let m: RegExpExecArray | null = marker.exec(text);
  while (m !== null) {
    const start = text.lastIndexOf("{", m.index);
    let end = -1;
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // truncated / unbalanced — stop scanning
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as {
        tool?: unknown;
        args?: unknown;
      };
      if (typeof obj.tool === "string") {
        const args =
          obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
            ? (obj.args as Record<string, unknown>)
            : {};
        calls.push({ id: crypto.randomUUID(), name: obj.tool, args });
      }
    } catch {
      /* skip an unparseable object */
    }
    marker.lastIndex = end + 1;
    m = marker.exec(text);
  }
  return calls;
};

/** Managed-cloud tool turn: Workers AI is text-only, so we simulate one tool
 *  step in JSON and return the SAME `{text, toolCalls}` shape the native path
 *  does — the runner stays single-path and tool calling keeps working for
 *  provisioned projects that bring no AI key. */
const callCloudToolTurn = async (
  env: Env,
  { system, messages, tools, model }: ClaudeToolsRequest,
): Promise<ClaudeToolsResponse> => {
  const sys =
    (system ?? "") + (tools?.length ? cloudToolInstruction(tools) : "");
  const r = await callCloudGeneration(env, {
    system: sys,
    user: flattenMessages(messages),
    model: pickCloudModel(model),
  });
  const text = r.text ?? "";
  if (tools?.length) {
    // Accept a BATCH of tool calls (GLM-5.2 emits several per turn); keep only
    // ones that name a real tool. The runner loops over them all.
    const known = new Set(tools.map((t) => t.name));
    const calls = parseCloudToolCalls(text).filter((c) => known.has(c.name));
    if (calls.length) return { text: "", toolCalls: calls, usage: r.usage };
  }
  // No (valid) tool call → treat the reply as the final answer.
  return { text, toolCalls: [], usage: r.usage };
};

/**
 * Native tool-calling turn: hands the model a conversation plus a tool catalog
 * (as real Anthropic/gateway tools) and returns either its tool calls or its
 * final text. The agent runner drives the reason→act loop around this — it
 * executes the returned tool calls itself, appends the results to `messages`,
 * and calls again — so tools are declared here WITHOUT an `execute` (the SDK
 * returns the calls instead of running them).
 *
 * The managed-cloud metered path (Workers AI, used when a cloud project brings
 * no key) can't do native tools, so it falls back to a JSON-simulated tool step
 * (`callCloudToolTurn`) that yields the same shape — no regression for the
 * provisioned-no-key tenants that previously relied on the JSON ReAct loop.
 */
export const callClaudeTools = async (
  env: Env,
  { system, messages, tools, model, maxTokens, effort }: ClaudeToolsRequest,
): Promise<ClaudeToolsResponse> => {
  const hasDirectKey = Boolean(
    env.AI_GATEWAY_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim(),
  );
  if (!hasDirectKey && cloudConfigured(env)) {
    return callCloudToolTurn(env, { system, messages, tools, model });
  }

  const provider = pickProvider(env);
  const modelId = resolveModelId(provider.kind, model);
  const aiModel =
    provider.kind === "gateway"
      ? createGateway({ apiKey: provider.key })(modelId)
      : createAnthropic({ apiKey: provider.key })(modelId);

  const aiTools = tools?.length
    ? Object.fromEntries(
        tools.map((t) => [
          t.name,
          tool({
            description: t.description,
            inputSchema: jsonSchema(
              t.inputSchema as Parameters<typeof jsonSchema>[0],
            ),
          }),
        ]),
      )
    : undefined;

  try {
    const result = await generateText({
      model: aiModel,
      system,
      messages,
      tools: aiTools,
      maxOutputTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      // The big one for agents: each step re-sends system + tool schemas +
      // the whole transcript, so caching turns step N's prompt into step
      // N+1's cache read.
      providerOptions: anthropicProviderOptions(modelId, effort),
    });
    void reportToCloud(env, {
      kind: "ai_usage",
      tokensIn: result.usage?.inputTokens,
      tokensOut: result.usage?.outputTokens,
    });
    return {
      text: result.text,
      toolCalls: (result.toolCalls ?? []).map((c) => ({
        id: c.toolCallId,
        name: c.toolName,
        args: (c.input ?? {}) as Record<string, unknown>,
      })),
      usage: {
        input_tokens: result.usage?.inputTokens,
        output_tokens: result.usage?.outputTokens,
        cache_read_input_tokens: result.usage?.cachedInputTokens,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AppError(
      "UNAVAILABLE",
      `AI provider call failed (${provider.kind}, ${modelId}): ${msg.slice(0, 500)}`,
    );
  }
};

/** Extract the first fenced JSON block from a model reply. Models almost
 *  always wrap structured output in triple-backtick fences; falling back
 *  to whole-message parsing handles the rare bare-JSON reply. Throws if
 *  the result isn't parseable so the calling tool can surface a clear
 *  isError to the agent. */
export const extractJson = <T = unknown>(text: string): T => {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] ?? text;
  try {
    return JSON.parse(candidate.trim()) as T;
  } catch (e) {
    throw new Error(
      `model reply was not valid JSON: ${(e as Error).message}. Raw text:\n${text.slice(0, 500)}`,
    );
  }
};
