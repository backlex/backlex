/**
 * Provider options for the Anthropic path: prompt caching (always on) and
 * reasoning effort (gated by model).
 *
 * The gate is the load-bearing part — `output_config.effort` is a 400 on
 * Haiku 4.5 / Sonnet 4.5, so an agent left on a cheap model with effort set
 * would fail every turn rather than silently ignoring the setting.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import {
  AI_EFFORTS,
  anthropicProviderOptions,
  hasDirectAiCredential,
  pickProvider,
} from "../src/server/mcp/ai-client";
import type { Env } from "../src/server/env";

const env = (over: Partial<Env>): Env => ({ ...over } as Env);

describe("anthropic provider options", () => {
  test("prompt caching is always requested", () => {
    for (const model of [
      "claude-haiku-4-5",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5",
    ]) {
      expect(anthropicProviderOptions(model).anthropic.cacheControl).toEqual({
        type: "ephemeral",
      });
    }
  });

  test("effort is sent to models that support it, with or without a gateway prefix", () => {
    for (const model of [
      "claude-opus-4-8",
      "anthropic/claude-opus-4-8",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-opus-4-5",
    ]) {
      expect(anthropicProviderOptions(model, "low").anthropic.effort).toBe("low");
    }
  });

  test("effort is dropped for models that would 400 on it", () => {
    for (const model of [
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4-5",
      "claude-sonnet-4-5",
      "@cf/meta/llama-3.1-8b-instruct-fp8",
    ]) {
      expect(anthropicProviderOptions(model, "low").anthropic.effort).toBeUndefined();
    }
  });

  test("no effort set → parameter absent entirely (provider default)", () => {
    expect(anthropicProviderOptions("claude-opus-4-8").anthropic.effort).toBeUndefined();
  });

  test("the admin-facing effort list matches what the gate accepts", () => {
    for (const effort of AI_EFFORTS) {
      expect(anthropicProviderOptions("claude-opus-4-8", effort).anthropic.effort).toBe(
        effort,
      );
    }
  });

  test("an OAuth credential asks for the oauth beta; an API key doesn't", () => {
    expect(anthropicProviderOptions("claude-opus-4-8", undefined, true).anthropic).toMatchObject(
      { anthropicBeta: ["oauth-2025-04-20"] },
    );
    expect(
      anthropicProviderOptions("claude-opus-4-8").anthropic.anthropicBeta,
    ).toBeUndefined();
  });
});

describe("AI credential resolution", () => {
  test("gateway key wins, then API key, then OAuth token", () => {
    expect(
      pickProvider(
        env({
          AI_GATEWAY_API_KEY: "gw",
          ANTHROPIC_API_KEY: "sk",
          ANTHROPIC_AUTH_TOKEN: "oat",
        }),
      ),
    ).toEqual({ kind: "gateway", key: "gw" });

    expect(
      pickProvider(env({ ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "oat" })),
    ).toEqual({ kind: "anthropic", key: "sk" });

    // Only a token: flagged as oauth so it rides Authorization: Bearer rather
    // than x-api-key (the API rejects a request carrying both).
    expect(pickProvider(env({ ANTHROPIC_AUTH_TOKEN: "oat" }))).toEqual({
      kind: "anthropic",
      key: "oat",
      oauth: true,
    });
  });

  test("whitespace-only credentials don't count as configured", () => {
    expect(hasDirectAiCredential(env({ ANTHROPIC_AUTH_TOKEN: "   " }))).toBe(false);
    expect(() => pickProvider(env({ ANTHROPIC_AUTH_TOKEN: "   " }))).toThrow();
  });

  test("an OAuth token alone satisfies the direct-credential check", () => {
    // Otherwise a managed-cloud project holding only a token would silently
    // route to the metered platform gateway instead of using it.
    expect(hasDirectAiCredential(env({ ANTHROPIC_AUTH_TOKEN: "oat" }))).toBe(true);
    expect(hasDirectAiCredential(env({}))).toBe(false);
  });
});

/**
 * What actually goes on the wire. These options are only worth anything if they
 * survive the AI SDK's request building, and the OAuth failure mode is silent:
 * an `x-api-key` sent alongside `Authorization` is rejected by the API, and a
 * missing beta header fails the same way — neither shows up in a type check.
 */
describe("outbound request shape", () => {
  const capture = async (opts: {
    authToken?: string;
    apiKey?: string;
    oauth?: boolean;
    effort?: "low" | "medium" | "high";
  }) => {
    let captured: Request | null = null;
    const fakeFetch = (async (input: string, init?: RequestInit) => {
      captured = new Request(input, init);
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const model = createAnthropic(
      opts.authToken
        ? { authToken: opts.authToken, fetch: fakeFetch }
        : { apiKey: opts.apiKey, fetch: fakeFetch },
    )("claude-opus-4-8");

    await generateText({
      model,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      providerOptions: anthropicProviderOptions("claude-opus-4-8", opts.effort, opts.oauth),
    });
    const req = captured as unknown as Request;
    return { headers: req.headers, body: (await req.json()) as Record<string, any> };
  };

  test("an OAuth token rides Authorization: Bearer with the oauth beta, and no x-api-key", async () => {
    const { headers } = await capture({ authToken: "oat-test", oauth: true });
    expect(headers.get("authorization")).toBe("Bearer oat-test");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  test("an API key rides x-api-key, with no Authorization and no oauth beta", async () => {
    const { headers } = await capture({ apiKey: "sk-test" });
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-beta") ?? "").not.toContain("oauth");
  });

  test("caching and effort reach the request body", async () => {
    const { body } = await capture({ apiKey: "sk-test", effort: "low" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.output_config).toMatchObject({ effort: "low" });
  });
});
