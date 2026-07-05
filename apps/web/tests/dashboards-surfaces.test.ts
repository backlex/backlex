import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for Embedded BI dashboards. Pins REST + GraphQL + SDK to
 * the same `/api/admin/dashboards` semantics, plus the public embed round-trip
 * (`/api/public/dashboards/:token`) which has no session. MCP wraps the same
 * REST endpoints (see mcp.test.ts for the dispatch path).
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Create a static panel bound to a dashboard via REST (admin session). */
const makePanel = async (h: TestHarness, dashboardId: string, name: string) => {
  const res = await h.fetch(
    "/api/admin/panels",
    json({ name, kind: "static", viz: "counter", dashboardId }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { data: { id: string } };
};

describe("dashboards — GraphQL surface", () => {
  let h: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("createDashboard → dashboard → dashboards → update → run → delete round-trips", async () => {
    const created = await gql(
      `mutation($d:DashboardInput!){ createDashboard(data:$d){ id name embedEnabled } }`,
      { d: { name: "gql-dash", description: "hi" } },
    );
    expect(created.errors).toBeUndefined();
    const id = created.data?.createDashboard.id as string;
    expect(id).toBeTruthy();
    expect(created.data?.createDashboard.embedEnabled).toBe(false);

    const one = await gql(`query($id:ID!){ dashboard(id:$id){ id name } }`, { id });
    expect(one.data?.dashboard.name).toBe("gql-dash");

    const list = await gql(`{ dashboards { id name } }`);
    expect(list.data?.dashboards.some((d: any) => d.id === id)).toBe(true);

    const updated = await gql(
      `mutation($id:ID!,$d:DashboardInput!){ updateDashboard(id:$id, data:$d){ id name } }`,
      { id, d: { name: "gql-dash-2" } },
    );
    expect(updated.data?.updateDashboard.name).toBe("gql-dash-2");

    await makePanel(h, id, "p1");
    const run = await gql(
      `mutation($id:ID!){ runDashboard(id:$id){ panelId name viz kind note } }`,
      { id },
    );
    expect(run.errors).toBeUndefined();
    expect(run.data?.runDashboard.length).toBe(1);
    expect(run.data?.runDashboard[0].kind).toBe("static");

    const del = await gql(`mutation($id:ID!){ deleteDashboard(id:$id) }`, { id });
    expect(del.data?.deleteDashboard).toBe(true);

    const gone = await gql(`query($id:ID!){ dashboard(id:$id){ id } }`, { id });
    expect(gone.data?.dashboard).toBeNull();
  });

  test("createDashboard rejects an empty name", async () => {
    const res = await gql(`mutation($d:DashboardInput!){ createDashboard(data:$d){ id } }`, {
      d: { name: "" },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("runDashboard on an unknown id is NOT_FOUND", async () => {
    const res = await gql(`mutation{ runDashboard(id:"nope"){ panelId } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("dashboards — SDK surface + public embed", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("create → get → list → update → run → share → embed → revoke → delete", async () => {
    const created = await client.dashboards.create({ name: "sdk-dash" });
    const id = created.data.id;
    expect(id).toBeTruthy();
    expect(created.data.embedEnabled).toBe(false);

    expect((await client.dashboards.get(id)).data.name).toBe("sdk-dash");
    expect((await client.dashboards.list()).data.some((d) => d.id === id)).toBe(true);

    const upd = await client.dashboards.update(id, { name: "sdk-dash-2" });
    expect(upd.ok).toBe(true);
    expect((await client.dashboards.get(id)).data.name).toBe("sdk-dash-2");

    await makePanel(h, id, "sp1");
    const run = await client.dashboards.run(id);
    expect(run.data.length).toBe(1);
    expect(run.data[0]?.kind).toBe("static");

    // Share → embed is live; the public route resolves the token with NO auth.
    const share = await client.dashboards.share(id);
    expect(share.token.startsWith("dsh_")).toBe(true);
    expect(share.url).toBe(`/embed/d/${share.token}`);
    expect((await client.dashboards.get(id)).data.embedEnabled).toBe(true);

    const embedRes = await h.fetch(
      `/api/public/dashboards/${encodeURIComponent(share.token)}`,
    );
    expect(embedRes.status).toBe(200);
    const embed = (await embedRes.json()) as { data: { name: string; panels: any[] } };
    expect(embed.data.name).toBe("sdk-dash-2");
    expect(embed.data.panels.length).toBe(1);

    // Revoke → the same token 404s.
    const rev = await client.dashboards.revoke(id);
    expect(rev.ok).toBe(true);
    const after = await h.fetch(
      `/api/public/dashboards/${encodeURIComponent(share.token)}`,
    );
    expect(after.status).toBe(404);

    const del = await client.dashboards.delete(id);
    expect(del.ok).toBe(true);
  });

  test("an unknown embed token is 404", async () => {
    const res = await h.fetch("/api/public/dashboards/dsh_deadbeef");
    expect(res.status).toBe(404);
  });
});

describe("panels — PATCH keeps unspecified fields", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  // Regression: PanelInput's create-time defaults (`viz`, `kind`) used to leak
  // through `.partial()` on PATCH, so a `{dashboardId}`-only move silently
  // reset every panel back to viz "sparkline" / kind "sql".
  test("a partial PATCH does not reset viz/kind to their create defaults", async () => {
    const created = await h.fetch(
      "/api/admin/panels",
      json({ name: "keep-viz", kind: "static", viz: "donut" }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const patch = await h.fetch(`/api/admin/panels/${id}`, {
      ...json({ description: "only the description" }),
      method: "PATCH",
    });
    expect(patch.status).toBe(200);

    const list = (await (await h.fetch("/api/admin/panels")).json()) as {
      data: { id: string; viz: string; kind: string; description: string | null }[];
    };
    const row = list.data.find((p) => p.id === id);
    expect(row?.description).toBe("only the description");
    expect(row?.viz).toBe("donut");
    expect(row?.kind).toBe("static");
  });

  test("every documented viz value is accepted on create", async () => {
    const vizzes = [
      "sparkline", "line", "area", "bars", "stacked-bars",
      "donut", "pie", "radar", "radial", "counter", "table",
    ];
    for (const viz of vizzes) {
      const res = await h.fetch(
        "/api/admin/panels",
        json({ name: `viz-${viz}`, kind: "static", viz }),
      );
      expect(res.status).toBe(201);
    }
  });
});
