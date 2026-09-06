/**
 * Phase 4 of the 2026-09 pre-prod audit — the permission is resolved at the
 * COLLECTION and has to be applied at the ROW.
 *
 * One defect shape, seven independent sites. Each resolved
 * `resolvePermission(collection, "read")` correctly, used the `fields`
 * allow-list where it had one, and then dropped `whereSql` on the floor. For a
 * role whose grant carries a condition — `{owner_key: {_eq: "$user.id"}}`, the
 * shape every self-service portal role in this repo uses — the collection gate
 * passes for every row in the table, so the row condition IS the containment
 * and losing it loses everything:
 *
 *   · `?expand=` inlined the full target row for FKs the caller cannot read,
 *     on the to-one JOIN, the to-many batch fetch and every hop of a chain;
 *   · both revision endpoints returned whole pre-change snapshots of rows
 *     whose `GET` answers 404, with fields the allow-list excludes;
 *   · `/api/comments` read and WROTE threads on other people's rows
 *     (reproduced in `comments-rest.test.ts`, which asserted the leak as
 *     correct behaviour before this);
 *   · the six `/api/vector/*` endpoints were `requireUser`-only, and
 *     `{"namespace":"customers"}` is byte-for-byte the namespace
 *     `embedAndUpsert` writes that collection into;
 *   · the keyset cursor base64s the boundary row's sort values, so
 *     `?sort=<private field>&cursor=` handed back the value the response body
 *     is built to withhold;
 *   · a public dashboard embed shared the ordinary way (`embedRoleId: null`)
 *     ran `items-aggregate` panels with NO clamp at all;
 *   · a workspace admin could rewrite and publish a `tenant_id IS NULL`
 *     dashboard or panel that every other workspace renders.
 *
 * Every block asserts BOTH directions — the refusal and the neighbouring case
 * that must still work — because a clamp that refuses everything passes a
 * one-directional test. Each guard was verified by breaking it; see
 * [[verify-a-guard-by-breaking-it]].
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const J = { "content-type": "application/json" };
const PASSWORD = "correct-horse-battery";

const post = (h: TestHarness, path: string, body: unknown) =>
  h.fetch(path, { method: "POST", headers: J, body: JSON.stringify(body) });

const signOut = (h: TestHarness) =>
  h.fetch("/api/auth/sign-out", { method: "POST" });

const signIn = (h: TestHarness, email: string) =>
  post(h, "/api/auth/sign-in/email", { email, password: PASSWORD });

// ---------------------------------------------------------------------------
// A workspace, an admin, and an app-plane end-user whose read on `customers`
// is conditioned on a column and trimmed to one field.
// ---------------------------------------------------------------------------

interface World {
  h: TestHarness;
  /** Bearer-authenticated fetch as the portal end-user. */
  portal: (path: string, init?: RequestInit) => Promise<Response>;
  appUserId: string;
  mineCustomer: string;
  otherCustomer: string;
  mineOrder: string;
  otherOrder: string;
  mineTag: string;
  otherTag: string;
}

const createItem = async (h: TestHarness, slug: string, body: unknown) => {
  const res = await post(h, `/api/items/${slug}`, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
};

const buildWorld = async (): Promise<World> => {
  const h = makeHarness();
  await seedAdmin(h);

  for (const c of [
    {
      slug: "customers",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "ssn", type: "text" },
        { name: "owner_key", type: "text" },
      ],
    },
    {
      slug: "tags",
      fields: [
        { name: "label", type: "text", required: true },
        { name: "owner_key", type: "text" },
      ],
    },
    {
      slug: "orders",
      fields: [
        { name: "ref", type: "text", required: true },
        { name: "customer", type: "relation", to: "customers" },
        { name: "tag_ids", type: "relation_many", to: "tags" },
      ],
    },
    {
      slug: "shipments",
      fields: [
        { name: "code", type: "text", required: true },
        { name: "order", type: "relation", to: "orders" },
      ],
    },
  ]) {
    expect((await post(h, "/api/collections", c)).status).toBe(201);
  }

  const roleRes = await post(h, "/api/roles", { name: "Portal" });
  expect(roleRes.status).toBe(201);
  const roleId = ((await roleRes.json()) as { data: { id: string } }).data.id;

  // `orders` and `shipments` unconditional; `customers` and `tags` conditioned
  // on ownership. `customers` is additionally trimmed to `name`, so `ssn` is
  // never a field this identity may read anywhere.
  for (const p of [
    { collection: "orders", action: "read" },
    { collection: "shipments", action: "read" },
    {
      collection: "customers",
      action: "read",
      condition: { owner_key: { _eq: "$user.id" } },
      fields: ["name", "owner_key"],
    },
    {
      collection: "tags",
      action: "read",
      condition: { owner_key: { _eq: "$user.id" } },
    },
  ]) {
    expect((await post(h, `/api/roles/${roleId}/permissions`, p)).status).toBe(201);
  }

  const signup = await post(h, "/api/t/default/auth/sign-up/email", {
    email: `portal-${Date.now()}@example.test`,
    password: "portal-pass-123",
    name: "Portal",
  });
  expect(signup.status).toBe(200);
  const token = ((await signup.json()) as { token?: string }).token!;
  const users = (await (await h.fetch("/api/app-users")).json()) as {
    data: { id: string; email: string }[];
  };
  const appUserId = users.data[users.data.length - 1]!.id;
  const bind = await h.fetch(`/api/app-users/${appUserId}/roles`, {
    method: "PUT",
    headers: J,
    body: JSON.stringify({ roleIds: [roleId] }),
  });
  expect(bind.status).toBe(200);

  const mineCustomer = await createItem(h, "customers", {
    name: "Mine",
    ssn: "111-11-1111",
    owner_key: appUserId,
  });
  const otherCustomer = await createItem(h, "customers", {
    name: "Theirs",
    ssn: "999-99-9999",
    owner_key: "somebody-else",
  });
  const mineTag = await createItem(h, "tags", { label: "mine", owner_key: appUserId });
  const otherTag = await createItem(h, "tags", { label: "theirs", owner_key: "nope" });
  const mineOrder = await createItem(h, "orders", {
    ref: "A",
    customer: mineCustomer,
    tag_ids: [mineTag, otherTag],
  });
  const otherOrder = await createItem(h, "orders", {
    ref: "B",
    customer: otherCustomer,
    tag_ids: [otherTag],
  });

  return {
    h,
    portal: (path, init = {}) =>
      Promise.resolve(
        h.app.request(path, {
          ...init,
          headers: { ...J, ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
        }),
      ),
    appUserId,
    mineCustomer,
    otherCustomer,
    mineOrder,
    otherOrder,
    mineTag,
    otherTag,
  };
};

// ---------------------------------------------------------------------------
// 1 — `?expand=` applies the target's row condition
// ---------------------------------------------------------------------------

describe("expand honours the target's row condition", () => {
  let w: World;
  beforeAll(async () => {
    w = await buildWorld();
  });
  afterAll(() => w.h.cleanup());

  test("the control: the target collection itself is already filtered", async () => {
    const res = await w.portal("/api/items/customers");
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id);
    expect(ids).toEqual([w.mineCustomer]);
    // …and the row that IS visible is trimmed to the allow-list.
    const one = await w.portal(`/api/items/customers/${w.mineCustomer}`);
    expect(one.status).toBe(200);
    const row = ((await one.json()) as { data: Record<string, unknown> }).data;
    expect(row.name).toBe("Mine");
    expect("ssn" in row).toBe(false);
  });

  test("to-one: a list expand inlines null for a customer the caller cannot read", async () => {
    const res = await w.portal("/api/items/orders?expand=customer&sort=ref");
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as {
      data: Array<{ ref: string; customer: Record<string, unknown> | null }>;
    }).data;
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    // Both orders are readable — the condition is on `customers`, not `orders`.
    expect([...byRef.keys()].sort()).toEqual(["A", "B"]);
    expect(byRef.get("A")!.customer?.name).toBe("Mine");
    expect(byRef.get("B")!.customer).toBeNull();
    // And the leak this replaces was the WHOLE row, `ssn` included.
    expect(JSON.stringify(rows)).not.toContain("999-99-9999");
    expect(JSON.stringify(rows)).not.toContain("Theirs");
  });

  test("to-one: the single-GET expand path clamps too", async () => {
    const mine = await w.portal(`/api/items/orders/${w.mineOrder}?expand=customer`);
    expect(mine.status).toBe(200);
    expect(
      ((await mine.json()) as { data: { customer: { name: string } } }).data.customer.name,
    ).toBe("Mine");

    const other = await w.portal(`/api/items/orders/${w.otherOrder}?expand=customer`);
    expect(other.status).toBe(200);
    expect(((await other.json()) as { data: { customer: unknown } }).data.customer).toBeNull();
  });

  test("chained: every hop is clamped, not just the first", async () => {
    // `shipments → orders → customers`. `orders` is readable unconditionally,
    // so the middle hop survives and the LAST one is where the condition bites.
    const ship = await createItem(w.h, "shipments", { code: "S1", order: w.otherOrder });
    const res = await w.portal(`/api/items/shipments/${ship}?expand=order.customer`);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as {
      data: { order: { ref: string; customer: unknown } };
    }).data;
    expect(data.order.ref).toBe("B");
    expect(data.order.customer).toBeNull();
  });

  test("to-many: the batch fetch drops tags the caller cannot read", async () => {
    const res = await w.portal(`/api/items/orders/${w.mineOrder}?expand=tag_ids`);
    expect(res.status).toBe(200);
    const tags = ((await res.json()) as { data: { tag_ids: { id: string }[] } }).data.tag_ids;
    expect(tags.map((t) => t.id)).toEqual([w.mineTag]);
  });

  test("an admin still sees every expanded row (the clamp is per-identity)", async () => {
    const res = await w.h.fetch(`/api/items/orders/${w.otherOrder}?expand=customer`);
    expect(res.status).toBe(200);
    const c = ((await res.json()) as { data: { customer: { name: string; ssn: string } } }).data
      .customer;
    expect(c.name).toBe("Theirs");
    expect(c.ssn).toBe("999-99-9999");
  });
});

// ---------------------------------------------------------------------------
// 2 — revision history
// ---------------------------------------------------------------------------

describe("revision history applies the row condition and the field allow-list", () => {
  let w: World;
  beforeAll(async () => {
    w = await buildWorld();
    // Give both customers a revision each (a revision is written on UPDATE).
    for (const id of [w.mineCustomer, w.otherCustomer]) {
      const res = await w.h.fetch(`/api/items/customers/${id}`, {
        method: "PATCH",
        headers: J,
        body: JSON.stringify({ name: "renamed" }),
      });
      expect(res.status).toBe(200);
    }
  });
  afterAll(() => w.h.cleanup());

  test("a row the caller cannot read has no history, on either endpoint", async () => {
    // Control: the row itself is a 404.
    expect((await w.portal(`/api/items/customers/${w.otherCustomer}`)).status).toBe(404);
    expect(
      (await w.portal(`/api/items/customers/${w.otherCustomer}/revisions`)).status,
    ).toBe(404);
    expect((await w.portal(`/api/revisions/customers/${w.otherCustomer}`)).status).toBe(404);
  });

  test("a row they CAN read has its history, with every snapshot projected", async () => {
    for (const path of [
      `/api/items/customers/${w.mineCustomer}/revisions`,
      `/api/revisions/customers/${w.mineCustomer}`,
    ]) {
      const res = await w.portal(path);
      expect(res.status, path).toBe(200);
      const rows = ((await res.json()) as {
        data: Array<{ snapshot: Record<string, unknown> }>;
      }).data;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        // The snapshot is a whole row as it stood — `ssn` was in it, and the
        // caller's allow-list is `["name","owner_key"]`.
        expect("ssn" in r.snapshot).toBe(false);
        expect(r.snapshot.name).toBe("Mine");
      }
      // Belt and braces: the value itself never appears in the body.
      expect(JSON.stringify(rows)).not.toContain("111-11-1111");
    }
  });

  test("an admin still reads the whole snapshot", async () => {
    const res = await w.h.fetch(`/api/revisions/customers/${w.otherCustomer}`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as {
      data: Array<{ snapshot: Record<string, unknown> }>;
    }).data;
    expect(rows[0]!.snapshot.ssn).toBe("999-99-9999");
  });
});

// ---------------------------------------------------------------------------
// 3 — the raw vector endpoints are gated on the collection their namespace names
// ---------------------------------------------------------------------------

describe("vector namespaces that name a collection take that collection's gate", () => {
  let w: World;
  beforeAll(async () => {
    w = await buildWorld();
  });
  afterAll(() => w.h.cleanup());

  /** The portal identity holds `read` on `customers` but not `update`. */
  const vec = (path: string, body: unknown) =>
    w.portal(`/api/vector/${path}`, { method: "POST", body: JSON.stringify(body) });

  test("a namespace naming a collection the caller may not write is refused", async () => {
    for (const [path, body] of [
      ["delete", { model: "bge-m3", ids: ["x"], namespace: "customers" }],
      [
        "embed-upsert",
        { model: "bge-m3", records: [{ id: "x", text: "hi", namespace: "customers" }] },
      ],
      [
        "upsert",
        {
          model: "bge-m3",
          records: [{ id: "x", values: [0.1], namespace: "customers" }],
        },
      ],
    ] as const) {
      const res = await vec(path, body);
      expect(res.status, path).toBe(403);
      expect(await res.text()).toContain("customers");
    }
  });

  test("a namespace naming a collection the caller may not READ is refused", async () => {
    // `orders` is readable; `payroll` is a collection with no grant at all.
    expect(
      (await post(w.h, "/api/collections", {
        slug: "payroll",
        fields: [{ name: "amount", type: "text" }],
      })).status,
    ).toBe(201);
    const res = await vec("search", {
      model: "bge-m3",
      text: "salary",
      namespace: "payroll",
    });
    expect(res.status).toBe(403);
  });

  test("a free-form namespace is still a workspace scratch space", async () => {
    // No collection is called `scratch`, so the gate has nothing to apply and
    // the call reaches the store — which this harness has none of, hence 500
    // rather than 403. The distinction is the whole point: 403 would mean the
    // gate had become a blanket refusal. `/query` rather than `/search`
    // because it takes pre-computed values and so gets past the (also absent)
    // embedding provider to the store itself.
    const res = await vec("query", {
      model: "bge-m3",
      values: [0.1, 0.2],
      namespace: "scratch",
    });
    // 500, not 403: the store's own "not configured" error, masked to a
    // generic message by the error middleware. What matters is which side of
    // the gate the request died on.
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 4 — the keyset cursor never carries an unreadable value
// ---------------------------------------------------------------------------

describe("keyset pagination refuses to sort by a value the caller cannot read", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    expect(
      (await post(h, "/api/collections", {
        slug: "leads",
        fields: [
          { name: "email", type: "text", required: true },
          { name: "secret_note", type: "text", private: true },
        ],
      })).status,
    ).toBe(201);
    for (const [email, note] of [
      ["a@x.test", "TOPSECRET-A"],
      ["b@x.test", "TOPSECRET-B"],
    ]) {
      await createItem(h, "leads", { email, secret_note: note });
    }
  });
  afterAll(() => h.cleanup());

  test("the control: the body already withholds the private field", async () => {
    const res = await h.fetch("/api/items/leads");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("TOPSECRET");
  });

  test("cursor mode refuses the sort — and the cursor is not minted", async () => {
    const res = await h.fetch("/api/items/leads?sort=secret_note&cursor=&limit=1");
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("Cannot paginate by");
    expect(body).not.toContain("TOPSECRET");
  });

  test("offset mode is untouched, and a readable sort still paginates", async () => {
    // No cursor is minted in offset mode, so there is nothing to read back.
    const offset = await h.fetch("/api/items/leads?sort=secret_note&limit=1");
    expect(offset.status).toBe(200);
    expect(await offset.text()).not.toContain("TOPSECRET");

    const keyset = await h.fetch("/api/items/leads?sort=email&cursor=&limit=1");
    expect(keyset.status).toBe(200);
    const page = (await keyset.json()) as { next_cursor?: string | null };
    expect(typeof page.next_cursor).toBe("string");
    expect(atob(page.next_cursor!)).toContain("@x.test");
  });
});

// ---------------------------------------------------------------------------
// 5 — the public dashboard embed
// ---------------------------------------------------------------------------

describe("a shared dashboard is not a grant", () => {
  let h: TestHarness;
  let token: string;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    expect(
      (await post(h, "/api/collections", {
        slug: "salaries",
        fields: [{ name: "person", type: "text", required: true }],
      })).status,
    ).toBe(201);
    await createItem(h, "salaries", { person: "alice" });
    await createItem(h, "salaries", { person: "bob" });

    const dash = await post(h, "/api/admin/dashboards", { name: "Board" });
    expect(dash.status).toBe(201);
    const dashboardId = ((await dash.json()) as { data: { id: string } }).data.id;
    const panel = await post(h, "/api/admin/panels", {
      name: "Headcount",
      kind: "items-aggregate",
      viz: "counter",
      dashboardId,
      config: { collection: "salaries", agg: "count", groupBy: "person" },
    });
    expect(panel.status).toBe(201);
    // Shared the ORDINARY way: no body, so `embedRoleId` stays null. That is
    // exactly the case the clamp used to skip.
    const share = await h.fetch(`/api/admin/dashboards/${dashboardId}/share`, {
      method: "POST",
      headers: J,
      body: "{}",
    });
    expect(share.status).toBe(200);
    token = ((await share.json()) as { token: string }).token;
  });
  afterAll(() => h.cleanup());

  test("with no public grant, the panel refuses instead of aggregating", async () => {
    const res = await h.app.request(`/api/public/dashboards/${token}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Not permitted for this embed");
    // `groupBy: "person"` would have returned one label per distinct value —
    // a full column read wearing a chart's clothes.
    expect(body).not.toContain("alice");
  });

  test("granting the public role read is what opens it, and it does", async () => {
    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    };
    const publicRole = roles.data.find((r) => r.name === "public")!;
    expect(
      (await post(h, `/api/roles/${publicRole.id}/permissions`, {
        collection: "salaries",
        action: "read",
      })).status,
    ).toBe(201);
    const res = await h.app.request(`/api/public/dashboards/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("alice");
  });
});

// ---------------------------------------------------------------------------
// 6 — deployment-wide dashboards and panels are not a workspace admin's to edit
// ---------------------------------------------------------------------------

describe("a `tenant_id IS NULL` dashboard belongs to the deployment", () => {
  let h: TestHarness;
  let attackerHeaders: Record<string, string>;
  let globalDashboardId: string;
  let globalPanelId: string;

  beforeAll(async () => {
    h = makeHarness();
    const suffix = `${Date.now()}`.slice(-7);
    await seedAdmin(h, `operator-${suffix}@example.test`);

    // A system-seeded, workspace-less dashboard + panel, written the way a
    // template seed would: straight into the table with a NULL tenant.
    globalDashboardId = crypto.randomUUID();
    globalPanelId = crypto.randomUUID();
    const db = new Database(h.env.SQLITE_PATH!);
    db.run(
      `INSERT INTO dashboards (id, tenant_id, name, embed_enabled, created_at, updated_at)
       VALUES (?, NULL, 'Shipped board', 0, ?, ?)`,
      [globalDashboardId, Date.now(), Date.now()],
    );
    db.run(
      `INSERT INTO saved_panels (id, tenant_id, name, kind, viz, dashboard_id, created_at, updated_at)
       VALUES (?, NULL, 'Shipped panel', 'static', 'counter', ?, ?, ?)`,
      [globalPanelId, globalDashboardId, Date.now(), Date.now()],
    );
    db.close();

    // A second identity who is admin of their OWN workspace and nothing else.
    await signOut(h);
    const attackerEmail = `attacker-${suffix}@example.test`;
    expect(
      (await post(h, "/api/auth/sign-up/email", {
        email: attackerEmail,
        password: PASSWORD,
        name: attackerEmail,
      })).status,
    ).toBe(200);
    const created = await post(h, "/api/tenants", { name: `Evil ${suffix}` });
    expect(created.status, "workspace creation is self-serve").toBe(201);
    const evil = (await created.json()) as { data: { slug: string } };
    attackerHeaders = { ...J, "X-Backlex-Tenant": evil.data.slug };
  });
  afterAll(() => h.cleanup());

  test("the attacker can SEE it — reading a shipped dashboard is the point", async () => {
    const res = await h.fetch("/api/admin/dashboards", { headers: attackerHeaders });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((d) => d.id);
    expect(ids).toContain(globalDashboardId);
  });

  test("but may not rename, delete, or publish it", async () => {
    const patch = await h.fetch(`/api/admin/dashboards/${globalDashboardId}`, {
      method: "PATCH",
      headers: attackerHeaders,
      body: JSON.stringify({ name: "Mine now" }),
    });
    expect(patch.status).toBe(403);
    expect(await patch.text()).toContain("whole deployment");

    const share = await h.fetch(`/api/admin/dashboards/${globalDashboardId}/share`, {
      method: "POST",
      headers: attackerHeaders,
      body: "{}",
    });
    expect(share.status, "publishing it to an unauthenticated URL is the sharpest edge").toBe(403);

    const del = await h.fetch(`/api/admin/dashboards/${globalDashboardId}`, {
      method: "DELETE",
      headers: attackerHeaders,
    });
    expect(del.status).toBe(403);
  });

  test("nor rewrite the panel every other workspace renders", async () => {
    const patch = await h.fetch(`/api/admin/panels/${globalPanelId}`, {
      method: "PATCH",
      headers: attackerHeaders,
      body: JSON.stringify({ name: "Mine now" }),
    });
    expect(patch.status).toBe(403);

    const del = await h.fetch(`/api/admin/panels/${globalPanelId}`, {
      method: "DELETE",
      headers: attackerHeaders,
    });
    expect(del.status).toBe(403);
  });

  test("their OWN dashboard is still fully theirs", async () => {
    const mine = await h.fetch("/api/admin/dashboards", {
      method: "POST",
      headers: attackerHeaders,
      body: JSON.stringify({ name: "Ours" }),
    });
    expect(mine.status).toBe(201);
    const id = ((await mine.json()) as { data: { id: string } }).data.id;
    const patch = await h.fetch(`/api/admin/dashboards/${id}`, {
      method: "PATCH",
      headers: attackerHeaders,
      body: JSON.stringify({ name: "Ours, renamed" }),
    });
    expect(patch.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6b — the metrics overview counts the instance's rows for the operator only
//
// The roadmap's Faz 1 sweep filed this and handed it to Faz 4 as "the same
// `isNull(tenantId)`-in-a-predicate shape". It is smaller than the seven — only
// counts leave the handler, never row content — but `routes/activity.ts` reads
// the SAME table and already refuses this to a non-operator, so the two
// endpoints disagreed about who the instance's pre-auth trail belongs to.
// ---------------------------------------------------------------------------

describe("metrics does not count the instance's activity for a workspace admin", () => {
  let h: TestHarness;
  let attackerHeaders: Record<string, string>;
  let operatorEmail: string;

  const overview = (headers: Record<string, string>) =>
    h.fetch("/api/admin/metrics/overview?range=1h", { headers });

  const requestsIn = async (res: Response): Promise<number> => {
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { series?: { requests: number }[] } };
    return (body.data?.series ?? []).reduce((n, b) => n + b.requests, 0);
  };

  beforeAll(async () => {
    h = makeHarness();
    const suffix = `${Date.now()}`.slice(-7);
    operatorEmail = (await seedAdmin(h, `operator-${suffix}@example.test`)).email;

    // 40 instance-owned activity rows — the shape `lib/auth-rate-limit.ts`
    // writes during sign-in, before any workspace is known.
    const db = new Database(h.env.SQLITE_PATH!);
    for (let i = 0; i < 40; i++) {
      db.run(
        `INSERT INTO activity (id, tenant_id, user_id, action, collection, created_at)
         VALUES (?, NULL, NULL, 'auth.rate_limited', '-', ?)`,
        [crypto.randomUUID(), Date.now() - 1000],
      );
    }
    db.close();

    await signOut(h);
    const attackerEmail = `attacker-${suffix}@example.test`;
    expect(
      (await post(h, "/api/auth/sign-up/email", {
        email: attackerEmail,
        password: PASSWORD,
        name: attackerEmail,
      })).status,
    ).toBe(200);
    const created = await post(h, "/api/tenants", { name: `Evil ${suffix}` });
    expect(created.status).toBe(201);
    const evil = (await created.json()) as { data: { slug: string } };
    attackerHeaders = { ...J, "X-Backlex-Tenant": evil.data.slug };
  });
  afterAll(() => h.cleanup());

  test("a self-made workspace admin's graph excludes them", async () => {
    // Their brand-new workspace has a handful of its own rows (the create), and
    // certainly not the 40 planted instance ones.
    expect(await requestsIn(await overview(attackerHeaders))).toBeLessThan(40);
  });

  test("the instance operator still sees them", async () => {
    await signOut(h);
    expect((await signIn(h, operatorEmail)).status).toBe(200);
    // Same 40 rows, same window, the other identity. Without the operator arm
    // the fix would read as "nobody sees instance rows", which is a different
    // (and wrong) behaviour that the refusal test alone cannot tell apart.
    expect(
      await requestsIn(await overview({ ...J, "X-Backlex-Tenant": "default" })),
    ).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// 7 — erasure reaches the indexes the write path writes
// ---------------------------------------------------------------------------

describe("erasure removes the subject from the derived indexes too", () => {
  let h: TestHarness;
  let physical: string;
  const victim = `victim-${Date.now()}@example.test`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    expect(
      (await post(h, "/api/collections", {
        slug: "contacts",
        fts: true,
        fields: [
          { name: "email", type: "email", searchable: true },
          { name: "bio", type: "text", searchable: true },
        ],
      })).status,
    ).toBe(201);
    await createItem(h, "contacts", { email: victim, bio: `${victim} lives in Berlin` });
    const meta = await h.fetch("/api/collections/contacts");
    physical = ((await meta.json()) as { data: { physicalTable: string } }).data.physicalTable;
  });
  afterAll(() => h.cleanup());

  const ftsRows = (): number => {
    const db = new Database(h.env.SQLITE_PATH!);
    try {
      const rows = db
        .query(`SELECT content FROM ${physical}__fts`)
        .all() as Array<{ content: string }>;
      return rows.filter((r) => r.content.includes(victim)).length;
    } finally {
      db.close();
    }
  };

  test("the control: the write path DID index it", () => {
    expect(ftsRows()).toBe(1);
  });

  test("a delete-mode run leaves nothing behind in the shadow table", async () => {
    const preview = await post(h, "/api/admin/erasure/preview", {
      subject: { type: "email", value: victim },
      mode: "delete",
    });
    expect(preview.status).toBe(201);
    const id = ((await preview.json()) as { data: { id: string } }).data.id;
    const run = await post(h, `/api/admin/erasure/${id}/run`, {
      subject: { type: "email", value: victim },
      mode: "delete",
      confirm: true,
    });
    expect(run.status).toBe(200);
    expect(((await run.json()) as { data: { status: string } }).data.status).toBe("completed");
    // The report said "completed" before this fix too — while this returned 1.
    expect(ftsRows()).toBe(0);
  });
});
