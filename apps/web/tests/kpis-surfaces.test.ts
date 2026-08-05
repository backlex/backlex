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

describe("kpis: SDK + CLI reach the feature", () => {
  const ROOT = join(import.meta.dir, "../../..");

  test("the SDK exposes a kpis client with run()", () => {
    const src = readFileSync(join(ROOT, "packages/client/src/index.ts"), "utf8");
    expect(src).toContain("KpisClient");
    expect(src).toMatch(/kpis: KpisClient;/);
    // The zero-baseline rule has to travel with the type, or a consumer prints
    // "+0%" for a period that had nothing to compare against.
    expect(src).toMatch(/Null when the previous period was[\s\S]{0,300}?deltaPct/);
  });

  test("the CLI registers a kpis command", () => {
    const bin = readFileSync(join(ROOT, "packages/cli/bin/backlex.ts"), "utf8");
    expect(bin).toContain('case "kpis":');
    expect(bin).toContain("runKpis");
    expect(bin).toMatch(/backlex kpis </);
  });
});
