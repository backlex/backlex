/**
 * Tiny Claude-API caller for the `ai.*` tools. We hand-roll the messages
 * request instead of pulling in `@anthropic-ai/sdk` so the Worker bundle
 * stays small and the same code runs identically under Bun, CF Workers,
 * Vercel, and Netlify. Anthropic's HTTPS endpoint is the one upstream all
 * four runtimes can reach.
 *
 * Authentication: `env.ANTHROPIC_API_KEY` (workspace-level). Workspaces
 * without the key get a clear UNAVAILABLE error from each `ai.*` tool —
 * the operator is told exactly what to set.
 */
import { AppError } from "@workeros/core";
import type { Env } from "../env";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 4096;

export interface ClaudeRequest {
  system?: string;
  user: string;
  /** Override the default model. Cheap/fast operations stay on Haiku; tools
   *  that want richer reasoning (schema design from prose) can opt up. */
  model?: string;
  maxTokens?: number;
}

export interface ClaudeResponse {
  text: string;
  /** Raw upstream usage block for callers that want to surface token
   *  counts in their tool output. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

const requireKey = (env: Env): string => {
  const key = env.ANTHROPIC_API_KEY;
  if (!key || !key.trim()) {
    throw new AppError(
      "UNAVAILABLE",
      "ANTHROPIC_API_KEY is not configured for this workspace. AI-native tools require it — set the env var on the workeros deployment.",
    );
  }
  return key.trim();
};

export const callClaude = async (
  env: Env,
  { system, user, model, maxTokens }: ClaudeRequest,
): Promise<ClaudeResponse> => {
  const apiKey = requireKey(env);
  const body: Record<string, unknown> = {
    model: model ?? DEFAULT_MODEL,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content: user }],
  };
  if (system) body.system = system;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
  return { text, usage: data.usage };
};

/** Extract the first fenced JSON block from a Claude reply. Claude almost
 *  always wraps structured output in triple-backtick fences; falling back
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
