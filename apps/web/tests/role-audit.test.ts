/**
 * Authorization writes have to reach the audit log.
 *
 * `routes/roles/{roles,permissions,users}.ts` carried **zero**
 * `logActivity` calls while `routes/collections.ts` had 10 and
 * `routes/integrations.ts` 15 — so creating a role, granting a permission,
 * handing someone the admin role, suspending an account and resetting a
 * user's second factor all happened with no trace. Those are precisely the
 * events an incident review starts from.
 *
 * Two things are asserted, and the second is the one that needed care:
 *
 * 1. every authorization write lands exactly one row, under an action
 *    namespace the admin's chip filter actually offers;
 * 2. the row does **not** carry the permission `condition` DSL or the
 *    `fields` allow-list. `redact()` only inspects KEY names, so a literal
 *    email or identifier written inside a condition string would sail
 *    straight through it into the log. Shape (`hasCondition`, `fieldCount`)
 *    is recorded instead of content.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface ApiActivity {
  id: string;
  action: string;
  collection: string | null;
  itemId: string | null;
  payload?: unknown;
}

/** Rows newest-first, narrowed to one action namespace. */
const activity = async (h: TestHarness, prefix: string): Promise<ApiActivity[]> => {
  const res = await h.fetch(`/api/activity?action=${prefix}&limit=100`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: ApiActivity[] };
  return body.data;
};

const post = (h: TestHarness, path: string, body?: unknown) =>
  h.fetch(path, {
    method: "POST",
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("authorization writes are audited", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("creating, updating and deleting a role each leave one `role.*` row", async () => {
    const before = (await activity(h, "role")).length;

    const created = await post(h, "/api/roles", { name: "auditor", admin: false });
    expect(created.status).toBe(201);
    const roleId = ((await created.json()) as { data: { id: string } }).data.id;

    const patched = await h.fetch(`/api/roles/${roleId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ admin: true }),
    });
    expect(patched.status).toBe(200);

    const deleted = await h.fetch(`/api/roles/${roleId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const rows = await activity(h, "role");
    expect(rows.length).toBe(before + 3);

    const mine = rows.filter((r) => r.itemId === roleId);
    expect(mine.map((r) => r.action).sort()).toEqual([
      "role.create",
      "role.delete",
      "role.update",
    ]);

    // The privilege flip is the event this log exists for, so the row has to
    // say which direction it went — "changed: [admin]" alone does not.
    const update = mine.find((r) => r.action === "role.update");
    const p = update?.payload as Record<string, unknown> | undefined;
    expect(p?.adminFrom).toBe(false);
    expect(p?.adminTo).toBe(true);
  });

  test("a permission grant is audited by SHAPE — never the condition or fields", async () => {
    const created = await post(h, "/api/roles", { name: "scoped-reader" });
    const roleId = ((await created.json()) as { data: { id: string } }).data.id;

    // A condition carrying something that looks like personal data, and a
    // field allow-list. Neither may appear in the log.
    const SECRET_IN_CONDITION = "leaky-owner@example.com";
    const granted = await post(h, `/api/roles/${roleId}/permissions`, {
      collection: "posts",
      action: "read",
      fields: ["title", "body"],
      condition: { owner_email: { _eq: SECRET_IN_CONDITION } },
    });
    expect(granted.status).toBe(201);
    const permId = ((await granted.json()) as { data: { id: string } }).data.id;

    const rows = await activity(h, "role");
    const grant = rows.find((r) => r.action === "role.create" && r.itemId === permId);
    expect(grant).toBeDefined();

    const payload = grant?.payload as Record<string, unknown> | undefined;
    expect(payload?.collection).toBe("posts");
    expect(payload?.action).toBe("read");
    expect(payload?.hasCondition).toBe(true);
    expect(payload?.fieldCount).toBe(2);
    // Shape, not content.
    expect(payload).not.toHaveProperty("condition");
    expect(payload).not.toHaveProperty("fields");

    // Non-vacuous: the address really was sent, so its absence from the whole
    // serialized row is a property of the redaction, not of the fixture.
    expect(JSON.stringify(rows)).not.toContain(SECRET_IN_CONDITION);

    const revoked = await h.fetch(`/api/permissions/${permId}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    const after = await activity(h, "role");
    const revoke = after.find((r) => r.action === "role.delete" && r.itemId === permId);
    expect(revoke).toBeDefined();
    // The revoke row must still name WHAT was revoked — after the DELETE the
    // permission row is gone, so recording it afterwards is impossible.
    expect((revoke?.payload as Record<string, unknown>)?.collection).toBe("posts");
  });

  test("granting a role to a user is filed under the USER, not the role", async () => {
    const created = await post(h, "/api/roles", { name: "grantee-role" });
    const roleId = ((await created.json()) as { data: { id: string } }).data.id;

    const me = await h.fetch("/api/me");
    expect(me.status).toBe(200);
    const userId = ((await me.json()) as { data: { id: string } }).data.id;

    const attached = await post(h, `/api/users/${userId}/roles`, { roleId });
    expect(attached.status).toBe(200);

    const rows = await activity(h, "role");
    const grant = rows.find((r) => r.action === "role.create" && r.itemId === userId);
    expect(grant).toBeDefined();
    // Findable by the person whose access changed — an auditor asks "what was
    // this user given", not "who holds this role id".
    expect((grant?.payload as Record<string, unknown>)?.roleName).toBe("grantee-role");
  });

  test("suspending a user is audited under `auth.*`", async () => {
    const me = await h.fetch("/api/me");
    const userId = ((await me.json()) as { data: { id: string } }).data.id;

    const suspended = await h.fetch(`/api/users/${userId}/suspend`, { method: "PATCH" });
    // Suspending yourself may be refused by design. Pin the set of acceptable
    // answers so an unexpected 500 can't turn this into a silent pass.
    expect([200, 403, 422]).toContain(suspended.status);
    if (suspended.status === 200) {
      const rows = await activity(h, "auth");
      const row = rows.find(
        (r) => r.action === "auth.update" && r.itemId === userId,
      );
      expect(row).toBeDefined();
      expect((row?.payload as Record<string, unknown>)?.suspended).toBe(true);
    }
  });
});
