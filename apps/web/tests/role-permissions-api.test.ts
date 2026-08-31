/**
 * The two endpoints a set-shaped role editor needs, and the one property that
 * makes them worth having: what they write is what the resolver reads.
 *
 * Before these existed the admin's permission matrix had nowhere to save to.
 * `POST /api/roles/{id}/permissions` grants ONE row and `DELETE
 * /api/permissions/{id}` revokes ONE row, so a screen that hands over a whole
 * matrix had to decompose it into N calls, decide client-side which stored rows
 * were missing from its own view, and hope none of the calls failed halfway.
 * It did none of that — it sent the role's name and dropped the matrix on the
 * floor while captioning the pane "saved on save".
 *
 * So:
 *
 *   1. `PUT /api/roles/{id}/permissions` takes the COMPLETE desired set and
 *      diffs it server-side. One call adds, changes and removes.
 *   2. `PATCH /api/permissions/{id}` edits a stored condition IN PLACE, keeping
 *      the row id — the thing delete-and-regrant destroys along with every
 *      audit row already pointing at it.
 *
 * The last block is the one that matters most. Asserting that a table now holds
 * the requested rows proves the write landed SOMEWHERE; it does not prove it
 * landed where authorization is decided, and the two are separated here by a
 * per-isolate cache with a 30-second TTL that a naive test would never notice
 * because it reads the table directly. So the resolver is driven through a real
 * app-plane request instead, and each restriction is asserted against a
 * PRECEDING unrestricted state — an empty result set proves nothing unless the
 * same query returned rows a moment earlier.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";

const JSON_HEADERS = { "content-type": "application/json" } as const;

interface PermRow {
  id: string;
  roleId: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

interface Applied {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** `(collection, action)` pairs, sorted — the shape a matrix save is about. */
const cells = (rows: PermRow[]): string[] =>
  rows.map((r) => `${r.collection}:${r.action}`).sort();

describe("PUT /api/roles/{id}/permissions — one call adds, changes and removes", () => {
  let h: TestHarness;
  let roleId: string;
  let readId: string;
  let createId: string;
  let updateId: string;

  const listPermissions = async (): Promise<PermRow[]> => {
    const res = await h.fetch(`/api/roles/${roleId}/permissions`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: PermRow[] }).data;
  };

  const grant = async (body: unknown): Promise<string> => {
    const res = await h.fetch(`/api/roles/${roleId}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const role = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `matrix-${Date.now()}` }),
    });
    expect(role.status).toBe(201);
    roleId = ((await role.json()) as { data: { id: string } }).data.id;

    // The starting set, granted the one-row-at-a-time way the editor could not
    // use. `update` is the row the PUT will drop.
    readId = await grant({ collection: "posts", action: "read" });
    createId = await grant({
      collection: "posts",
      action: "create",
      condition: { status: { _eq: "draft" } },
    });
    updateId = await grant({ collection: "posts", action: "update" });
  });

  afterAll(() => h.cleanup());

  test("the fixture really is three rows (a vacuous diff would look identical)", async () => {
    // Everything below is a claim about a CHANGE. Without this, a PUT that
    // silently did nothing to an already-empty set would satisfy most of it.
    expect(cells(await listPermissions())).toEqual([
      "posts:create",
      "posts:read",
      "posts:update",
    ]);
  });

  test("add + change + remove in one request leaves exactly the requested set", async () => {
    const res = await h.fetch(`/api/roles/${roleId}/permissions`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        permissions: [
          // unchanged, named by id
          { id: readId, collection: "posts", action: "read" },
          // changed condition, named by id — the row must survive the edit
          {
            id: createId,
            collection: "posts",
            action: "create",
            condition: { status: { _eq: "review" } },
          },
          // brand new, no id — the editor does not know row ids for cells it
          // has just ticked
          { collection: "posts", action: "publish" },
          // `posts:update` is simply absent, which is how a set expresses a
          // revoke
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PermRow[]; applied: Applied };

    expect(body.applied).toEqual({
      created: 1,
      updated: 1,
      deleted: 1,
      unchanged: 1,
    });

    // The response is read back out of the table, so this is the same claim as
    // the follow-up GET — asserted twice on purpose, because a handler echoing
    // its own request body would pass the first and fail the second.
    expect(cells(body.data)).toEqual([
      "posts:create",
      "posts:publish",
      "posts:read",
    ]);
    expect(cells(await listPermissions())).toEqual([
      "posts:create",
      "posts:publish",
      "posts:read",
    ]);
  });

  test("rows named by id keep their id; the dropped row is gone", async () => {
    const rows = await listPermissions();
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.has(readId)).toBe(true);
    expect(byId.get(createId)?.condition).toEqual({ status: { _eq: "review" } });
    expect(byId.has(updateId)).toBe(false);

    // And the new one got an id of its own rather than reusing the dropped
    // row's.
    const publish = rows.find((r) => r.action === "publish");
    expect(publish).toBeDefined();
    expect(publish?.id).not.toBe(updateId);
  });

  test("an entry with no id matches an existing cell instead of duplicating it", async () => {
    // The matrix does not carry row ids. Re-saving the same ticked cells with
    // a different condition must EDIT the row behind the cell, not stack a
    // second grant on top of it — two rows for one cell OR their conditions
    // together, which would quietly widen access on every save.
    const res = await h.fetch(`/api/roles/${roleId}/permissions`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        permissions: [
          { collection: "posts", action: "read" },
          {
            collection: "posts",
            action: "create",
            condition: { status: { _eq: "published" } },
          },
          { collection: "posts", action: "publish" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { applied } = (await res.json()) as { applied: Applied };
    expect(applied).toEqual({ created: 0, updated: 1, deleted: 0, unchanged: 2 });

    const rows = await listPermissions();
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.id === createId)?.condition).toEqual({
      status: { _eq: "published" },
    });
  });

  test("an empty set revokes everything the role held", async () => {
    const res = await h.fetch(`/api/roles/${roleId}/permissions`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ permissions: [] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { applied: Applied }).applied.deleted).toBe(3);
    expect(await listPermissions()).toEqual([]);
  });

  test("the save lands one `role.update` audit row naming the rows it touched", async () => {
    const res = await h.fetch("/api/activity?action=role&limit=100");
    expect(res.status).toBe(200);
    const rows = (
      (await res.json()) as {
        data: { action: string; itemId: string | null; payload?: unknown }[];
      }
    ).data;

    // Four PUTs ran above (one per test), all keyed to the role id.
    const saves = rows.filter(
      (r) => r.action === "role.update" && r.itemId === roleId,
    );
    expect(saves.length).toBeGreaterThanOrEqual(3);

    const payloads = saves.map((r) => r.payload as Record<string, unknown>);
    const addChangeRemove = payloads.find(
      (p) => p.created === 1 && p.updated === 1 && p.deleted === 1,
    );
    expect(addChangeRemove).toBeDefined();
    expect(addChangeRemove?.roleId).toBe(roleId);
    // Ids are opaque and searchable; the DSL and the field list are not, and
    // `redact()` only inspects key names, so neither may appear.
    expect(
      (addChangeRemove?.permissionIds as string[]).includes(createId),
    ).toBe(true);
    expect(addChangeRemove).not.toHaveProperty("condition");
    expect(addChangeRemove).not.toHaveProperty("fields");
    expect(JSON.stringify(addChangeRemove)).not.toContain("review");
  });
});

describe("PATCH /api/permissions/{id} — edit a condition without losing the row", () => {
  let h: TestHarness;
  let roleId: string;
  let permId: string;

  const readRow = async (): Promise<PermRow> => {
    const res = await h.fetch(`/api/roles/${roleId}/permissions`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: PermRow[] }).data;
    expect(rows.length).toBe(1);
    return rows[0]!;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const role = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `editable-${Date.now()}` }),
    });
    roleId = ((await role.json()) as { data: { id: string } }).data.id;
    const granted = await h.fetch(`/api/roles/${roleId}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        collection: "invoices",
        action: "read",
        fields: ["id", "total"],
        condition: { region: { _eq: "eu" } },
      }),
    });
    expect(granted.status).toBe(201);
    permId = ((await granted.json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => h.cleanup());

  test("the condition changes and the row id does not", async () => {
    const before = await readRow();
    expect(before.condition).toEqual({ region: { _eq: "eu" } });

    const res = await h.fetch(`/api/permissions/${permId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ condition: { region: { _eq: "uk" } } }),
    });
    expect(res.status).toBe(200);
    const echoed = ((await res.json()) as { data: PermRow }).data;
    expect(echoed.id).toBe(permId);

    const after = await readRow();
    expect(after.id).toBe(permId);
    expect(after.condition).toEqual({ region: { _eq: "uk" } });
    // Untouched keys stay untouched — this is a PATCH, not a replace.
    expect(after.fields).toEqual(["id", "total"]);
  });

  test("an explicit null clears; an omitted key does not", async () => {
    // Both halves have to be asserted or the test cannot tell "cleared" from
    // "never written".
    const clear = await h.fetch(`/api/permissions/${permId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: null }),
    });
    expect(clear.status).toBe(200);

    const after = await readRow();
    expect(after.fields).toBeNull();
    // `condition` was not in the body, so it survived the same request that
    // blanked `fields`.
    expect(after.condition).toEqual({ region: { _eq: "uk" } });
  });

  test("a body with neither key is refused rather than silently accepted", async () => {
    const res = await h.fetch(`/api/permissions/${permId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION",
    );
    // And it really did nothing.
    expect((await readRow()).condition).toEqual({ region: { _eq: "uk" } });
  });

  test("the edit is audited by shape, keyed to the row that was edited", async () => {
    const res = await h.fetch("/api/activity?action=role&limit=100");
    const rows = (
      (await res.json()) as {
        data: { action: string; itemId: string | null; payload?: unknown }[];
      }
    ).data;
    const edits = rows.filter(
      (r) => r.action === "role.update" && r.itemId === permId,
    );
    expect(edits.length).toBe(2);
    const payloads = edits.map((r) => r.payload as Record<string, unknown>);
    expect(payloads.some((p) => (p.changed as string[])?.includes("condition"))).toBe(
      true,
    );
    expect(payloads.some((p) => (p.changed as string[])?.includes("fields"))).toBe(
      true,
    );
    expect(JSON.stringify(payloads)).not.toContain("uk");
  });
});

describe("neither endpoint reaches into another workspace", () => {
  let cast: TwoPlaneCast;
  let roleA: string;
  let roleB: string;
  let permB: string;

  const asOwner = (
    who: "ownerA" | "ownerB",
    slug: string,
  ): ((path: string, init?: RequestInit) => Promise<Response>) => {
    const identity = cast[who];
    // `json()` already supplies `Content-Type`. Adding a second one under a
    // different case does not overwrite it — `Headers` folds same-name values
    // into `application/json, application/json`, which the body parser refuses,
    // and the route then reports a missing `name` instead of a malformed
    // header. Only the tenant pin is added here.
    return (path, init = {}) =>
      identity.fetch(path, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          "X-Backlex-Tenant": slug,
        },
      });
  };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    const inA = asOwner("ownerA", cast.tenantA.slug);
    const inB = asOwner("ownerB", cast.tenantB.slug);

    const a = await inA("/api/roles", json("POST", { name: "role-a" }));
    expect(a.status, "create a role inside workspace A").toBe(201);
    roleA = ((await a.json()) as { data: { id: string } }).data.id;

    const b = await inB("/api/roles", json("POST", { name: "role-b" }));
    expect(b.status).toBe(201);
    roleB = ((await b.json()) as { data: { id: string } }).data.id;

    const grantB = await inB(
      `/api/roles/${roleB}/permissions`,
      json("POST", {
        collection: "secrets",
        action: "read",
        condition: { tenant: { _eq: "b" } },
      }),
    );
    expect(grantB.status).toBe(201);
    permB = ((await grantB.json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => cast.cleanup());

  test("ownerA can save their OWN role's set (so a 404 below means scoping, not a broken route)", async () => {
    const res = await asOwner("ownerA", cast.tenantA.slug)(
      `/api/roles/${roleA}/permissions`,
      json("PUT", { permissions: [{ collection: "notes", action: "read" }] }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { applied: Applied }).applied.created).toBe(1);
  });

  test("a PUT naming another workspace's permission id is refused, and that row survives", async () => {
    const res = await asOwner("ownerA", cast.tenantA.slug)(
      `/api/roles/${roleA}/permissions`,
      json("PUT", {
        permissions: [
          { collection: "notes", action: "read" },
          // Workspace B's row, addressed by a guessed id from workspace A.
          { id: permB, collection: "secrets", action: "read", condition: null },
        ],
      }),
    );
    expect(res.status).toBe(404);

    const stillThere = await asOwner("ownerB", cast.tenantB.slug)(
      `/api/roles/${roleB}/permissions`,
    );
    const rows = ((await stillThere.json()) as { data: PermRow[] }).data;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(permB);
    // The refusal happens before any write, so B's condition is intact rather
    // than merely present.
    expect(rows[0]?.condition).toEqual({ tenant: { _eq: "b" } });
  });

  test("a PUT aimed at another workspace's ROLE is refused", async () => {
    const res = await asOwner("ownerA", cast.tenantA.slug)(
      `/api/roles/${roleB}/permissions`,
      json("PUT", { permissions: [] }),
    );
    expect(res.status).toBe(404);

    const stillThere = await asOwner("ownerB", cast.tenantB.slug)(
      `/api/roles/${roleB}/permissions`,
    );
    expect(((await stillThere.json()) as { data: PermRow[] }).data.length).toBe(1);
  });

  test("a PATCH aimed at another workspace's permission is refused", async () => {
    const res = await asOwner("ownerA", cast.tenantA.slug)(
      `/api/permissions/${permB}`,
      json("PATCH", { condition: { tenant: { _eq: "a" } } }),
    );
    expect(res.status).toBe(404);

    const stillThere = await asOwner("ownerB", cast.tenantB.slug)(
      `/api/roles/${roleB}/permissions`,
    );
    const rows = ((await stillThere.json()) as { data: PermRow[] }).data;
    expect(rows[0]?.condition).toEqual({ tenant: { _eq: "b" } });
  });

  test("ownerB CAN patch their own row (the 404 above is about the workspace, not the verb)", async () => {
    const res = await asOwner("ownerB", cast.tenantB.slug)(
      `/api/permissions/${permB}`,
      json("PATCH", { condition: { tenant: { _eq: "b2" } } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: PermRow }).data.condition).toEqual({
      tenant: { _eq: "b2" },
    });
  });
});

describe("what the set replace writes is what the resolver reads", () => {
  let h: TestHarness;
  let roleId: string;
  let mineId: string;
  let theirsId: string;
  let bearer: (path: string, init?: RequestInit) => Promise<Response>;

  const slug = `perm_posts_${Date.now()}`;

  const put = (permissions: unknown[]) =>
    h.fetch(`/api/roles/${roleId}/permissions`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ permissions }),
    });

  const visibleIds = async (): Promise<string[]> => {
    const res = await bearer(`/api/items/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    return body.data.map((r) => String(r.id)).sort();
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const coll = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "owner_tag", type: "text" },
        ],
      }),
    });
    expect(coll.status).toBe(201);

    const insert = async (title: string, tag: string): Promise<string> => {
      const res = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title, owner_tag: tag }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    mineId = await insert("mine", "mine");
    theirsId = await insert("theirs", "theirs");

    // A role with NO permissions yet, bound to an app-plane end-user. The app
    // plane has no admin bypass, so this identity sees exactly what the
    // permission rows say and nothing else.
    const role = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `portal-${Date.now()}` }),
    });
    roleId = ((await role.json()) as { data: { id: string } }).data.id;

    const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `portal.perms.${Date.now()}@example.test`,
        password: "portal-pass-123",
        name: "Portal Perms",
      }),
    });
    expect(signup.status).toBe(200);
    const session = (await signup.json()) as {
      token?: string;
      accessToken?: string;
      user?: { id?: string };
    };
    const token = session.accessToken ?? session.token;
    expect(token).toBeTruthy();

    const users = (await (await h.fetch("/api/app-users")).json()) as {
      data: { id: string; email: string }[];
    };
    const appUserId = users.data[users.data.length - 1]!.id;
    const bind = await h.fetch(`/api/app-users/${appUserId}/roles`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ roleIds: [roleId] }),
    });
    expect(bind.status).toBe(200);

    bearer = (path, init = {}) =>
      Promise.resolve(h.app.request(path, {
        ...init,
        headers: {
          ...JSON_HEADERS,
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      }));
  });

  afterAll(() => h.cleanup());

  test("with no grant the end-user reads nothing", async () => {
    const res = await bearer(`/api/items/${slug}`);
    expect([401, 403]).toContain(res.status);
  });

  test("an UNCONDITIONAL read granted by PUT is felt immediately, and shows both rows", async () => {
    // This is the state every restriction below is measured against. Without
    // it, "the list came back with one row" would be indistinguishable from
    // "the grant never reached the resolver at all".
    const res = await put([{ collection: slug, action: "read" }]);
    expect(res.status).toBe(200);
    expect(await visibleIds()).toEqual([mineId, theirsId].sort());
  });

  test("adding a condition through PUT filters the very next request", async () => {
    const res = await put([
      {
        collection: slug,
        action: "read",
        condition: { owner_tag: { _eq: "mine" } },
      },
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { applied: Applied }).applied.updated).toBe(1);
    // Not "fewer rows" — exactly the row the condition names. The 30s
    // permission cache would have served the unrestricted answer here if the
    // handler had skipped its invalidation.
    expect(await visibleIds()).toEqual([mineId]);
  });

  test("editing that condition through PATCH moves the filter, keeping the row id", async () => {
    const rows = ((await (
      await h.fetch(`/api/roles/${roleId}/permissions`)
    ).json()) as { data: PermRow[] }).data;
    expect(rows.length).toBe(1);
    const permId = rows[0]!.id;

    const res = await h.fetch(`/api/permissions/${permId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ condition: { owner_tag: { _eq: "theirs" } } }),
    });
    expect(res.status).toBe(200);

    // The filter flipped to the OTHER row — an assertion that cannot pass by
    // accident the way "the list shrank" can.
    expect(await visibleIds()).toEqual([theirsId]);

    const afterRows = ((await (
      await h.fetch(`/api/roles/${roleId}/permissions`)
    ).json()) as { data: PermRow[] }).data;
    expect(afterRows[0]?.id).toBe(permId);
  });

  test("revoking through an empty PUT closes the door again", async () => {
    const res = await put([]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { applied: Applied }).applied.deleted).toBe(1);
    const after = await bearer(`/api/items/${slug}`);
    expect([401, 403]).toContain(after.status);
  });
});
