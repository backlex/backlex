/**
 * Multi-surface parity + behaviour for the permission simulator.
 *
 * The simulator dry-runs the resolver for a subject (an existing user OR ad-hoc
 * role names) against a (collection, action) and returns the full allow/deny
 * trace. This pins the engine's behaviour (admin bypass, filtered grant via the
 * owner-scope condition, anonymous deny, sampleRow matching, field allow-list)
 * AND that REST / SDK / GraphQL / MCP all expose the SAME `permissions.simulate`
 * semantics — the parity gate that mirrors `flows`/`agents` surfaces.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const signUp = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
  });
const signIn = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

interface Sim {
  allowed: boolean;
  isAdmin: boolean;
  reason: string;
  roles: { id: string; name: string; admin: boolean }[];
  matchedRules: { roleName: string; condition: unknown | null; rowMatch?: boolean }[];
  resolvedVars: Record<string, unknown>;
  whereSql: { sql: string; params: unknown[] } | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

const slug = `sim_notes_${Date.now()}`;
let h: TestHarness;
let adminEmail: string;
let adminId: string;
let user2Email: string;
let user2Id: string;

const simRest = async (body: Record<string, unknown>): Promise<Sim> => {
  const res = await h.fetch("/api/permissions/simulate", json(body));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Sim }).data;
};

beforeAll(async () => {
  h = makeHarness();
  const adm = await seedAdmin(h);
  adminEmail = adm.email;
  adminId = ((await (await h.fetch("/api/me")).json()) as { data: { id: string } }).data.id;

  // An owner-scoped collection auto-seeds `authenticated` permissions whose
  // condition is `owner_id _eq $user.id` — a perfect filtered-grant fixture.
  const create = await h.fetch("/api/collections", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      slug,
      ownerScoped: true,
      fields: [{ name: "title", type: "text", required: true }],
    }),
  });
  expect(create.status).toBe(201);

  // A non-admin user in the same workspace (lands as `authenticated`).
  await signOut(h);
  user2Email = `user2-${Date.now()}@example.test`;
  expect((await signUp(h, user2Email)).status).toBe(200);
  user2Id = ((await (await h.fetch("/api/me")).json()) as { data: { id: string } }).data.id;

  // Back to admin — the simulator is admin-gated.
  await signOut(h);
  expect((await signIn(h, adminEmail)).status).toBe(200);
});

afterAll(() => h.cleanup());

describe("permissions.simulate — engine behaviour (REST)", () => {
  test("admin subject → allowed via admin bypass, no row filter", async () => {
    const sim = await simRest({ userId: adminId, collection: slug, action: "read" });
    expect(sim.allowed).toBe(true);
    expect(sim.isAdmin).toBe(true);
    expect(sim.whereSql).toBeNull();
    expect(sim.fields).toBeNull();
  });

  test("authenticated user → allowed, filtered by the owner_id condition", async () => {
    const sim = await simRest({ userId: user2Id, collection: slug, action: "read" });
    expect(sim.allowed).toBe(true);
    expect(sim.isAdmin).toBe(false);
    expect(sim.roles.some((r) => r.name === "authenticated")).toBe(true);
    expect(sim.matchedRules.length).toBeGreaterThan(0);
    // $user.id resolves to the real user; the compiled WHERE references owner_id.
    expect(sim.resolvedVars["$user.id"]).toBe(user2Id);
    expect(sim.whereSql?.sql.toLowerCase()).toContain("owner_id");
  });

  test("anonymous (no roles) → denied with a reason", async () => {
    const sim = await simRest({ roles: [], collection: slug, action: "read" });
    expect(sim.allowed).toBe(false);
    expect(sim.matchedRules.length).toBe(0);
    expect(sim.reason.length).toBeGreaterThan(0);
  });

  test("sampleRow matching: owner's row passes, a stranger's row is excluded", async () => {
    const mine = await simRest({
      userId: user2Id,
      collection: slug,
      action: "read",
      sampleRow: { owner_id: user2Id, title: "x" },
    });
    expect(mine.rowMatch).toBe(true);

    const theirs = await simRest({
      userId: user2Id,
      collection: slug,
      action: "read",
      sampleRow: { owner_id: "someone-else", title: "x" },
    });
    expect(theirs.rowMatch).toBe(false);
  });
});

describe("permissions.simulate — cross-surface parity", () => {
  // A real (non-admin) user so `$user.id` resolves and the owner_id filter
  // compiles to a real predicate (an ad-hoc subject with no userId would null
  // out `$user.id` and the owner_id _eq null clause collapses to 1=0).
  const input = { userId: "", collection: slug, action: "read" } as { userId: string; collection: string; action: string };

  let client: ReturnType<typeof createClient>;
  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await h.fetch("/mcp", json({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }));
    const body = (await res.json()) as {
      result?: { structuredContent?: { data?: Sim } };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result?.structuredContent?.data as Sim;
  };

  beforeAll(() => {
    input.userId = user2Id;
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });

  test("REST, SDK, GraphQL and MCP agree on the decision + trace shape", async () => {
    const rest = await simRest({ ...input });
    const sdk = (await client.permissions.simulate({ ...input, action: "read" })).data;
    const mcp = await callTool("permissions.simulate", { ...input });

    const g = await gql(
      `query($c:String!,$a:String!,$u:ID){ permissionSimulation(collection:$c, action:$a, userId:$u){ allowed isAdmin matchedRules { roleName } whereSql { sql } } }`,
      { c: slug, a: "read", u: user2Id },
    );
    expect(g.errors).toBeUndefined();
    const graph = g.data?.permissionSimulation;

    // Same allow decision everywhere.
    for (const s of [rest, sdk, mcp]) expect(s.allowed).toBe(true);
    expect(graph.allowed).toBe(true);

    // Same matched-rule count everywhere.
    const counts = [rest.matchedRules.length, sdk.matchedRules.length, mcp.matchedRules.length, graph.matchedRules.length];
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);

    // Compiled WHERE present + references owner_id on every surface.
    for (const sql of [rest.whereSql?.sql, sdk.whereSql?.sql, mcp.whereSql?.sql, graph.whereSql?.sql]) {
      expect(String(sql).toLowerCase()).toContain("owner_id");
    }
  });

  test("permissions.simulate is advertised by tools/list", async () => {
    const res = await h.fetch("/mcp", json({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("permissions.simulate");
  });
});
