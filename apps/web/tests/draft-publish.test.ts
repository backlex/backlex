/**
 * Draft/publish + scheduled publishing on versioned collections:
 *   - drafts are hidden from a read-only caller (no publish/update), visible to
 *     admin / privileged callers;
 *   - the publish endpoint requires the `publish` action;
 *   - `publishAt` schedules a publish the cron tick applies when due.
 *
 * The unprivileged reader is a second `authenticated` user granted ONLY `read`
 * on a non-owner-scoped collection (so no owner-scoped `update` is seeded).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { publishDueItems } from "../src/server/services/items/scheduled-publish";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Draft / publish + scheduled publishing", () => {
  let h: TestHarness;
  const slug = `articles_${Date.now()}`;
  let adminEmail: string;
  let draftId: string;
  let pubId: string;

  const list = async (status?: string) => {
    const qs = status ? `?status=${status}` : "";
    const res = await h.fetch(`/api/items/${slug}${qs}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: string }[] }).data;
  };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;

    // Versioned, NON-owner-scoped → `authenticated` gets no default perms.
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        versioned: true,
        tenantScoped: true,
        ownerScoped: false,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);

    // Grant the `authenticated` role unconditional read on this collection.
    const rolesRes = await h.fetch("/api/roles");
    const roles = ((await rolesRes.json()) as { data: { id: string; name: string }[] }).data;
    const authRole = roles.find((r) => r.name === "authenticated");
    expect(authRole).toBeTruthy();
    const grant = await h.fetch(`/api/roles/${authRole!.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, action: "read", condition: null }),
    });
    expect(grant.status).toBeLessThan(300);

    // Two items: one stays draft, one gets published.
    const mk = async (title: string) => {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title }),
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { data: { id: string } }).data.id;
    };
    draftId = await mk("draft one");
    pubId = await mk("published one");
    const pub = await h.fetch(`/api/items/${slug}/${pubId}/publish`, { method: "POST" });
    expect(pub.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("admin (bypass) sees every status; ?status=draft narrows", async () => {
    expect(ids(await list())).toEqual([draftId, pubId].sort());
    expect(ids(await list("draft"))).toEqual([draftId]);
    expect(ids(await list("published"))).toEqual([pubId]);
  });

  test("a read-only caller sees only published items", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: `viewer-${Date.now()}@example.test`, password: "correct-horse-battery", name: "Viewer" }),
    });

    expect(ids(await list())).toEqual([pubId]);
    // ?status=draft is ignored for an unprivileged caller (published-only enforced).
    expect(ids(await list("draft"))).toEqual([pubId]);
    // a draft fetched by id 404s.
    const byId = await h.fetch(`/api/items/${slug}/${draftId}`);
    expect(byId.status).toBe(404);
  });

  test("publish requires the `publish` action — read-only caller is 403", async () => {
    const res = await h.fetch(`/api/items/${slug}/${draftId}/publish`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("after admin publishes the draft, the read-only caller sees it", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: "correct-horse-battery" }),
    });
    const pub = await h.fetch(`/api/items/${slug}/${draftId}/publish`, { method: "POST" });
    expect(pub.status).toBe(200);

    // sign up a fresh viewer (read-only via the authenticated-role grant)
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: `viewer3-${Date.now()}@example.test`, password: "correct-horse-battery", name: "Viewer3" }),
    });
    expect(ids(await list())).toEqual([draftId, pubId].sort());
  });

  test("scheduled publish: a future publishAt stays hidden, then the tick publishes it", async () => {
    // back to admin
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: "correct-horse-battery" }),
    });
    // a fresh draft, scheduled ~250ms out
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "scheduled one" }),
    });
    const schedId = ((await r.json()) as { data: { id: string } }).data.id;
    const at = new Date(Date.now() + 250).toISOString();
    const sched = await h.fetch(`/api/items/${slug}/${schedId}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ publishAt: at }),
    });
    expect(sched.status).toBe(200);
    // still a draft now → admin sees it under draft, published list excludes it.
    expect(ids(await list("published")).includes(schedId)).toBe(false);

    // wait until due, then run the tick.
    await new Promise((res) => setTimeout(res, 450));
    const ctx = await buildContext(h.env);
    await publishDueItems(ctx);

    expect(ids(await list("published")).includes(schedId)).toBe(true);
  });
});
