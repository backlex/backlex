/**
 * AI usage in the ledger.
 *
 * `usage_counters` measured requests, errors, stored bytes and row counts —
 * everything the product spends EXCEPT the one thing that costs per call. A
 * workspace could not answer "how much AI did I use this month".
 *
 * The two things worth pinning are both about honesty rather than plumbing:
 * AI is counted SEPARATELY from requests (a flow step or an agent turn
 * generates without a request of its own, so it can never be derived from the
 * request count), and the two provider paths report different quantities
 * (tokens vs neurons) into different columns rather than into one whose
 * meaning depends on the deployment.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  aiMeterForTenant,
  bumpAiUsage,
  bumpUsage,
  flushUsage,
  monthUsageByKey,
  resetUsageState,
  usageOverview,
  usageRows,
} from "../src/server/services/usage";
import { callClaude } from "../src/server/mcp/ai-client";
import type { Env } from "../src/server/env";

describe("AI usage counters", () => {
  let h: TestHarness;
  let ctx: Awaited<ReturnType<typeof buildContext>>;
  let tenantId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    ctx = await buildContext(h.env);
    const res = await h.fetch("/api/tenants");
    const body = (await res.json()) as { data: { id: string }[] };
    tenantId = body.data[0]!.id;
    resetUsageState();
  });

  afterAll(() => h.cleanup());

  const now = () => (work: Promise<unknown>) => void work;

  // The ledger row is keyed by (workspace, API key, UTC day) and `resetUsageState`
  // only drops the in-memory buffer — rows already written stay. Each test gets
  // its own key bucket so it reads its own writes rather than the sum of every
  // test that ran before it.
  let bucketSeq = 0;
  const bucket = () => `k_${++bucketSeq}`;
  const rowFor = async (key: string) =>
    (await usageRows(ctx, tenantId, 1)).find((r) => r.apiKeyId === key);

  test("a generation is counted, and is not a request", async () => {
    const key = bucket();
    bumpAiUsage(ctx, { tenantId, apiKeyId: key, tokensIn: 100, tokensOut: 20 }, now());
    await flushUsage(ctx);

    const row = await rowFor(key);
    expect(row?.aiCalls).toBe(1);
    expect(row?.aiTokensIn).toBe(100);
    expect(row?.aiTokensOut).toBe(20);
    // The point of a separate counter: nothing was requested.
    expect(row?.requests).toBe(0);
  });

  test("a request and the generation it made coalesce into one row", async () => {
    const key = bucket();
    bumpUsage(ctx, { tenantId, apiKeyId: key }, now());
    bumpAiUsage(ctx, { tenantId, apiKeyId: key, tokensIn: 7, tokensOut: 3 }, now());
    await flushUsage(ctx);

    const rows = (await usageRows(ctx, tenantId, 1)).filter((r) => r.apiKeyId === key);
    expect(rows.length).toBe(1);
    expect(rows[0]?.requests).toBe(1);
    expect(rows[0]?.aiCalls).toBe(1);
  });

  test("tokens and neurons land in different columns", async () => {
    const key = bucket();
    bumpAiUsage(ctx, { tenantId, apiKeyId: key, tokensIn: 10, tokensOut: 5 }, now()); // direct
    bumpAiUsage(ctx, { tenantId, apiKeyId: key, neurons: 42 }, now()); // managed cloud
    await flushUsage(ctx);

    const row = await rowFor(key);
    expect(row?.aiCalls).toBe(2);
    expect(row?.aiTokensIn).toBe(10);
    expect(row?.aiNeurons).toBe(42);
  });

  test("a provider that reports nothing still counts as a call", async () => {
    // "One call, cost unknown" is a truer ledger entry than silence — and it
    // is what keeps a call count from quietly depending on which provider
    // happens to be configured.
    const key = bucket();
    bumpAiUsage(ctx, { tenantId, apiKeyId: key }, now());
    await flushUsage(ctx);
    const row = await rowFor(key);
    expect(row?.aiCalls).toBe(1);
    expect(row?.aiTokensIn).toBe(0);
    expect(row?.aiNeurons).toBe(0);
  });

  test("a garbled provider figure cannot poison an additive counter", async () => {
    // These counters only ever grow, so one NaN or negative would never wash
    // out — the row would read wrong for the life of the workspace.
    const key = bucket();
    bumpAiUsage(
      ctx,
      { tenantId, apiKeyId: key, tokensIn: Number.NaN, tokensOut: -5, neurons: 1.6 },
      now(),
    );
    await flushUsage(ctx);
    const row = await rowFor(key);
    expect(row?.aiTokensIn).toBe(0);
    expect(row?.aiTokensOut).toBe(0);
    expect(row?.aiNeurons).toBe(2);
  });

  test("the month view totals AI alongside requests", async () => {
    const key = bucket();
    const overview = () => usageOverview({ ...ctx, env: h.env }, tenantId, 7, []);
    const before = await overview();
    bumpUsage(ctx, { tenantId, apiKeyId: key }, now());
    bumpAiUsage(ctx, { tenantId, apiKeyId: key, tokensIn: 60, tokensOut: 40 }, now());
    await flushUsage(ctx);

    const byKey = await monthUsageByKey(ctx, tenantId);
    expect(byKey.get(key)?.aiCalls).toBe(1);
    expect(byKey.get(key)?.aiTokensIn).toBe(60);

    // The month total is a sum over every bucket, so assert the DELTA — the
    // figure this test is responsible for — rather than the running total.
    const after = await overview();
    expect(after.monthTotals.aiCalls - before.monthTotals.aiCalls).toBe(1);
    expect(after.monthTotals.aiTokensIn - before.monthTotals.aiTokensIn).toBe(60);
    expect(after.monthTotals.aiTokensOut - before.monthTotals.aiTokensOut).toBe(40);
  });

  test("usage is attributed to the API key that spent it", async () => {
    bumpAiUsage(ctx, { tenantId, apiKeyId: "key_1", tokensIn: 11 }, now());
    await flushUsage(ctx);
    const byKey = await monthUsageByKey(ctx, tenantId);
    expect(byKey.get("key_1")?.aiTokensIn).toBe(11);
  });
});

describe("the meter reaches callClaude", () => {
  /** A control plane over a service binding, so a generation is intercepted
   *  without touching global `fetch`. */
  const cloudEnv = {
    CLOUD_REPORT_SECRET: "shh",
    CLOUD_PROJECT_ID: "proj_1",
    CLOUD_REPORT_SERVICE: {
      fetch: async () =>
        new Response(JSON.stringify({ response: "hi", neurons: 9 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  } as unknown as Env;

  test("the sink is handed what the provider reported", async () => {
    const seen: unknown[] = [];
    await callClaude(cloudEnv, { user: "u" }, (usage) => seen.push(usage));
    expect(seen).toEqual([{ neurons: 9 }]);
  });

  test("`null` is a decision, and it is respected", async () => {
    // The parameter is required precisely so that "not attributable" is spelled
    // out rather than looking like a forgotten argument.
    const reply = await callClaude(cloudEnv, { user: "u" }, null);
    expect(reply.text).toBe("hi");
  });

  test("no workspace means no sink", () => {
    expect(aiMeterForTenant({ db: {}, dialect: "sqlite" }, null)).toBeNull();
    expect(aiMeterForTenant(null, "tenant_1")).toBeNull();
  });
});
