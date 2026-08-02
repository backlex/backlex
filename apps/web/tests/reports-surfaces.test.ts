/**
 * Multi-surface parity for report delivery.
 *
 * The gate is not that four surfaces exist — it is that they share ONE
 * implementation. `services/reports.ts` owns the recipient parsing, the
 * missing-renderer refusal and the storage prefix; a surface that restated any
 * of them would be the one that eventually disagrees. So each surface is driven
 * through the same three cases and asserted to answer the same way.
 *
 * The renderer is somebody else's browser, so it is stubbed. What is asserted
 * is where each surface lands, not what Chromium draws.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { dashboardsTools } from "../src/server/mcp/tools/dashboards";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

let h: TestHarness;
let ctx: any;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string; extensions?: { code?: string } }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcpReport = (args: Record<string, unknown>) => {
  const tool = dashboardsTools.find((x) => x.name === "dashboards.report")!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as any);
};

/**
 * Each surface reduced to the one call under test, with failures normalised to
 * `{ error }`. The surfaces disagree about HOW they report a refusal — REST
 * answers a status, the SDK throws, GraphQL collects into `errors` — and that
 * is not what this file is pinning. What must agree is WHETHER they refuse.
 */
type Deliver = (id: string, input?: Record<string, unknown>) => Promise<Record<string, any>>;

const normalise =
  (fn: Deliver): Deliver =>
  async (id, input) => {
    try {
      const out = await fn(id, input);
      return (out?.error ?? out?.errors) ? { error: JSON.stringify(out) } : out;
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

const SURFACES: [string, Deliver][] = (
  [
    [
      "rest",
      async (id, input) =>
        (await (await h.fetch(`/api/admin/dashboards/${id}/report`, json(input ?? {}))).json()) as any,
    ],
    ["sdk", (id, input) => sdk().dashboards.report(id, input ?? {}) as Promise<any>],
    [
      "graphql",
      async (id, input) => {
        const res = await gql(
          `mutation($id:ID!,$i:DashboardReportInput){ deliverDashboardReport(id:$id, input:$i){ key filename size panels failedPanels sentTo } }`,
          { id, i: input ?? {} },
        );
        if (res.errors) return { error: res.errors[0]!.message };
        return res.data!.deliverDashboardReport;
      },
    ],
    [
      "mcp",
      async (id, input) => {
        const out = await mcpReport({ id, ...(input ?? {}) });
        return out.structuredContent as Record<string, any>;
      },
    ],
  ] as [string, Deliver][]
).map(([name, fn]) => [name, normalise(fn)]);

describe("report delivery — surface parity", () => {
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const { buildContext } = await import("../src/server/context");
    ctx = (await buildContext(h.env)) as any;
    ctx.pdf = { name: "stub", render: async () => FAKE_PDF };
  });
  afterEach(() => h.cleanup());

  const makeDashboard = async (name: string) => {
    const res = await h.fetch("/api/admin/dashboards", json({ name }));
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  test("every surface stores the artefact under the same workspace prefix", async () => {
    for (const [name, deliver] of SURFACES) {
      const id = await makeDashboard(`dash-${name}`);
      const out = await deliver(id);
      expect(out.key as string).toStartWith("documents/");
      expect(out.filename as string).toEndWith(".pdf");
      expect(out.size).toBe(FAKE_PDF.byteLength);
      expect(out.sentTo).toEqual([]);
    }
  });

  test("every surface refuses the same bad recipient", async () => {
    for (const [name, deliver] of SURFACES) {
      const id = await makeDashboard(`bad-${name}`);
      const out = await deliver(id, { email: { to: "not-an-address" } });
      // What must not differ is that none of them produced a report, and that
      // each says which value it objected to.
      expect(out.key).toBeUndefined();
      expect(JSON.stringify(out)).toContain("not-an-address");
    }
  });

  test("every surface refuses identically when no renderer is configured", async () => {
    ctx.pdf = null;
    for (const [name, deliver] of SURFACES) {
      const id = await makeDashboard(`norender-${name}`);
      const out = await deliver(id);
      expect(out.key).toBeUndefined();
      expect(JSON.stringify(out).toLowerCase()).toContain("renderer");
    }
  });

  test("the MCP tool is registered under the dashboards group", () => {
    expect(dashboardsTools.map((t) => t.name)).toContain("dashboards.report");
  });
});
