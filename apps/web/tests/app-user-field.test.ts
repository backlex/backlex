/**
 * The `interface: "user"` field — a text column that references a workspace
 * end-user (`app_users.id`, the app plane of docs/auth-planes.md). Covered:
 *   - schema: the interface is accepted on `text` and rejected on other types
 *   - write integrity: a bogus app-user id 422s on create AND update; a real
 *     id (created via the tenant auth surface) passes; null/omitted stays
 *     allowed; a SUSPENDED end-user is still a valid link target
 *   - `GET /api/app-users?q=` email/name substring search (admin list), used
 *     by the admin picker
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("interface \"user\": app-user link field", () => {
  let h: TestHarness;
  const slug = `people_${Date.now()}`;
  let appUserId: string;
  let suspendedId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "app_user_id", type: "text", interface: "user" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    // Two end-users through the app-plane auth surface — one stays active,
    // one gets suspended (a suspended user must remain a valid link target).
    for (const u of [
      { email: "linked.user@example.test", name: "Linked User" },
      { email: "suspended.user@example.test", name: "Suspended User" },
    ]) {
      const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...u, password: "portal-pass-123" }),
      });
      expect(signup.status).toBe(200);
    }
    const users = (await (await h.fetch("/api/app-users")).json()) as {
      data: { id: string; email: string }[];
    };
    appUserId = users.data.find((u) => u.email === "linked.user@example.test")!.id;
    suspendedId = users.data.find((u) => u.email === "suspended.user@example.test")!.id;
    const suspend = await h.fetch(`/api/app-users/${suspendedId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(suspend.status).toBe(200);
  });

  afterAll(() => h.cleanup());

  const post = (body: unknown) =>
    h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  const patch = (id: string, body: unknown) =>
    h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  test("create with a bogus app-user id → 422 VALIDATION", async () => {
    const res = await post({ name: "Ghost", app_user_id: "no-such-app-user" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("no-such-app-user");
  });

  test("create with a real app-user id → 201", async () => {
    const res = await post({ name: "Linked", app_user_id: appUserId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { app_user_id: string } };
    expect(body.data.app_user_id).toBe(appUserId);
  });

  test("null / omitted link stays allowed", async () => {
    expect((await post({ name: "No link" })).status).toBe(201);
    expect((await post({ name: "Null link", app_user_id: null })).status).toBe(201);
    expect((await post({ name: "Empty link", app_user_id: "" })).status).toBe(201);
  });

  test("a suspended end-user is still a valid link target", async () => {
    const res = await post({ name: "Suspended link", app_user_id: suspendedId });
    expect(res.status).toBe(201);
  });

  test("update to a bogus id → 422; update to a real id → 200", async () => {
    const created = await post({ name: "Patch me" });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const bad = await patch(id, { app_user_id: "still-not-a-user" });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe("VALIDATION");

    const ok = await patch(id, { app_user_id: appUserId });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { data: { app_user_id: string } };
    expect(okBody.data.app_user_id).toBe(appUserId);

    // Clearing the link stays allowed on update too.
    expect((await patch(id, { app_user_id: null })).status).toBe(200);
  });

  test("schema: the \"user\" interface is rejected on a non-text field", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: `bad_user_iface_${Date.now()}`,
        fields: [{ name: "who", type: "integer", interface: "user" }],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("user");
  });

  test("GET /api/app-users?q= filters by email substring", async () => {
    const res = await h.fetch("/api/app-users?q=linked.user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email: string }[] };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.email).toBe("linked.user@example.test");
  });

  test("GET /api/app-users?q= matches names case-insensitively", async () => {
    const res = await h.fetch("/api/app-users?q=suspended%20user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email: string }[] };
    expect(body.data.map((u) => u.email)).toEqual(["suspended.user@example.test"]);
  });

  test("GET /api/app-users?q= with no match returns an empty list", async () => {
    const res = await h.fetch("/api/app-users?q=zzz-nobody");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  test("GET /api/app-users?ids= narrows to the requested ids", async () => {
    const res = await h.fetch(`/api/app-users?ids=${appUserId},not-an-id`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((u) => u.id)).toEqual([appUserId]);
  });
});
