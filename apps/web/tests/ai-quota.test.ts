/**
 * The monthly AI budget, behaviourally.
 *
 * `ai-quota-gate.test.ts` proves every generating file ASKS. This one proves
 * the asking refuses, on the path that motivated the budget: a flow step, which
 * can be cron-triggered and can sit inside a `foreach` that runs it once per
 * row up to five hundred times with nobody watching.
 *
 * The unit is CALLS rather than tokens, and that is not a simplification: a
 * direct provider key returns token counts and the managed-cloud gateway
 * returns neurons and no tokens, so a token ceiling would be unenforceable on
 * cloud and a neuron one unenforceable on self-host. `aiCalls` is the one
 * figure both paths produce.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildContext } from "../src/server/context";
import {
  bumpAiUsage,
  flushUsage,
  resetUsageState,
  usageOverview,
} from "../src/server/services/usage";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BYO_KEY = "sk-ant-test-quota";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const anthropicReply = (text: string): Response =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const installAnthropicMock = (): { calls: number; restore: () => void } => {
  const real = globalThis.fetch;
  const state = { calls: 0, restore: () => void (globalThis.fetch = real) };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/")) {
      state.calls++;
      return anthropicReply("ok");
    }
    return real(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return state;
};

describe("monthly AI budget", () => {
  let h: TestHarness;

  beforeEach(async () => {
    // The month sums AND the resolved limits are cached in module-level maps
    // keyed by tenant id, and a fresh harness can hand out the same default
    // tenant id as the last one — so without this a test inherits the previous
    // one's cap and refuses where it should not.
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
    const cfg = await h.fetch("/api/admin/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", secrets: { anthropicKey: BYO_KEY } }),
    });
    expect(cfg.status).toBe(200);
  });
  afterEach(() => h.cleanup());

  const tenantId = async () =>
    ((await (await h.fetch("/api/tenants")).json()) as { data: { id: string }[] }).data[0]!.id;

  /** The endpoint takes every dimension explicitly — `null` is "unlimited",
   *  and omitting one is a 422 rather than a silent keep. */
  const setLimits = async (limits: Record<string, unknown>) => {
    const res = await h.fetch(
      "/api/admin/usage/limits",
      json(
        {
          mode: "off",
          maxRequestsPerMonth: null,
          maxStorageBytes: null,
          maxDbRows: null,
          maxAiCallsPerMonth: null,
          ...limits,
        },
        "PUT",
      ),
    );
    if (res.status >= 300) throw new Error(`${res.status} ${await res.text()}`);
  };

  /** Run a one-step AI flow and report the outcome. */
  const runAiFlow = async () => {
    const created = await h.fetch(
      "/api/flows",
      json({
        name: `q-${Math.random().toString(36).slice(2)}`,
        trigger: "manual:",
        operations: [{ type: "ai.generate", prompt: "hi" }],
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${data.id}/run`, json({}));
    return (await res.json()) as { ok: boolean; error?: string };
  };

  test("under the cap a flow generates normally", async () => {
    await setLimits({ mode: "hard", maxAiCallsPerMonth: 5 });
    const mock = installAnthropicMock();
    try {
      expect(await runAiFlow()).toEqual({ ok: true });
      expect(mock.calls).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("at the cap the flow is refused BEFORE the provider is called", async () => {
    const tid = await tenantId();
    const ctx = await buildContext(h.env);
    await setLimits({ mode: "hard", maxAiCallsPerMonth: 2 });
    // Two generations already spent this month.
    bumpAiUsage(ctx, { tenantId: tid, apiKeyId: "", tokensIn: 1, tokensOut: 1 }, (w) => void w);
    bumpAiUsage(ctx, { tenantId: tid, apiKeyId: "", tokensIn: 1, tokensOut: 1 }, (w) => void w);
    await flushUsage(ctx);

    const mock = installAnthropicMock();
    try {
      const out = await runAiFlow();
      expect(out.ok).toBe(false);
      expect(out.error).toContain("monthly AI limit");
      // Refused rather than billed and then told — the whole point of checking
      // before the spend.
      expect(mock.calls).toBe(0);
    } finally {
      mock.restore();
    }
  });

  test("`soft` mode reports the overage and blocks nothing", async () => {
    const tid = await tenantId();
    const ctx = await buildContext(h.env);
    await setLimits({ mode: "soft", maxAiCallsPerMonth: 1 });
    bumpAiUsage(ctx, { tenantId: tid, apiKeyId: "", tokensIn: 1, tokensOut: 1 }, (w) => void w);
    await flushUsage(ctx);

    const mock = installAnthropicMock();
    try {
      expect(await runAiFlow()).toEqual({ ok: true });
      expect(mock.calls).toBe(1);
    } finally {
      mock.restore();
    }
    const overview = await usageOverview({ ...ctx, env: h.env }, tid, 30, []);
    expect(overview.over).toContain("ai");
  });

  test("with no AI cap set, nothing changes", async () => {
    // The budget is opt-in: a workspace that never set one must not start
    // being refused because the dimension now exists.
    await setLimits({ mode: "hard", maxRequestsPerMonth: 1_000_000 });
    const mock = installAnthropicMock();
    try {
      expect(await runAiFlow()).toEqual({ ok: true });
    } finally {
      mock.restore();
    }
  });

  test("the overage is reported per dimension, not as one flag", async () => {
    const tid = await tenantId();
    const ctx = await buildContext(h.env);
    await setLimits({ mode: "hard", maxAiCallsPerMonth: 1 });
    bumpAiUsage(ctx, { tenantId: tid, apiKeyId: "", tokensIn: 1, tokensOut: 1 }, (w) => void w);
    await flushUsage(ctx);
    const overview = await usageOverview({ ...ctx, env: h.env }, tid, 30, []);
    expect(overview.over).toEqual(["ai"]);
    expect(overview.limits.maxAiCallsPerMonth).toBe(1);
    expect(overview.monthTotals.aiCalls).toBeGreaterThanOrEqual(1);
  });
});
