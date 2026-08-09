/**
 * Multi-surface parity for row-level security.
 *
 * This is a surface that runs DDL, so the parity that matters is not "the
 * fields exist" but "every path funnels through the same service" — the owner
 * check, the `standard_conforming_strings` check and the omission reporting
 * live in `services/rls.ts` and nothing may restate them. The SQLite harness
 * can prove the REFUSAL half of that on every surface, which is exactly the
 * arm a second implementation would get wrong.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rlsTools } from "../src/server/mcp/tools/rls";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("row-level security — surfaces", () => {
  let h: TestHarness;

  const gql = async (query: string) =>
    (await (await h.fetch("/api/graphql", json({ query }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("status answers on SQLite instead of erroring — and says it is unsupported", async () => {
    // `supported: false` is a fact the admin card renders. An error here would
    // make the whole permissions page look broken on the default dialect.
    const res = await h.fetch("/api/admin/rls/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { supported: boolean; installed: unknown[] };
    expect(body.supported).toBe(false);
    expect(body.installed).toEqual([]);
  });

  test("plan and apply REFUSE on SQLite rather than pretending", async () => {
    for (const [path, init] of [
      ["/api/admin/rls/plan", undefined],
      ["/api/admin/rls/apply", { method: "POST" }],
    ] as const) {
      const res = await h.fetch(path, init as RequestInit | undefined);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).toContain("Postgres");
    }
  });

  test("GraphQL gives the same answer, from the same service", async () => {
    const ok = await gql(`{ rlsStatus { supported appliesTo notOwned } }`);
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.rlsStatus.supported).toBe(false);

    // …and refuses the same way. A resolver that had its own dialect check
    // would be free to get this wrong.
    const refused = await gql(`{ rlsPlan { policies { name } } }`);
    expect(refused.errors?.[0]?.extensions?.code).toBe("UNAVAILABLE");
    const mutated = await gql(`mutation { applyRls { applied } }`);
    expect(mutated.errors?.[0]?.extensions?.code).toBe("UNAVAILABLE");
  });

  test("every REST verb has an MCP tool, and the descriptions carry the warning", () => {
    expect(rlsTools.map((t) => t.name).sort()).toEqual([
      "rls.apply",
      "rls.disable",
      "rls.plan",
      "rls.status",
    ]);
    // An agent that applies without reading the omissions has told the operator
    // their database enforces something it does not — so the tool says so.
    expect(rlsTools.find((t) => t.name === "rls.plan")!.description).toContain("omissions");
    expect(rlsTools.find((t) => t.name === "rls.apply")!.description).toContain("own");
  });

  test("the SDK points at routes that exist", async () => {
    const { makeRls } = await import("../../../packages/client/src/clients/rls");
    const calls: string[] = [];
    const core = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {} as never;
      },
    } as never;
    const rls = makeRls(core);
    await rls.status();
    await rls.plan();
    await rls.apply();
    await rls.disable();
    expect(calls).toEqual([
      "GET /api/admin/rls/status",
      "GET /api/admin/rls/plan",
      "POST /api/admin/rls/apply",
      "POST /api/admin/rls/disable",
    ]);
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, method === "POST" ? { method: "POST" } : undefined);
      // 404 would mean the SDK targets a route nobody mounted — which
      // typechecks perfectly and fails only in a customer's terminal.
      expect(res.status).not.toBe(404);
    }
  });

  test("all four are admin-only", async () => {
    const anon = (path: string, init?: RequestInit) =>
      h.app.request(
        path,
        { ...init, headers: { origin: "http://localhost:5173" } } as RequestInit,
        h.env,
      );
    for (const [path, init] of [
      ["/api/admin/rls/status", undefined],
      ["/api/admin/rls/plan", undefined],
      ["/api/admin/rls/apply", { method: "POST" }],
      ["/api/admin/rls/disable", { method: "POST" }],
    ] as const) {
      const res = await anon(path, init as RequestInit | undefined);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
