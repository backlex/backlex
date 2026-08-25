/**
 * KPI multi-surface parity — the house rule that a feature reaches REST, the
 * SDK, GraphQL, MCP and the CLI, plus the Ask AI planner wiring that is the
 * whole reason the definition layer exists.
 *
 * The planner assertions are the load-bearing ones. A whitelist entry alone is
 * inert: the model cannot choose `kpis.run` when nothing tells it which slugs
 * exist, so it falls back to composing a `collections.aggregate` — which is
 * exactly the improvised formula this feature replaces. What is pinned here is
 * that the KPI digest reaches the prompt, and that a slug the model invents is
 * caught by the dry-run rather than surfacing as an error after Run.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { dryRunPlan } from "../src/server/routes/ai-ask";
import { allTools } from "../src/server/mcp/tools";

const JSON_HEADERS = { "content-type": "application/json" };

describe("kpis: MCP tool surface", () => {
  test("the roster exposes list/get/run", () => {
    const names = allTools.map((t) => t.name);
    expect(names).toContain("kpis.list");
    expect(names).toContain("kpis.get");
    expect(names).toContain("kpis.run");
  });

  test("kpis.list tells the agent to prefer a definition over an ad-hoc aggregate", () => {
    // The nudge IS the feature. Without it an agent holding both tools will
    // reach for the aggregate it already knows how to compose.
    const tool = allTools.find((t) => t.name === "kpis.list")!;
    expect(tool.description).toContain("collections.aggregate");
  });

  test("kpis.run warns against inventing a percentage from a zero baseline", () => {
    const tool = allTools.find((t) => t.name === "kpis.run")!;
    expect(tool.description).toMatch(/deltaPct/);
    expect(tool.description).toMatch(/null/);
  });
});

describe("kpis: Ask AI planner wiring", () => {
  const SRC = join(import.meta.dir, "../src/server/routes/ai-ask.ts");
  const CLIENT = join(import.meta.dir, "../src/client/admin/pages/ask-ai/shared.tsx");

  test("kpis.run is on the planner whitelist", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/PLAN_TOOL_WHITELIST[\s\S]*?"kpis\.run"/);
  });

  test("the client's auto-run pattern matches the server whitelist", () => {
    // These two lists are written in different files and different languages;
    // when they drift, a plan the server considers read-only stops firing and
    // the feature silently reverts to a manual click.
    const client = readFileSync(CLIENT, "utf8");
    expect(client).toMatch(/AUTO_RUN_PATTERN[\s\S]*?kpis\\\.run/);
  });

  test("kpis.run is not classified as a write by the client patterns", async () => {
    const { WRITE_PATTERN, DESTRUCTIVE_PATTERN, AUTO_RUN_PATTERN } = await import(
      "../src/client/admin/pages/ask-ai/shared"
    );
    expect(AUTO_RUN_PATTERN.test("kpis.run")).toBe(true);
    expect(WRITE_PATTERN.test("kpis.run")).toBe(false);
    expect(DESTRUCTIVE_PATTERN.test("kpis.run")).toBe(false);
  });
});

describe("kpis: planner dry-run self-correction", () => {
  let h: TestHarness;
  const slug = `kpidry_${Date.now()}`;
  const fetchInternal = (path: string, init?: RequestInit) => h.fetch(path, init);

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [{ name: "total", type: "integer" }],
      }),
    });
    await h.fetch("/api/admin/kpis", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "real-kpi",
        name: "Real KPI",
        collection: slug,
        agg: "sum",
        field: "total",
        dateField: "created_at",
      }),
    });
  });
  afterAll(() => h.cleanup());

  test("a defined slug dry-runs clean", async () => {
    const err = await dryRunPlan(fetchInternal, "kpis.run", { ref: "real-kpi" });
    expect(err).toBeNull();
  });

  test("an invented slug is caught for correction, not left for the operator", async () => {
    const err = await dryRunPlan(fetchInternal, "kpis.run", { ref: "hallucinated-kpi" });
    expect(err).toContain("NOT_FOUND");
  });

  test("a missing ref is caught without a round-trip", async () => {
    const err = await dryRunPlan(fetchInternal, "kpis.run", {});
    expect(err).toContain("VALIDATION");
  });
});

describe("kpis: MCP tools resolve through the same service as REST", () => {
  let h: TestHarness;
  const slug = `kpimcp_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: [{ name: "total", type: "integer" }] }),
    });
    for (const total of [10, 20, 30]) {
      await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ total }),
      });
    }
    await h.fetch("/api/admin/kpis", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "mcp-total",
        name: "MCP total",
        collection: slug,
        agg: "sum",
        field: "total",
      }),
    });
  });
  afterAll(() => h.cleanup());

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const tool = allTools.find((t) => t.name === name)!;
    return tool.handler(args, {
      fetchInternal: (path: string, init?: RequestInit) => h.fetch(path, init),
    } as Parameters<typeof tool.handler>[1]);
  };

  test("kpis.run through MCP returns the same figure REST does", async () => {
    const rest = await (
      await h.fetch("/api/admin/kpis/mcp-total/run")
    ).json();
    const mcp = (await callTool("kpis.run", { ref: "mcp-total" })) as {
      structuredContent: { data: { point: { value: number } } };
    };
    // The point of the definition layer: two surfaces, one number.
    expect(mcp.structuredContent.data.point.value).toBe(60);
    expect(mcp.structuredContent.data.point.value).toBe(
      (rest as { data: { point: { value: number } } }).data.point.value,
    );
  });

  test("kpis.list through MCP sees the definition", async () => {
    const res = (await callTool("kpis.list", {})) as {
      structuredContent: { data: Array<{ slug: string }> };
    };
    expect(res.structuredContent.data.map((k) => k.slug)).toContain("mcp-total");
  });

  const gql = async (query: string, variables?: Record<string, unknown>) =>
    (await (
      await h.fetch("/api/graphql", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ query, variables }),
      })
    ).json()) as { data?: Record<string, any>; errors?: unknown[] };

  test("GraphQL runKpi agrees with REST and MCP on the same figure", async () => {
    const res = await gql(
      `query { runKpi(ref: "mcp-total") { slug point { value previousValue deltaPct } window { from to } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.runKpi.slug).toBe("mcp-total");
    expect(res.data?.runKpi.point.value).toBe(60);
    // No dateField on this KPI, so there is no period — every surface must say
    // so the same way rather than one of them inventing a comparison.
    expect(res.data?.runKpi.window).toBeNull();
    expect(res.data?.runKpi.point.deltaPct).toBeNull();
  });

  test("GraphQL kpis lists the definition", async () => {
    const res = await gql(`query { kpis { slug name collection agg field } }`);
    expect(res.errors).toBeUndefined();
    const row = (res.data?.kpis as Array<{ slug: string; agg: string }>).find(
      (k) => k.slug === "mcp-total",
    );
    expect(row?.agg).toBe("sum");
  });

  test("GraphQL createKpi rejects a definition with no slug", async () => {
    const res = await gql(
      `mutation { createKpi(data: { name: "No slug", collection: "${slug}", agg: "count" }) { id } }`,
    );
    expect(res.errors).toBeDefined();
  });
});

/**
 * A `kpi` panel stores only a slug. The assertions that matter are that it
 * resolves to the SAME figure the run endpoint gives (otherwise the tile is a
 * second opinion, which is the thing being removed), and that a panel pointing
 * at a deleted definition fails loudly instead of rendering a plausible zero.
 */
describe("kpis: dashboard panels read the definition", () => {
  let h: TestHarness;
  const slug = `kpipanel_${Date.now()}`;
  let dashboardId = "";

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", {
      slug,
      fields: [{ name: "total", type: "integer" }],
    });
    for (const total of [5, 15]) await post(`/api/items/${slug}`, { total });
    await post("/api/admin/kpis", {
      slug: "panel-total",
      name: "Panel total",
      collection: slug,
      agg: "sum",
      field: "total",
    });
    const dash = await (await post("/api/admin/dashboards", { name: "KPI board" })).json();
    dashboardId = (dash as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("preview of an unsaved kpi panel returns the definition's value", async () => {
    const res = await post("/api/admin/panels/preview", {
      kind: "kpi",
      config: { kpi: "panel-total" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ value: number }> };
    expect(body.data[0]!.value).toBe(20);
  });

  test("a saved kpi panel renders the same number the run endpoint gives", async () => {
    const created = await post("/api/admin/panels", {
      name: "Total tile",
      kind: "kpi",
      viz: "counter",
      config: { kpi: "panel-total" },
      dashboardId,
    });
    expect(created.status).toBe(201);

    const run = await (
      await h.fetch(`/api/admin/dashboards/${dashboardId}/run`, { method: "POST" })
    ).json();
    const panel = (run as { data: Array<{ name: string; data: Array<{ value: number }> }> }).data.find(
      (p) => p.name === "Total tile",
    );
    expect(panel?.data[0]?.value).toBe(20);

    const direct = (await (await h.fetch("/api/admin/kpis/panel-total/run")).json()) as {
      data: { point: { value: number } };
    };
    expect(panel?.data[0]?.value).toBe(direct.data.point.value);
  });

  test("the saved-panel run endpoint resolves a kpi panel too", async () => {
    // There are THREE paths that execute a panel — preview, the dashboard
    // runner, and this per-panel endpoint the Insights grid calls. Adding the
    // kind to only two of them left every saved tile stuck on "No data yet"
    // with no error to explain it, which no dashboard-level test caught.
    const created = (await (
      await post("/api/admin/panels", {
        name: "Solo tile",
        kind: "kpi",
        viz: "counter",
        config: { kpi: "panel-total" },
      })
    ).json()) as { data: { id: string } };
    const res = await h.fetch(`/api/admin/panels/${created.data.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ value: number }> };
    expect(body.data[0]!.value).toBe(20);
  });

  test("a panel pointing at a missing KPI reports the error rather than a zero", async () => {
    await post("/api/admin/panels", {
      name: "Broken tile",
      kind: "kpi",
      viz: "counter",
      config: { kpi: "no-such-kpi" },
      dashboardId,
    });
    const run = await (
      await h.fetch(`/api/admin/dashboards/${dashboardId}/run`, { method: "POST" })
    ).json();
    const panel = (run as {
      data: Array<{ name: string; data: unknown[]; error?: string }>;
    }).data.find((p) => p.name === "Broken tile");
    expect(panel?.data).toEqual([]);
    expect(panel?.error).toContain("not found");
  });

  test("a kpi panel with no slug is refused rather than saved half-formed", async () => {
    const res = await post("/api/admin/panels/preview", { kind: "kpi", config: {} });
    expect(res.status).toBe(422);
  });
});

describe("kpis: SDK + CLI reach the feature", () => {
  const ROOT = join(import.meta.dir, "../../..");

  test("the SDK exposes a kpis client with run()", () => {
    // `index.ts` declares the client's place on `BacklexClient`; the shapes and
    // the factory live in the domain module. Reading both is what keeps this
    // from passing on the field declaration alone.
    const index = readFileSync(join(ROOT, "packages/client/src/index.ts"), "utf8");
    const mod = readFileSync(join(ROOT, "packages/client/src/clients/kpis.ts"), "utf8");
    expect(index).toMatch(/kpis: KpisClient;/);
    expect(mod).toContain("KpisClient");
    // The zero-baseline rule has to travel with the type, or a consumer prints
    // "+0%" for a period that had nothing to compare against.
    expect(mod).toMatch(/Null when the previous period was[\s\S]{0,300}?deltaPct/);
  });

  test("the CLI registers a kpis command", () => {
    const bin = readFileSync(join(ROOT, "packages/cli/bin/backlex.ts"), "utf8");
    expect(bin).toContain('case "kpis":');
    expect(bin).toContain("runKpis");
    // The help text lives in `src/help.ts`, not the bin — it is read without
    // running the CLI by the release-drift guard, and importing the bin would
    // print it and dispatch a command.
    const help = readFileSync(join(ROOT, "packages/cli/src/help.ts"), "utf8");
    expect(help).toMatch(/backlex kpis </);
  });
});
