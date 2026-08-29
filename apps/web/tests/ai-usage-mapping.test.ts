/**
 * The prompt-cache number, pinned.
 *
 * A turn re-sends the system prompt, the tool schemas and the whole transcript
 * on every step, so prompt caching is the difference between a multi-step agent
 * being affordable and not. `POST …/messages` reports what it saved as
 * `cachedTokens`, and the agent activity log carries the same figure.
 *
 * None of that had a test, and AI SDK 7 is exactly the event it needed one for:
 * the flat `usage.cachedInputTokens` moved to
 * `usage.inputTokenDetails.cacheReadTokens`. Reading the old name on a loosely
 * typed result would have gone on compiling, returned `undefined`, and reported
 * a steady zero — a feature dying with nothing to show for it.
 *
 * These assert the mapping itself, against a value typed as the SDK's own
 * `LanguageModelUsage`. If the SDK moves the field again the TYPES fail first,
 * in CI, before anyone reads a zero and believes it.
 */
import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";
import { usageFromResult } from "../src/server/mcp/ai-client";

const usage = (over: Partial<LanguageModelUsage> = {}): LanguageModelUsage =>
  ({
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    reasoningTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: 200,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    },
    ...over,
  }) as LanguageModelUsage;

describe("AI usage → the shape the rest of the codebase speaks", () => {
  test("cache reads come from inputTokenDetails, not a flat field", () => {
    const mapped = usageFromResult(usage());
    expect(mapped.input_tokens).toBe(1200);
    expect(mapped.output_tokens).toBe(300);
    // The one that silently became zero if this mapping were left on the v6
    // field name.
    expect(mapped.cache_read_input_tokens).toBe(1000);
  });

  test("a cold call reports zero cache reads, not undefined-as-zero by accident", () => {
    const mapped = usageFromResult(
      usage({ inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 1200 } }),
    );
    expect(mapped.cache_read_input_tokens).toBe(0);
  });

  test("a provider that reports no usage at all maps to undefined throughout", () => {
    // The runner does `?? 0` on the way out, so undefined is safe — but it must
    // be undefined rather than a thrown TypeError on a missing details object.
    const mapped = usageFromResult(undefined);
    expect(mapped.input_tokens).toBeUndefined();
    expect(mapped.cache_read_input_tokens).toBeUndefined();
  });

  test("a provider that omits the details object does not throw", () => {
    // Not every provider fills `inputTokenDetails`; the gateway and Workers AI
    // paths in particular are looser than Anthropic's.
    const mapped = usageFromResult({ inputTokens: 10, outputTokens: 2 } as LanguageModelUsage);
    expect(mapped.input_tokens).toBe(10);
    expect(mapped.cache_read_input_tokens).toBeUndefined();
  });
});
