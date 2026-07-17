/**
 * REST coverage for `/api/comments` (routes/comments.ts).
 *
 * Rules the route enforces (asserted below):
 *   - every endpoint requires a session (401 anonymous);
 *   - create/list require `read` permission on the target collection
 *     (403 when the caller's role can't read it);
 *   - delete is author-or-admin only (403 otherwise), and the lookup is
 *     tenant-scoped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface CommentRow {
  id: string;
  collection: string;
  itemId: string;
  userId: string | null;
  body: string;
}

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

describe("comments REST", () => {
  let h: TestHarness;
  // ownerScoped seeds owner-scoped CRUD for the `authenticated` role, so the
  // non-admin user can read the collection (and therefore comment).
  const slug = `discussed_${Date.now()}`;
  // A second collection the `authenticated` role has NO grants on.
  const lockedSlug = `locked_${Date.now()}`;
  let adminEmail = "";
  const userEmail = `commenter-${Date.now()}@example.test`;
  let itemId = "";
  let adminCommentId = "";
  let userCommentId = "";

  beforeAll(async () => {
    h = makeHarness();
    adminEmail = (await seedAdmin(h)).email;

    for (const [s, ownerScoped] of [
      [slug, true],
      [lockedSlug, false],
    ] as const) {
      const create = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          slug: s,
          ownerScoped,
          fields: [{ name: "title", type: "text", required: true }],
        }),
      });
      expect(create.status).toBe(201);
    }

    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "discussed item" }),
    });
    expect(ins.status).toBe(201);
    itemId = ((await ins.json()) as { data: { id: string } }).data.id;

    // Provision the non-admin identity, then return to the admin session.
    await signOut(h);
    const su = await signUp(h, userEmail, "Commenter");
    expect(su.status).toBe(200);
    await signOut(h);
    const si = await signIn(h, adminEmail);
    expect(si.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("anonymous create/list/delete are rejected with 401", async () => {
    const raw = (path: string, init?: RequestInit) =>
      h.app.fetch(
        new Request(`${h.env.APP_URL}${path}`, {
          ...init,
          headers: { Origin: h.env.APP_URL, ...JSON_HEADERS },
        }),
      );
    const create = await raw("/api/comments", {
      method: "POST",
      body: JSON.stringify({ collection: slug, itemId, body: "nope" }),
    });
    expect(create.status).toBe(401);
    const list = await raw(
      `/api/comments?collection=${slug}&itemId=${itemId}`,
    );
    expect(list.status).toBe(401);
    const del = await raw(`/api/comments/${crypto.randomUUID()}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(401);
  });

  test("admin creates a comment on the item", async () => {
    const res = await h.fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, itemId, body: "first!" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: CommentRow };
    expect(body.data.collection).toBe(slug);
    expect(body.data.itemId).toBe(itemId);
    expect(body.data.body).toBe("first!");
    expect(typeof body.data.userId).toBe("string");
    adminCommentId = body.data.id;
  });

  test("GET / lists the comment", async () => {
    const res = await h.fetch(
      `/api/comments?collection=${slug}&itemId=${itemId}`,
    );
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: CommentRow[] }).data;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(adminCommentId);
    expect(rows[0]?.body).toBe("first!");
  });

  test("non-admin can comment on a readable collection, but not on a locked one", async () => {
    await signOut(h);
    const si = await signIn(h, userEmail);
    expect(si.status).toBe(200);

    const ok = await h.fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, itemId, body: "me too" }),
    });
    expect(ok.status).toBe(201);
    userCommentId = ((await ok.json()) as { data: CommentRow }).data.id;

    // `authenticated` has no read grant on the locked collection → 403.
    const denied = await h.fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: lockedSlug, itemId: "x", body: "hi" }),
    });
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string } };
    expect(deniedBody.error.code).toBe("FORBIDDEN");
  });

  test("non-author non-admin cannot delete someone else's comment", async () => {
    // Still signed in as the non-admin user from the previous test.
    const res = await h.fetch(`/api/comments/${adminCommentId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("author or admin");

    // The comment survived.
    const list = await h.fetch(
      `/api/comments?collection=${slug}&itemId=${itemId}`,
    );
    const rows = ((await list.json()) as { data: CommentRow[] }).data;
    expect(rows.some((r) => r.id === adminCommentId)).toBe(true);
  });

  test("author deletes their own comment", async () => {
    const res = await h.fetch(`/api/comments/${userCommentId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("admin can delete anyone's comment; it is gone afterwards", async () => {
    await signOut(h);
    const si = await signIn(h, adminEmail);
    expect(si.status).toBe(200);

    // Recreate a comment authored by... the admin deleting the non-admin's
    // is already impossible (author deleted their own above), so assert the
    // admin path on the remaining admin comment via a fresh non-admin one.
    await signOut(h);
    await signIn(h, userEmail);
    const mk = await h.fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, itemId, body: "delete me" }),
    });
    expect(mk.status).toBe(201);
    const otherId = ((await mk.json()) as { data: CommentRow }).data.id;

    await signOut(h);
    await signIn(h, adminEmail);
    const del = await h.fetch(`/api/comments/${otherId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);

    const list = await h.fetch(
      `/api/comments?collection=${slug}&itemId=${itemId}`,
    );
    const rows = ((await list.json()) as { data: CommentRow[] }).data;
    expect(rows.some((r) => r.id === otherId)).toBe(false);
    // Only the admin's original comment remains.
    expect(rows.map((r) => r.id)).toEqual([adminCommentId]);
  });

  test("deleting an unknown comment id 404s", async () => {
    const res = await h.fetch(`/api/comments/${crypto.randomUUID()}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
