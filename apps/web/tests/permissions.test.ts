/**
 * Smoke tests for the permission DSL + owner-scope contract.
 *
 * Each describe block builds a fresh harness (its own DB) and runs one
 * independent scenario. Identity switches happen by sign-out + sign-up
 * (subsequent signups land as `authenticated`, not admin).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

const signUp = (h: TestHarness, email: string, name: string) =>
  h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery", name }),
  });

const signIn = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });

const signOut = (h: TestHarness) =>
  h.fetch("/api/auth/sign-out", { method: "POST" });

const filterQs = (dsl: unknown): string =>
  `filter=${encodeURIComponent(JSON.stringify(dsl))}`;

describe("owner-scope: user2 creates, user3 cannot see it", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}_isolation`;
  let adminEmail: string;
  let user2Email: string;
  let user3Email: string;
  let user2ItemId: string;

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;

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

    // user2: signs up + becomes the owner of one item.
    await signOut(h);
    user2Email = `user2-${Date.now()}@example.test`;
    const su2 = await signUp(h, user2Email, "User Two");
    expect(su2.status).toBe(200);

    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "user2-note" }),
    });
    expect(ins.status).toBe(201);
    const insBody = (await ins.json()) as {
      data: { id: string; title: string; ownerId: string };
    };
    user2ItemId = insBody.data.id;
    expect(insBody.data.title).toBe("user2-note");
    // owner_id is auto-stamped — user2 is the owner.
    expect(typeof insBody.data.ownerId).toBe("string");
    expect(insBody.data.ownerId.length).toBeGreaterThan(0);

    // user3: independent identity, no relation to user2's row.
    await signOut(h);
    user3Email = `user3-${Date.now()}@example.test`;
    const su3 = await signUp(h, user3Email, "User Three");
    expect(su3.status).toBe(200);
  });

  afterAll(() => {
    h.cleanup();
    // Reference the captured emails so they aren't flagged as unused.
    void adminEmail;
  });

  test("user3 GET /items/:slug returns an empty list (filtered by owner)", async () => {
    const res = await h.fetch(`/api/items/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0);
  });

  test("user3 GET /items/:slug/:id of user2's row is 404 (filter excludes it)", async () => {
    const res = await h.fetch(`/api/items/${slug}/${user2ItemId}`);
    expect(res.status).toBe(404);
  });
});

describe("owner-scope: owner can edit own row; non-owner sees 404", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}_edit`;
  let user2Email: string;
  let user2ItemId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

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

    await signOut(h);
    user2Email = `user2-${Date.now()}@example.test`;
    const su2 = await signUp(h, user2Email, "User Two");
    expect(su2.status).toBe(200);

    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "to-edit" }),
    });
    expect(ins.status).toBe(201);
    user2ItemId = ((await ins.json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("user2 PATCHes their own item → 200", async () => {
    const res = await h.fetch(`/api/items/${slug}/${user2ItemId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "renamed-by-owner" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string } };
    expect(body.data.title).toBe("renamed-by-owner");
  });

  test("user3 PATCH on user2's item → 404 (owner_id filter excludes the row)", async () => {
    await signOut(h);
    const su3 = await signUp(h, `user3-${Date.now()}@example.test`, "User Three");
    expect(su3.status).toBe(200);

    const res = await h.fetch(`/api/items/${slug}/${user2ItemId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "hijack" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("admin bypass: admin sees and mutates rows from every owner", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}_adminbypass`;
  let adminEmail: string;
  let user2ItemId: string;

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;

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

    // user2 writes their row.
    await signOut(h);
    const user2Email = `user2-${Date.now()}@example.test`;
    await signUp(h, user2Email, "User Two");
    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "by-user2" }),
    });
    expect(ins.status).toBe(201);
    user2ItemId = ((await ins.json()) as { data: { id: string } }).data.id;

    // Switch back to admin.
    await signOut(h);
    const back = await signIn(h, adminEmail);
    expect(back.status).toBe(200);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("admin GET list returns every row regardless of owner", async () => {
    const res = await h.fetch(`/api/items/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.some((r) => r.id === user2ItemId)).toBe(true);
  });

  test("admin can PATCH another user's row", async () => {
    const res = await h.fetch(`/api/items/${slug}/${user2ItemId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "edited-by-admin" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string } };
    expect(body.data.title).toBe("edited-by-admin");
  });

  test("admin can DELETE another user's row", async () => {
    const res = await h.fetch(`/api/items/${slug}/${user2ItemId}`, {
      method: "DELETE",
    });
    expect(res.status).toBeLessThan(400);

    const after = await h.fetch(`/api/items/${slug}/${user2ItemId}`);
    expect(after.status).toBe(404);
  });
});

describe("filter DSL operators (admin on a non-owner-scoped collection)", () => {
  let h: TestHarness;
  const slug = `posts_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        ownerScoped: false,
        fields: [
          { name: "views", type: "integer" },
          { name: "status", type: "text" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    for (const row of [
      { views: 10, status: "draft" },
      { views: 50, status: "published" },
      { views: 100, status: "published" },
    ]) {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(row),
      });
      expect(r.status).toBe(201);
    }
  });

  afterAll(() => {
    h.cleanup();
  });

  test("_gt returns rows whose value strictly exceeds the threshold", async () => {
    const res = await h.fetch(
      `/api/items/${slug}?${filterQs({ views: { _gt: 10 } })}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { views: number }[] };
    expect(body.data.length).toBe(2);
    expect(body.data.every((r) => r.views > 10)).toBe(true);
  });

  test("_in matches any of the listed values", async () => {
    const res = await h.fetch(
      `/api/items/${slug}?${filterQs({ status: { _in: ["draft", "archived"] } })}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }[] };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.status).toBe("draft");
  });

  test("$and of two clauses narrows the set", async () => {
    const res = await h.fetch(
      `/api/items/${slug}?${filterQs({
        $and: [{ status: { _eq: "published" } }, { views: { _gte: 100 } }],
      })}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { views: number; status: string }[] };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.views).toBe(100);
    expect(body.data[0]?.status).toBe("published");
  });

  test("_starts_with does a prefix match", async () => {
    const res = await h.fetch(
      `/api/items/${slug}?${filterQs({ status: { _starts_with: "pub" } })}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }[] };
    expect(body.data.length).toBe(2);
    expect(body.data.every((r) => r.status.startsWith("pub"))).toBe(true);
  });
});

describe("anonymous read of a user collection is denied", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}_anon`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
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
    // Drop the session so the next request is anonymous.
    await signOut(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("GET /items/:slug as anonymous → 401 (no `public` role permission)", async () => {
    const res = await h.fetch(`/api/items/${slug}`);
    // Anonymous → middleware throws UNAUTHORIZED (401) per
    // requirePermission: `auth.userId ? FORBIDDEN : UNAUTHORIZED`.
    expect(res.status).toBe(401);
  });
});

describe("owner_id cannot be spoofed on POST", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}_spoof`;
  let user2Id: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

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

    await signOut(h);
    await signUp(h, `user2-${Date.now()}@example.test`, "User Two");
    const me = await h.fetch("/api/me");
    expect(me.status).toBe(200);
    user2Id = ((await me.json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("explicit owner_id in body is rejected (system column, not a user field)", async () => {
    // owner_id is a system column, not part of the collection's `fields`.
    // validateBody treats every payload key as a user field, so it surfaces
    // as VALIDATION (422). The contract holds either way: the API never lets
    // a caller pick another user's owner_id.
    const fake = "00000000-0000-0000-0000-000000000000";
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "spoof-attempt", owner_id: fake }),
    });
    expect(res.status).toBe(422);
  });

  test("legit POST stamps owner_id with the signed-in user's id", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "legit" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; ownerId: string };
    };
    expect(body.data.ownerId).toBe(user2Id);

    const get = await h.fetch(`/api/items/${slug}/${body.data.id}`);
    expect(get.status).toBe(200);
    const fetched = (await get.json()) as { data: { ownerId: string } };
    expect(fetched.data.ownerId).toBe(user2Id);
  });
});
