/**
 * Permission-aware collection visibility.
 *
 * `GET /api/collections` (and the single-collection GET) filter by the
 * caller's `read` grants: admins see everything, non-admins only the
 * collections their roles hold at least one read permission for (wildcard
 * `*` = all). This is what hides collections from the sidebar tree, the
 * Collections page, the command palette, and CLI/MCP schema reads for
 * restricted users — metadata (field names) stops leaking to users who
 * could never read the rows anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("collections visibility (permission-filtered list)", () => {
  let h: TestHarness;
  const ts = Date.now();
  const visibleSlug = `vis_a_${ts}`;
  const hiddenSlug = `vis_b_${ts}`;
  let authRoleId: string;
  let adminEmail: string;

  const listSlugs = async (): Promise<string[]> => {
    const res = await h.fetch("/api/collections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { slug: string }[] };
    return body.data.map((c) => c.slug);
  };

  const signInAdmin = () =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: "correct-horse-battery" }),
    });

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;
    for (const slug of [visibleSlug, hiddenSlug]) {
      const r = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
      });
      expect(r.status).toBe(201);
    }
    // Grant the `authenticated` role read on ONE of the two collections.
    const roles = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRole = roles.find((r) => r.name === "authenticated");
    expect(authRole).toBeTruthy();
    authRoleId = authRole!.id;
    const grant = await h.fetch(`/api/roles/${authRoleId}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: visibleSlug, action: "read", condition: null }),
    });
    expect(grant.status).toBeLessThan(300);
    // Switch to a fresh non-admin identity (subsequent signups land as
    // `authenticated`, not admin).
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `viewer-${ts}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(su.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("non-admin: /api/me confirms isAdmin=false", async () => {
    const me = (await (await h.fetch("/api/me")).json()) as {
      data: { isAdmin: boolean };
    };
    expect(me.data.isAdmin).toBe(false);
  });

  test("non-admin list only contains collections with a read grant", async () => {
    const slugs = await listSlugs();
    expect(slugs).toContain(visibleSlug);
    expect(slugs).not.toContain(hiddenSlug);
  });

  test("single GET: granted → 200, ungranted → 404", async () => {
    const ok = await h.fetch(`/api/collections/${visibleSlug}`);
    expect(ok.status).toBe(200);
    const denied = await h.fetch(`/api/collections/${hiddenSlug}`);
    expect(denied.status).toBe(404);
  });

  test("wildcard read grant reveals everything", async () => {
    await signInAdmin();
    const grant = await h.fetch(`/api/roles/${authRoleId}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: "*", action: "read", condition: null }),
    });
    expect(grant.status).toBeLessThan(300);
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const si = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `viewer-${ts}@example.test`,
        password: "correct-horse-battery",
      }),
    });
    expect(si.status).toBe(200);
    const slugs = await listSlugs();
    expect(slugs).toContain(visibleSlug);
    expect(slugs).toContain(hiddenSlug);
  });

  test("admin still sees everything", async () => {
    await signInAdmin();
    const slugs = await listSlugs();
    expect(slugs).toContain(visibleSlug);
    expect(slugs).toContain(hiddenSlug);
  });
});
