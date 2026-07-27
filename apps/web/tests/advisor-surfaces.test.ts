/**
 * Multi-surface parity for the advisor (#20). Pins REST + SDK + GraphQL + MCP
 * to the same `/api/admin/advisor*` semantics — all four go through the ONE
 * `runAdvisorChecks` / `loadRuntimeInsights` / `applyAdvisorFix` service trio,
 * so a divergence here means a surface grew its own logic. In particular
 * `apply`'s "re-derive the statement, never trust the caller" rule must hold on
 * every surface, not just REST. CLI rides the same REST endpoints via
 * `client.request` (no separate server logic to pin).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Seed a collection plus enough list traffic to trip `hot-filter-index`. */
const seedTraffic = async (h: TestHarness, slug: string): Promise<string> => {
  const create = await h.fetch("/api/collections", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      slug,
      ownerScoped: false,
      fields: [
        { name: "title", type: "text" },
        { name: "status", type: "text" },
      ],
    }),
  });
  if (create.status !== 201) throw new Error(await create.text());
  const table = ((await create.json()) as { data: { physicalTable: string } }).data
    .physicalTable;

  const attrs = JSON.stringify({
    collection: slug,
    filters: ["status"],
    sorts: ["created_at"],
  });
  for (let i = 0; i < 25; i++) {
    const started = Date.now() - 60_000;
    const res = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
      body: JSON.stringify({
        sql: `INSERT INTO spans (id, tenant_id, trace_id, span_id, parent_span_id, name, kind, method, path, status, user_id, duration_ms, attributes, started_at, created_at)
          SELECT '${crypto.randomUUID()}', tenant_id, '${crypto.randomUUID().replace(/-/g, "")}', '${crypto.randomUUID().slice(0, 16)}', NULL,
                 'GET /api/items/${slug}', 'server', 'GET', '/api/items/${slug}', 200, NULL, ${700 + i},
                 '${attrs}', ${started}, ${started}
            FROM collections WHERE slug = '${slug}' LIMIT 1`,
      }),
    });
    if (res.status !== 200) throw new Error(await res.text());
  }
  return table;
};

describe("advisor — REST + SDK surface", () => {
  let h: TestHarness;
  const slug = `sdkadv_${Date.now()}`;
  let table = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    table = await seedTraffic(h, slug);
  });
  afterAll(() => h.cleanup());

  test("run + insights + apply round-trip through the SDK", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    const run = await client.advisor.run({ days: 7 });
    expect(run.runtime.windowDays).toBe(7);
    expect(run.runtime.spanCount).toBeGreaterThan(0);
    expect(typeof run.score).toBe("number");

    const insights = await client.advisor.insights({ days: 7, limit: 10 });
    expect(insights.window.days).toBe(7);
    expect(insights.endpoints.length).toBeLessThanOrEqual(10);
    const coll = insights.collections.find((c) => c.collection === slug);
    expect(coll?.listRequests).toBe(25);
    expect(coll?.filters[0]?.column).toBe("status");

    const finding = run.data.find(
      (c) => c.rule === "hot-filter-index" && c.resource.includes("status"),
    );
    expect(finding).toBeDefined();
    expect(finding!.action?.table).toBe(table);

    const applied = await client.advisor.apply(finding!.id);
    expect(applied.ok).toBe(true);
    expect(applied.applied.columns).toEqual(["status"]);

    // Same identity, same service: REST agrees the finding is gone.
    const rest = await h.fetch("/api/admin/advisor");
    const body = (await rest.json()) as { data: { id: string }[] };
    expect(body.data.find((c) => c.id === finding!.id)).toBeUndefined();
  });

  test("anonymous callers get 401 on every advisor route", async () => {
    for (const path of [
      "/api/admin/advisor",
      "/api/admin/advisor/insights",
    ]) {
      const res = await h.app.fetch(new Request(`${h.env.APP_URL}${path}`));
      expect(res.status).toBe(401);
    }
    const apply = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/admin/advisor/apply`, json({ id: "x" })),
    );
    expect(apply.status).toBe(401);
  });
});

describe("advisor — GraphQL surface", () => {
  let h: TestHarness;
  const slug = `gqladv_${Date.now()}`;
  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await seedTraffic(h, slug);
  });
  afterAll(() => h.cleanup());

  test("advisor + advisorInsights return the same payloads as REST", async () => {
    const res = await gql(`query($d: Int){ advisor(days: $d) }`);
    expect(res.errors).toBeUndefined();
    const run = res.data?.advisor;
    expect(Array.isArray(run.data)).toBe(true);
    expect(run.runtime.spanCount).toBeGreaterThan(0);

    const ins = await gql(`query { advisorInsights(days: 7, limit: 5) }`);
    expect(ins.errors).toBeUndefined();
    const insights = ins.data?.advisorInsights;
    expect(insights.window.days).toBe(7);
    expect(insights.endpoints.length).toBeLessThanOrEqual(5);
    expect(
      insights.collections.find((c: { collection: string }) => c.collection === slug)
        ?.listRequests,
    ).toBe(25);
  });

  test("advisorApply carries out the fix and rejects unknown ids", async () => {
    const run = await gql(`query { advisor }`);
    const finding = (run.data?.advisor.data as { id: string; rule: string }[]).find(
      (c) => c.rule === "hot-filter-index",
    );
    expect(finding).toBeDefined();

    const applied = await gql(`mutation($id: String!){ advisorApply(id: $id) }`, {
      id: finding!.id,
    });
    expect(applied.errors).toBeUndefined();
    expect(applied.data?.advisorApply.applied.columns).toEqual(["status"]);

    const missing = await gql(`mutation($id: String!){ advisorApply(id: $id) }`, {
      id: "perf-hot-filter-index-does-not-exist",
    });
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("advisor — MCP surface", () => {
  let h: TestHarness;
  const slug = `mcpadv_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await seedTraffic(h, slug);
  });
  afterAll(() => h.cleanup());

  const callTool = (name: string, args: Record<string, unknown> = {}) =>
    h.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

  test("advisor.run + advisor.insights ride the same REST semantics", async () => {
    const run = await callTool("advisor.run", { days: 7 });
    expect(run.status).toBe(200);
    // Result may arrive as SSE or plain JSON depending on negotiation — pin on
    // the payload content rather than the envelope.
    const runText = await run.text();
    expect(runText).toContain('"score"');
    expect(runText).toContain("hot-filter-index");

    const ins = await callTool("advisor.insights", { days: 7, limit: 5 });
    expect(ins.status).toBe(200);
    const insText = await ins.text();
    expect(insText).toContain('"endpoints"');
    expect(insText).toContain(slug);
  });

  test("advisor.apply takes only an id and applies the server's own statement", async () => {
    const run = await h.fetch("/api/admin/advisor");
    const body = (await run.json()) as { data: { id: string; rule: string }[] };
    const finding = body.data.find((c) => c.rule === "hot-filter-index");
    expect(finding).toBeDefined();

    const applied = await callTool("advisor.apply", { id: finding!.id });
    expect(applied.status).toBe(200);
    const text = await applied.text();
    expect(text).toContain("create-index");
    expect(text).toContain("CREATE INDEX IF NOT EXISTS");

    const after = await h.fetch("/api/admin/advisor");
    const afterBody = (await after.json()) as { data: { id: string }[] };
    expect(afterBody.data.find((c) => c.id === finding!.id)).toBeUndefined();
  });
});
