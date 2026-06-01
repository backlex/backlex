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
import { generateText } from "ai";
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
}

export interface ClaudeResponse {
  text: string;
  /** Token counts surfaced for callers that want to show usage in their
   *  tool output. Field names mirror the legacy Anthropic shape so the
   *  existing `structuredContent.usage` consumers keep working. */
  usage?: { input_tokens?: number; output_tokens?: number };
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
  { system, user, model, maxTokens }: ClaudeRequest,
): Promise<ClaudeResponse> => {
  // Managed cloud projects route generation through the metered/capped gateway.
  if (cloudConfigured(env)) return callCloudGeneration(env, { system, user, model, maxTokens });

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
