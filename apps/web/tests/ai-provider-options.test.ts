/**
 * Provider options for the Anthropic path: prompt caching (always on) and
 * reasoning effort (gated by model).
 *
 * The gate is the load-bearing part — `output_config.effort` is a 400 on
 * Haiku 4.5 / Sonnet 4.5, so an agent left on a cheap model with effort set
 * would fail every turn rather than silently ignoring the setting.
 */
import { describe, expect, test } from "bun:test";
import { AI_EFFORTS, anthropicProviderOptions } from "../src/server/mcp/ai-client";

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
});
