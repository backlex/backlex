/**
 * REST coverage for `/api/folders` (routes/folders.ts) — list / create /
 * update / delete, all gated by permissions on the `system_files` collection
 * and scoped to the active workspace, plus the anonymous 401 path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string | null;
  tenantId: string | null;
}

describe("folders REST", () => {
  let h: TestHarness;
  let parentId = "";
  let childId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("anonymous request is rejected with 401", async () => {
    // Raw app.fetch — no cookie jar, so no session.
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/folders`, {
        headers: { Origin: h.env.APP_URL },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("GET / starts empty", async () => {
    const res = await h.fetch("/api/folders");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: FolderRow[] };
    expect(body.data).toEqual([]);
  });

  test("POST / creates a root folder stamped with owner + tenant", async () => {
    const res = await h.fetch("/api/folders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Invoices" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: FolderRow };
    expect(body.data.name).toBe("Invoices");
    expect(body.data.parentId).toBeNull();
    expect(typeof body.data.id).toBe("string");
    expect(body.data.id.length).toBeGreaterThan(0);
    // Owner + tenant are auto-stamped from the session.
    expect(typeof body.data.ownerId).toBe("string");
    expect(typeof body.data.tenantId).toBe("string");
    parentId = body.data.id;
  });

  test("POST / creates a child folder under the parent", async () => {
    const res = await h.fetch("/api/folders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "2026", parentId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: FolderRow };
    expect(body.data.parentId).toBe(parentId);
    childId = body.data.id;
  });

  test("GET / lists both folders", async () => {
    const res = await h.fetch("/api/folders");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: FolderRow[] };
    expect(body.data.length).toBe(2);
    const byId = new Map(body.data.map((f) => [f.id, f]));
    expect(byId.get(parentId)?.name).toBe("Invoices");
    expect(byId.get(childId)?.name).toBe("2026");
    expect(byId.get(childId)?.parentId).toBe(parentId);
  });

  test("POST / rejects an empty name with 400", async () => {
    // OpenAPIHono's built-in zod validator answers 400 (not the AppError
    // handler's 422) for schema failures.
    const res = await h.fetch("/api/folders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("PATCH /{id} renames and re-parents", async () => {
    const res = await h.fetch(`/api/folders/${childId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Archive 2026", parentId: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const list = await h.fetch("/api/folders");
    const rows = ((await list.json()) as { data: FolderRow[] }).data;
    const child = rows.find((f) => f.id === childId);
    expect(child?.name).toBe("Archive 2026");
    expect(child?.parentId).toBeNull();
  });

  test("PATCH on an unknown id 404s", async () => {
    const res = await h.fetch(`/api/folders/${crypto.randomUUID()}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("DELETE /{id} removes the folder", async () => {
    const res = await h.fetch(`/api/folders/${childId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const list = await h.fetch("/api/folders");
    const rows = ((await list.json()) as { data: FolderRow[] }).data;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(parentId);
  });

  test("DELETE on an already-deleted id 404s", async () => {
    const res = await h.fetch(`/api/folders/${childId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
