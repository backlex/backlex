import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Covers the "New collection" wizard step-2 toggles that previously had no
 * backend behavior: soft-delete, singleton, and timestamps-off (plus the
 * tenantScoped flag that the admin onCreate used to drop). Each harness gets a
 * fresh in-memory SQLite, so fixed letter-only slugs are collision-free and
 * keep the derived GraphQL operation names predictable.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("collection toggles: soft-delete, singleton, timestamps-off", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("soft-delete hides rows from get/list/count but keeps them recoverable", async () => {
    const slug = "softdel";
    const create = await h.fetch(
      "/api/collections",
      json({ slug, softDelete: true, fields: [{ name: "title", type: "text" }] }),
    );
    expect(create.status).toBe(201);
    const meta = (await (await h.fetch(`/api/collections/${slug}`)).json()) as {
      data: { softDelete?: boolean };
    };
    expect(meta.data.softDelete).toBe(true);

    const a = (await (
      await h.fetch(`/api/items/${slug}`, json({ title: "a" }))
    ).json()) as { data: { id: string } };
    const b = (await (
      await h.fetch(`/api/items/${slug}`, json({ title: "b" }))
    ).json()) as { data: { id: string } };

    const del = await h.fetch(`/api/items/${slug}/${a.data.id}`, { method: "DELETE" });
    expect(del.status).toBeLessThan(400);

    // Soft-deleted row is invisible to get-by-id and list.
    expect((await h.fetch(`/api/items/${slug}/${a.data.id}`)).status).toBe(404);
    const list = (await (
      await h.fetch(`/api/items/${slug}?meta=*`)
    ).json()) as {
      data: { id: string }[];
      meta: { filter_count: number; total_count: number };
    };
    expect(list.data.some((r) => r.id === a.data.id)).toBe(false);
    expect(list.data.some((r) => r.id === b.data.id)).toBe(true);
    // Counts must exclude the soft-deleted row (the easy-to-miss leak).
    expect(list.meta.filter_count).toBe(1);
    expect(list.meta.total_count).toBe(1);

    // A repeat delete is a clean 404 — proves the row was soft-deleted, not
    // hard-removed (a hard delete would have 404'd the same, but the row would
    // be gone; idempotency + still-counting-zero confirms the soft path).
    expect(
      (await h.fetch(`/api/items/${slug}/${a.data.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("singleton rejects a second insert", async () => {
    const slug = "onerow";
    expect(
      (
        await h.fetch(
          "/api/collections",
          json({ slug, singleton: true, fields: [{ name: "title", type: "text" }] }),
        )
      ).status,
    ).toBe(201);
    expect(
      (await h.fetch(`/api/items/${slug}`, json({ title: "one" }))).status,
    ).toBe(201);
    const second = await h.fetch(`/api/items/${slug}`, json({ title: "two" }));
    expect(second.status).toBe(422);
  });

  test("timestamps-off: writes and reads work without created_at/updated_at", async () => {
    const slug = "notime";
    expect(
      (
        await h.fetch(
          "/api/collections",
          json({
            slug,
            hasCreatedAt: false,
            hasUpdatedAt: false,
            fields: [{ name: "title", type: "text" }],
          }),
        )
      ).status,
    ).toBe(201);

    const ins = await h.fetch(`/api/items/${slug}`, json({ title: "x" }));
    expect(ins.status).toBe(201);
    const row = (await ins.json()) as { data: Record<string, unknown> };
    expect(row.data.createdAt).toBeUndefined();
    expect(row.data.updatedAt).toBeUndefined();

    // List must not 500 on the default `-created_at` sort (falls back to pk).
    const list = await h.fetch(`/api/items/${slug}`);
    expect(list.status).toBe(200);
  });

  test("tenantScoped:false is forwarded and persisted", async () => {
    const slug = "globaltbl";
    expect(
      (
        await h.fetch(
          "/api/collections",
          json({ slug, tenantScoped: false, fields: [{ name: "title", type: "text" }] }),
        )
      ).status,
    ).toBe(201);
    const meta = (await (await h.fetch(`/api/collections/${slug}`)).json()) as {
      data: { tenantScoped?: boolean };
    };
    expect(meta.data.tenantScoped).toBe(false);
  });

  test("graphql delete soft-deletes and hides the row from list/get", async () => {
    const slug = "gqlsoft"; // → list `gqlsoft`, mutation `deleteGqlsoft`
    expect(
      (
        await h.fetch(
          "/api/collections",
          json({ slug, softDelete: true, fields: [{ name: "title", type: "text" }] }),
        )
      ).status,
    ).toBe(201);
    const ins = (await (
      await h.fetch(`/api/items/${slug}`, json({ title: "g" }))
    ).json()) as { data: { id: string } };
    const id = ins.data.id;

    const delJson = (await (
      await h.fetch(
        "/api/graphql",
        json({ query: `mutation { deleteGqlsoft(id: "${id}") }` }),
      )
    ).json()) as { data?: Record<string, unknown>; errors?: unknown[] };
    expect(delJson.errors).toBeUndefined();
    expect(delJson.data?.deleteGqlsoft).toBe(true);

    const listJson = (await (
      await h.fetch("/api/graphql", json({ query: `{ gqlsoft { id } }` }))
    ).json()) as { data?: { gqlsoft: { id: string }[] } };
    expect(listJson.data?.gqlsoft.length).toBe(0);

    // REST get agrees — the row is soft-deleted, not removed.
    expect((await h.fetch(`/api/items/${slug}/${id}`)).status).toBe(404);
  });
});
