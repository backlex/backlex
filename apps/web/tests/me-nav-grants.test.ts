/**
 * Per-permission nav grants on `GET /api/me`.
 *
 * The `nav` object tells the admin SPA which permission-gated pages a
 * non-admin can actually use, so the sidebar/palette hide the rest:
 *  - `collections` / `revisions` — at least one readable non-system
 *    collection (revisions is gated per-collection-read).
 *  - `storage` — a read grant on the system files collection.
 * Admins and wildcard read grants light up everything. Hiding is cosmetic —
 * every endpoint stays gated server-side.
 *
 * Note: a first-ever boot seeds `authenticated` with owner-scoped
 * `system_files` permissions (storage visible by default), but that seed is
 * guarded by a module-level once-per-process flag in app.ts, so whether THIS
 * spec's fresh DB has it depends on suite ordering. beforeAll revokes any
 * such rows so every assertion here is deterministic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface MeNav {
  collections: boolean;
  storage: boolean;
  revisions: boolean;
}

describe("me nav grants (per-permission sidebar visibility)", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `navgrant_${ts}`;
  let authRoleId: string;
  let adminEmail: string;
  const viewerEmail = `nav-viewer-${ts}@example.test`;

  const fetchNav = async (): Promise<{ isAdmin: boolean; nav: MeNav }> => {
    const res = await h.fetch("/api/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isAdmin: boolean; nav: MeNav } };
    return body.data;
  };

  const signIn = (email: string) =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });

  /** Run `fn` under the admin session, then restore the viewer session. */
  const asAdmin = async (fn: () => Promise<void>) => {
    await signIn(adminEmail);
    await fn();
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const si = await signIn(viewerEmail);
    expect(si.status).toBe(200);
  };

  const grant = async (collection: string) => {
    const r = await h.fetch(`/api/roles/${authRoleId}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection, action: "read", condition: null }),
    });
    expect(r.status).toBeLessThan(300);
  };

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
    expect(r.status).toBe(201);
    const roles = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRole = roles.find((x) => x.name === "authenticated");
    expect(authRole).toBeTruthy();
    authRoleId = authRole!.id;
    // Strip the (ordering-dependent) default owner-scoped file grants so the
    // baseline below is a true zero-grant role.
    const perms = ((await (
      await h.fetch(`/api/roles/${authRoleId}/permissions`)
    ).json()) as { data: { id: string; collection: string }[] }).data;
    for (const p of perms.filter((x) => x.collection === "system_files")) {
      const del = await h.fetch(`/api/permissions/${p.id}`, { method: "DELETE" });
      expect(del.status).toBeLessThan(300);
    }
  });
  afterAll(() => h.cleanup());

  test("admin: every nav grant is true", async () => {
    const me = await fetchNav();
    expect(me.isAdmin).toBe(true);
    expect(me.nav).toEqual({ collections: true, storage: true, revisions: true });
  });

  test("non-admin without grants: everything hidden", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: viewerEmail,
        password: "correct-horse-battery",
        name: "Nav Viewer",
      }),
    });
    expect(su.status).toBe(200);
    const me = await fetchNav();
    expect(me.isAdmin).toBe(false);
    expect(me.nav).toEqual({ collections: false, storage: false, revisions: false });
  });

  test("collection read grant lights up collections + revisions, not storage", async () => {
    await asAdmin(() => grant(slug));
    const me = await fetchNav();
    expect(me.nav).toEqual({ collections: true, storage: false, revisions: true });
  });

  test("system_files read grant lights up storage", async () => {
    await asAdmin(() => grant("system_files"));
    const me = await fetchNav();
    expect(me.nav).toEqual({ collections: true, storage: true, revisions: true });
  });

  test("wildcard read grant lights up everything", async () => {
    await asAdmin(() => grant("*"));
    const me = await fetchNav();
    expect(me.nav).toEqual({ collections: true, storage: true, revisions: true });
  });
});
