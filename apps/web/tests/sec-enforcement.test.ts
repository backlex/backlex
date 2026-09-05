/**
 * Phase-1 enforcement-gap regression suite. Several peripheral routes had
 * drifted from the data-plane "gold standard" (requirePermission + tenant
 * scoping + plane check) and exposed real privilege / cross-tenant holes:
 *
 *   - `POST/PATCH/DELETE /api/collections/*` (schema DDL) was gated by
 *     `requireUser` only → any signed-in member (and any workspace end-user)
 *     could create / alter / drop tables. Now platform-admin only.
 *   - `GET /api/collections[/:slug]` was unauthenticated → schema disclosure.
 *   - `POST /api/vector/query` and `/search` had NO auth middleware → anyone
 *     could read the vector store.
 *   - `POST /api/templates/apply` (creates collections) was `requireUser` only.
 *   - `/api/comments` and `/api/notifications` ignored `tenant_id` and required
 *     no auth on reads.
 *
 * This locks the new gates in place.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

describe("phase-1 enforcement gaps", () => {
  let h: TestHarness;
  let adminEmail: string;
  const memberEmail = `member-${Date.now()}@example.test`;
  const slug = `notes_${Date.now()}_sec`;

  const signIn = (email: string) =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: PASSWORD }),
    });
  const signOut = () => h.fetch("/api/auth/sign-out", { method: "POST" });

  const createCollection = (s: string) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: s,
        ownerScoped: true,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h); // first user → admin, opens signup
    adminEmail = adm.email;
    // Admin creates a readable owner-scoped collection.
    expect((await createCollection(slug)).status).toBe(201);
    // Second user signs up → ordinary member (the `authenticated` role only),
    // left signed in via the sign-up cookie.
    await signOut();
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: memberEmail, password: PASSWORD, name: "Member" }),
    });
    expect(su.status).toBe(200);
    await signOut();
  });

  afterAll(() => h.cleanup());

  // ---- collection DDL is platform-admin only -----------------------------

  test("unauthenticated cannot create a collection", async () => {
    await signOut();
    expect((await createCollection(`x_${Date.now()}`)).status).toBe(401);
  });

  test("a non-admin member cannot create a collection (privilege escalation)", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    const res = await createCollection(`x_${Date.now()}`);
    expect(res.status).toBe(403);
  });

  test("a non-admin member cannot drop a collection or its fields", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    const dropTable = await h.fetch(`/api/collections/${slug}`, { method: "DELETE" });
    expect(dropTable.status).toBe(403);
    const dropField = await h.fetch(`/api/collections/${slug}/fields/title`, {
      method: "DELETE",
    });
    expect(dropField.status).toBe(403);
  });

  test("an admin can create a collection", async () => {
    expect((await signIn(adminEmail)).status).toBe(200);
    expect((await createCollection(`ok_${Date.now()}`)).status).toBe(201);
  });

  // ---- schema is no longer disclosed to anonymous callers -----------------

  test("unauthenticated cannot list collections (schema disclosure)", async () => {
    await signOut();
    expect((await h.fetch("/api/collections")).status).toBe(401);
  });

  test("a signed-in member can still list collections", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    expect((await h.fetch("/api/collections")).status).toBe(200);
  });

  // ---- template apply is admin-only --------------------------------------

  test("a non-admin member cannot apply a schema template", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    const res = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ templateId: "blank" }),
    });
    expect(res.status).toBe(403);
  });

  // ---- vector read endpoints now require auth -----------------------------

  test("unauthenticated cannot query or search the vector store", async () => {
    await signOut();
    const q = await h.fetch("/api/vector/query", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "bge-m3", values: [0.1, 0.2] }),
    });
    expect(q.status).toBe(401);
    const s = await h.fetch("/api/vector/search", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "bge-m3", text: "hi" }),
    });
    expect(s.status).toBe(401);
  });

  // ---- comments / notifications require auth ------------------------------

  test("unauthenticated cannot read comments or notifications", async () => {
    await signOut();
    const comments = await h.fetch(`/api/comments?collection=${slug}&itemId=x`);
    expect(comments.status).toBe(401);
    const notifs = await h.fetch("/api/notifications");
    expect(notifs.status).toBe(401);
  });

  test("a member can create and read back a comment on a readable ROW", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    // A row they own. This used to pass `itemId: "item-1"`, an id no row ever
    // had, and got a 201 — because the endpoint checked `read` on the
    // COLLECTION and never looked at the row. A thread now hangs off a row the
    // caller can actually read, so an id that names nothing is a 404 like any
    // other unreadable row (see `comments-rest.test.ts` for the leak itself).
    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "mine" }),
    });
    expect(ins.status).toBe(201);
    const itemId = ((await ins.json()) as { data: { id: string } }).data.id;
    const created = await h.fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, itemId, body: "hello" }),
    });
    expect(created.status).toBe(201);
    const list = await h.fetch(`/api/comments?collection=${slug}&itemId=${itemId}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: Array<{ body: string }> };
    expect(body.data.some((r) => r.body === "hello")).toBe(true);

    // And an id that names no row is refused, not answered.
    const ghost = await h.fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, itemId: "item-1", body: "hello" }),
    });
    expect(ghost.status).toBe(404);
  });
});
