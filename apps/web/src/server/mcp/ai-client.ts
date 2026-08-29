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
import {
  generateText,
  jsonSchema,
  tool,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { AppError } from "@backlex/core";
import { cloudConfigured, cloudPost, reportToCloud } from "../lib/cloud-report";
import {
  AI_PROVIDERS,
  getAiProvider,
  type AiProviderId,
} from "../services/ai-providers";
import type { Env } from "../env";

const DEFAULT_GATEWAY_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 4096;

export interface ClaudeRequest {
  system?: string;
  user: string;
  /** Override the default model. Cheap/fast operations stay on Haiku; tools
   *  that want richer reasoning (schema design from prose) can opt up. In
   *  gateway mode pass either a bare id (`claude-sonnet-5`) or a
   *  provider-prefixed id (`openai/gpt-5.6-terra`). */
  model?: string;
  maxTokens?: number;
  /** Reasoning effort; ignored on models that don't support it. */
  effort?: AiEffort;
  /** Abort the generation when this fires.
   *
   *  Optional because most callers sit inside something that already has a
   *  ceiling above them — a Worker invocation, an MCP tool call, an HTTP
   *  request. The caller that needs it is the one with nothing above it: a flow
   *  step is dispatched fire-and-forget with no retry and no dead-letter queue,
   *  so a generation that never returns is a run that never ends. Honoured on
   *  BOTH transports; a ceiling that bound only the direct path would be a
   *  ceiling that silently disappeared on managed cloud. */
  signal?: AbortSignal;
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
    /** Workers AI neurons, on the managed-cloud path only. That gateway meters
     *  authoritatively in neurons and does not return token counts, so this is
     *  what the call actually cost — deriving a token figure from it would be a
     *  number nobody could reconcile with a bill. */
    neurons?: number;
  };
}

type Provider = AiProviderId;

export interface AiCredential {
  kind: Provider;
  key: string;
  /** True when `key` is an OAuth bearer token (`ANTHROPIC_AUTH_TOKEN`) rather
   *  than an API key: it goes on `Authorization: Bearer`, never `x-api-key`,
   *  and needs the `oauth-2025-04-20` beta. */
  oauth?: boolean;
}

/**
 * Resolve which credential to generate with, or `null` when none is configured.
 *
 * Two stages, and the ordering is load-bearing:
 *
 *  1. **Explicit pick** — `AI_PROVIDER` names a registry entry and that entry's
 *     env key is present. This is what a workspace's bring-your-own provider
 *     choice sets (`applyAiOverride`), and it is the ONLY way `openai` /
 *     `google` are reached. `OPENAI_API_KEY` is already set on plenty of
 *     deployments purely for embeddings; auto-promoting it to the generation
 *     credential would silently reroute and re-bill every AI feature, so the
 *     sniffing chain below deliberately ignores it.
 *  2. **Auto-detect** — the historical order: gateway key, then the legacy
 *     direct Anthropic key, then a short-lived Anthropic OAuth bearer token.
 *
 * An `AI_PROVIDER` naming an unknown provider (a value written by a newer build,
 * or a typo) falls through to stage 2 rather than throwing — a bad config value
 * degrades to the deployment default instead of taking AI offline.
 *
 * `ANTHROPIC_AUTH_TOKEN` exists so a deployment doesn't have to store a
 * long-lived API key: it holds a short-lived token minted elsewhere (e.g.
 * `ant auth print-credentials --access-token` on a developer machine, or a
 * federation exchange in CI). It expires and is NOT auto-refreshed here, which
 * is exactly why it stays deployment-level env and is not offered as a
 * workspace BYO secret — a tenant pasting one into Settings · AI would watch
 * it stop working within the hour.
 */
export const resolveAiCredential = (env: Env): AiCredential | null => {
  const forced = getAiProvider(env.AI_PROVIDER?.trim());
  if (forced) {
    // `envKey` is a union of real `Env` keys, so this stays type-checked.
    const key = env[forced.envKey];
    if (typeof key === "string" && key.trim())
      return { kind: forced.id, key: key.trim() };
    // Anthropic can still be satisfied by the OAuth bearer token.
    if (forced.id === "anthropic") {
      const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
      if (token) return { kind: "anthropic", key: token, oauth: true };
    }
  }
  const gw = env.AI_GATEWAY_API_KEY?.trim();
  if (gw) return { kind: "gateway", key: gw };
  const direct = env.ANTHROPIC_API_KEY?.trim();
  if (direct) return { kind: "anthropic", key: direct };
  const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (token) return { kind: "anthropic", key: token, oauth: true };
  return null;
};

/** Is any direct provider credential configured on this env? Used to decide
 *  whether to route through the managed-cloud gateway instead.
 *
 *  This answers "whose key pays for it", NOT "can this deployment do AI" —
 *  for that, ask {@link aiAvailable}. */
export const hasDirectAiCredential = (env: Env): boolean =>
  resolveAiCredential(env) !== null;

/**
 * Can this deployment generate at all — by any route?
 *
 * The same question {@link callClaude} settles before it dispatches: a direct
 * provider credential, or a provisioned cloud project whose generation runs on
 * the platform gateway. Anything that gates a FEATURE on the presence of AI has
 * to ask this one.
 *
 * Asking `hasDirectAiCredential` instead is how every `ai.*` MCP tool came to
 * refuse with "No AI provider configured for this workspace" on managed cloud —
 * the deployment where AI is a platform feature the customer never configures,
 * and where the same request would have reached the gateway had it got one line
 * further.
 */
export const aiAvailable = (env: Env): boolean =>
  hasDirectAiCredential(env) || cloudConfigured(env);

/** {@link resolveAiCredential}, but throwing the actionable setup error when
 *  nothing is configured. */
export const pickProvider = (env: Env): AiCredential => {
  const cred = resolveAiCredential(env);
  if (cred) return cred;
  throw new AppError(
    "UNAVAILABLE",
    `No AI provider configured for this workspace — set AI_GATEWAY_API_KEY (recommended, multi-provider), the legacy ANTHROPIC_API_KEY, a short-lived ANTHROPIC_AUTH_TOKEN, or AI_PROVIDER plus one of ${AI_PROVIDERS.map((p) => p.envKey).join(" / ")} on the backlex deployment.`,
  );
};

/** Build the AI-SDK model for a resolved credential. An OAuth token uses the
 *  provider's `authToken` option, which sends `Authorization: Bearer` and
 *  omits `x-api-key` — sending both is rejected by the API. */
const modelFor = (cred: AiCredential, modelId: string) => {
  switch (cred.kind) {
    case "gateway":
      return createGateway({ apiKey: cred.key })(modelId);
    case "openai":
      return createOpenAI({ apiKey: cred.key })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: cred.key })(modelId);
    default:
      return cred.oauth
        ? createAnthropic({ authToken: cred.key })(modelId)
        : createAnthropic({ apiKey: cred.key })(modelId);
  }
};

/** Reasoning effort. Lower effort = fewer thinking tokens and fewer, more
 *  consolidated tool calls — the cheapest quality/cost dial there is. */
export type AiEffort = "low" | "medium" | "high";

export const AI_EFFORTS: readonly AiEffort[] = ["low", "medium", "high"] as const;

/** `output_config.effort` is GA only on the newer Claude tiers — sending it to
 *  Haiku 4.5 or Sonnet 4.5 is a 400, not a no-op. Gate on the resolved id so a
 *  workspace that picked a cheap model can't break its own agent by setting
 *  effort. (Matches with or without a gateway `anthropic/` prefix.) */
const EFFORT_CAPABLE =
  /claude-(opus-5|opus-4-[5-9]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

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
  oauth?: boolean,
): { anthropic: Record<string, JSONValue> } => ({
  anthropic: {
    cacheControl: { type: "ephemeral" },
    ...(effort && EFFORT_CAPABLE.test(modelId) ? { effort } : {}),
    // OAuth bearer tokens need this beta on /v1/messages. Passing it as a
    // provider option (rather than a raw header) lets the provider union it
    // with whatever feature betas the request already needs.
    ...(oauth ? { anthropicBeta: ["oauth-2025-04-20"] } : {}),
  },
});

/**
 * Normalize a stored/requested model id for the transport it is about to go out
 * over. Model ids are stored gateway-style (`anthropic/claude-haiku-4-5`) on
 * every surface, so this is the one place that knows about prefixes.
 *
 *  - **gateway** — pass provider-prefixed ids through. A BARE id (no `/`) is a
 *    setting saved before the catalog existed, when bare meant Anthropic; it
 *    still gets the `anthropic/` prefix so those rows keep working.
 *  - **direct** — strip this vendor's own prefix. An id carrying a DIFFERENT
 *    vendor's prefix (`openai/gpt-5` on a direct Anthropic key) cannot run:
 *    rather than forwarding a guaranteed 404, fall back to the provider's
 *    default so a stale cross-provider model id degrades instead of breaking.
 */
export const resolveModelId = (
  provider: Provider,
  model: string | undefined,
): string => {
  const def = getAiProvider(provider);
  if (!def || def.transport === "gateway") {
    if (!model) return def?.defaultModel ?? DEFAULT_GATEWAY_MODEL;
    return model.includes("/") ? model : `${def?.namespace ?? "anthropic"}/${model}`;
  }
  const fallback =
    def.directDefaultModel ?? def.defaultModel.slice(def.namespace.length + 1);
  if (!model) return fallback;
  const prefix = `${def.namespace}/`;
  if (model.startsWith(prefix)) return model.slice(prefix.length);
  return model.includes("/") ? fallback : model;
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
  // `maxTokens` is deliberately not destructured: the gateway takes no such
  // parameter and applies its own fixed 8192-token ceiling, because the
  // reasoning models it fronts spend a large part of any smaller budget on
  // their thinking pass and return an empty answer. Named here so the next
  // reader does not go looking for where the caller's value went.
  { system, user, model, signal }: ClaudeRequest,
): Promise<ClaudeResponse> => {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const cfModel = model && model.startsWith("@cf/") ? model : undefined;
  let res: Response;
  try {
    res = await cloudPost(env, "/api/internal/ai/generate", { messages, ...(cfModel ? { model: cfModel } : {}) }, signal);
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
  const json = (await res.json()) as { response?: string; neurons?: number };
  // Carry the cost through. The gateway meters this call authoritatively and
  // answers with what it charged; dropping it made managed-cloud generation the
  // one path in the product that reported no cost at all, which reads as free
  // rather than as measured elsewhere. Absent stays absent — a gateway that did
  // not say is not a gateway that said zero.
  return {
    text: json.response ?? "",
    ...(typeof json.neurons === "number" ? { usage: { neurons: json.neurons } } : {}),
  };
};

/**
 * Where a generation's cost is recorded.
 *
 * A plain callback rather than a db handle: this module knows how to generate,
 * not which workspace is paying — the tenant lives on the request, and `env` is
 * per-deployment. The caller closes over what it knows.
 *
 * `null` is the "genuinely not attributable" answer, and it is spelled out
 * rather than left to an optional parameter on purpose: an omitted argument is
 * indistinguishable from a forgotten one, and a generation nobody counted is
 * exactly the failure this ledger exists to end.
 */
export type AiMeterSink = ((usage: NonNullable<ClaudeResponse["usage"]>) => void) | null;

/**
 * The SDK's usage object in the shape the rest of this codebase speaks.
 *
 * Exported and typed against `LanguageModelUsage` on purpose: AI SDK 7 moved
 * the cache counters from a flat `cachedInputTokens` to
 * `inputTokenDetails.cacheReadTokens`, and reading the old name would have gone
 * on compiling as `undefined` — zeroing the prompt-cache number the agent loop
 * exists to make visible, with nothing failing. Pinning the mapping in one
 * typed function means the next move breaks the build instead.
 *
 * `inputTokenDetails.cacheWriteTokens` is the other half of the caching trade
 * (the ~1.25× write premium) and is available here when a surface wants it.
 */
export const usageFromResult = (
  usage: LanguageModelUsage | undefined,
): { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } => ({
  input_tokens: usage?.inputTokens,
  output_tokens: usage?.outputTokens,
  cache_read_input_tokens: usage?.inputTokenDetails?.cacheReadTokens,
});

/**
 * Generate, and record what it cost.
 *
 * The one chokepoint every AI path in the product goes through — MCP tools,
 * Ask AI, agent turns, mention replies, translation — so metering here covers
 * all of them, on both the direct-provider and managed-cloud routes.
 */
export const callClaude = async (
  env: Env,
  req: ClaudeRequest,
  meter: AiMeterSink,
): Promise<ClaudeResponse> => {
  const reply = await generate(env, req);
  // Counted even when the provider reported no figures: a generation happened,
  // and "one call, cost unknown" is a truer ledger entry than silence.
  if (meter) meter(reply.usage ?? {});
  return reply;
};

const generate = async (
  env: Env,
  { system, user, model, maxTokens, effort, signal }: ClaudeRequest,
): Promise<ClaudeResponse> => {
  // A direct provider key wins over the managed cloud gateway. On self-host
  // that's the deployment's env key; on managed cloud it only appears when a
  // workspace brought its own key (overlaid via applyAiOverride from
  // services/ai-config), which is exactly the opt-out from the metered/capped
  // platform gateway. With no direct key, a cloud project falls back to the
  // gateway; self-host with no key throws the helpful "set a key" error below.
  const hasDirectKey = hasDirectAiCredential(env);
  if (!hasDirectKey && cloudConfigured(env))
    return callCloudGeneration(env, { system, user, model, maxTokens, signal });

  const provider = pickProvider(env);
  const modelId = resolveModelId(provider.kind, model);
  // The provider is constructed with the key from `env` instead of
  // `process.env`, which doesn't exist on CF Workers.
  const aiModel = modelFor(provider, modelId);

  try {
    const result = await generateText({
      model: aiModel,
      instructions: system,
      messages: [{ role: "user", content: user }],
      maxOutputTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      providerOptions: anthropicProviderOptions(modelId, effort, provider.oauth),
      ...(signal ? { abortSignal: signal } : {}),
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
      usage: usageFromResult(result.usage),
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
  const hasDirectKey = hasDirectAiCredential(env);
  if (!hasDirectKey && cloudConfigured(env)) {
    return callCloudToolTurn(env, { system, messages, tools, model });
  }

  const provider = pickProvider(env);
  const modelId = resolveModelId(provider.kind, model);
  const aiModel = modelFor(provider, modelId);

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
      instructions: system,
      messages,
      tools: aiTools,
      maxOutputTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      // The big one for agents: each step re-sends system + tool schemas +
      // the whole transcript, so caching turns step N's prompt into step
      // N+1's cache read.
      providerOptions: anthropicProviderOptions(modelId, effort, provider.oauth),
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
      usage: usageFromResult(result.usage),
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
