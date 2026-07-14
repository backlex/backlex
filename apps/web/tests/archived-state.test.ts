/**
 * Archived `_status` on versioned collections (Phase B1):
 *   - `?archive=1` moves a published/draft row to `archived`, clearing timestamps;
 *   - archived rows are hidden from readers like a draft (published-only sees none);
 *   - a privileged caller narrows with `?status=archived`;
 *   - archive requires the `publish` action;
 *   - an archived row leaves archived via a normal publish/unpublish.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Archived state", () => {
  let h: TestHarness;
  const slug = `archivable_${Date.now()}`;
  let adminEmail: string;
  let a: string; // published → archived
  let b: string; // stays published (control)

  const list = async (status?: string) => {
    const qs = status ? `?status=${status}` : "";
    const res = await h.fetch(`/api/items/${slug}${qs}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id).sort();
  };
  const signInAdmin = () =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: "correct-horse-battery" }),
    });

  beforeAll(async () => {
    h = makeHarness();
    adminEmail = (await seedAdmin(h)).email;

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

    const rolesRes = await h.fetch("/api/roles");
    const roles = ((await rolesRes.json()) as { data: { id: string; name: string }[] }).data;
    const authRole = roles.find((r) => r.name === "authenticated")!;
    await h.fetch(`/api/roles/${authRole.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, action: "read", condition: null }),
    });

    const mk = async (title: string) => {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title }),
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { data: { id: string } }).data.id;
    };
    a = await mk("to archive");
    b = await mk("stays live");
    for (const id of [a, b]) {
      expect((await h.fetch(`/api/items/${slug}/${id}/publish`, { method: "POST" })).status).toBe(200);
    }
  });
  afterAll(() => h.cleanup());

  test("archive moves a published row to archived and sets _status", async () => {
    const res = await h.fetch(`/api/items/${slug}/${a}/publish?archive=1`, { method: "POST" });
    expect(res.status).toBe(200);
    const row = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(row._status).toBe("archived");
    expect(row._published_at ?? null).toBeNull();
    expect(row._publish_at ?? null).toBeNull();
  });

  test("admin narrows with ?status; archived leaves the published list", async () => {
    expect(await list("archived")).toEqual([a]);
    expect(await list("published")).toEqual([b]);
    expect(await list()).toEqual([a, b].sort()); // default = all for a privileged caller
  });

  test("a read-only caller never sees the archived row", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: `viewer-${Date.now()}@example.test`, password: "correct-horse-battery", name: "V" }),
    });
    expect(await list()).toEqual([b]); // published only
    expect(await list("archived")).toEqual([b]); // ignored → published only
    const byId = await h.fetch(`/api/items/${slug}/${a}`);
    expect(byId.status).toBe(404);
  });

  test("archive requires the publish action — read-only caller is 403", async () => {
    const res = await h.fetch(`/api/items/${slug}/${b}/publish?archive=1`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("an archived row leaves archived via a normal publish", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await signInAdmin();
    const res = await h.fetch(`/api/items/${slug}/${a}/publish`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { _status: string } }).data._status).toBe("published");
    expect(await list("archived")).toEqual([]);
    expect(await list("published")).toEqual([a, b].sort());
  });
});
