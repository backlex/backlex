import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { resetUsageState } from "../src/server/services/usage";

/**
 * Multi-surface parity for usage metering (#12). Pins REST + SDK + GraphQL +
 * MCP to the same `/api/admin/usage` semantics — all four go through the ONE
 * `usageOverview` / `saveUsageLimits` service pair, so a divergence here means
 * a surface grew its own logic. CLI rides the same REST endpoints via
 * `client.request` (no separate server logic to pin).
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const LIMITS = {
  mode: "soft" as const,
  maxRequestsPerMonth: 4242,
  maxStorageBytes: null,
  maxDbRows: null,
  // A number rather than the `null` the other unset limits carry: this is the
  // newest limit and it had no round-trip coverage at all, so a value proves it
  // survives the save and comes back on both surfaces.
  maxAiCallsPerMonth: 500,
};

describe("usage — REST + SDK surface", () => {
  let h: TestHarness;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("overview shape + setLimits round-trip through the SDK", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    const saved = await client.usage.setLimits(LIMITS);
    expect(saved.ok).toBe(true);

    const { data } = await client.usage.overview({ days: 7 });
    expect(data.days).toBe(7);
    expect(/^\d{4}-\d{2}$/.test(data.month)).toBe(true);
    expect(Array.isArray(data.series)).toBe(true);
    expect(Array.isArray(data.keySeries)).toBe(true);
    expect(data.settingsLimits).toEqual(LIMITS);
    expect(data.limits).toEqual(LIMITS); // no env pins in this harness
    expect(data.envPinned).toEqual([]);
    // The session bucket is always present and first.
    expect(data.byKey[0]?.id).toBe("");
    expect(data.byKey[0]?.name).toBe("Sessions & admin");
  });

  test("a quota'd key appears in byKey with its budget even before any usage", async () => {
    const mint = await h.fetch(
      "/api/api-keys",
      json({ name: "budgeted", monthlyQuota: 99, rateLimitPerMinute: 10 }),
    );
    expect(mint.status).toBe(201);
    const keyId = ((await mint.json()) as { data: { id: string } }).data.id;

    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    const { data } = await client.usage.overview();
    const row = data.byKey.find((k) => k.id === keyId);
    expect(row).toBeDefined();
    expect(row!.monthlyQuota).toBe(99);
    expect(row!.rateLimitPerMinute).toBe(10);
    expect(row!.monthRequests).toBe(0);
  });

  test("per-key limits PATCH is admin-gated and round-trips", async () => {
    const mint = await h.fetch("/api/api-keys", json({ name: "patch-me" }));
    const keyId = ((await mint.json()) as { data: { id: string } }).data.id;
    const patch = await h.fetch(`/api/api-keys/${keyId}/limits`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monthlyQuota: 7 }),
    });
    expect(patch.status).toBe(200);
    const list = await h.fetch("/api/api-keys");
    const rows = ((await list.json()) as { data: { id: string; monthlyQuota: number | null }[] }).data;
    expect(rows.find((r) => r.id === keyId)?.monthlyQuota).toBe(7);
  });

  test("ledger export rides the SDK with the same row shape as REST", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    const { data } = await client.usage.export();
    expect(/^\d{4}-\d{2}-01$/.test(data.from)).toBe(true);
    expect(Array.isArray(data.rows)).toBe(true);
    const session = data.rows.find((r) => r.apiKeyId === "");
    expect(session?.keyName).toBe("Sessions & admin");

    const rest = await h.fetch(`/api/admin/usage/export?from=${data.from}&to=${data.to}`);
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as { data: typeof data };
    expect(restBody.data.rows.length).toBe(data.rows.length);
  });

  test("anonymous callers get 401", async () => {
    const anon = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/admin/usage/overview`),
    );
    expect(anon.status).toBe(401);
    const anonExport = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/admin/usage/export`),
    );
    expect(anonExport.status).toBe(401);
  });
});

describe("usage — GraphQL surface", () => {
  let h: TestHarness;
  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("usageSetLimits → usageOverview reflects the saved limits", async () => {
    const saved = await gql(
      `mutation($l: JSON!){ usageSetLimits(limits: $l) }`,
      { l: LIMITS },
    );
    expect(saved.errors).toBeUndefined();
    expect(saved.data?.usageSetLimits).toBe(true);

    const over = await gql(`query($d: Int){ usageOverview(days: $d) }`, { d: 14 });
    expect(over.errors).toBeUndefined();
    const data = over.data?.usageOverview;
    expect(data.days).toBe(14);
    expect(data.settingsLimits).toEqual(LIMITS);
    expect(data.byKey[0]?.id).toBe("");
  });

  test("validation errors surface with a VALIDATION code", async () => {
    const bad = await gql(`mutation($l: JSON!){ usageSetLimits(limits: $l) }`, {
      l: { mode: "extreme" },
    });
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("usageExport returns the same ledger rows as REST", async () => {
    const res = await gql(`query { usageExport }`);
    expect(res.errors).toBeUndefined();
    const data = res.data?.usageExport;
    expect(/^\d{4}-\d{2}-01$/.test(data.from)).toBe(true);
    expect(Array.isArray(data.rows)).toBe(true);
    expect(data.rows.find((r: { apiKeyId: string }) => r.apiKeyId === "")?.keyName).toBe(
      "Sessions & admin",
    );

    const inverted = await gql(
      `query($f: String, $t: String){ usageExport(from: $f, to: $t) }`,
      { f: "2026-07-10", t: "2026-07-01" },
    );
    expect(inverted.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("usage — MCP surface", () => {
  let h: TestHarness;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return res;
  };

  test("usage.set_limits + usage.overview ride the same REST semantics", async () => {
    const saved = await callTool("usage.set_limits", { ...LIMITS });
    expect(saved.status).toBe(200);

    const res = await callTool("usage.overview", { days: 7 });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Result may arrive as SSE or plain JSON depending on negotiation — pin
    // on the payload content rather than the envelope.
    expect(text).toContain('"month"');
    expect(text).toContain('"Sessions & admin"');
    expect(text).toContain("4242");
  });

  test("usage.export returns the ledger rows", async () => {
    const res = await callTool("usage.export", {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"rows"');
    expect(text).toContain('"Sessions & admin"');
  });
});
