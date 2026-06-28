/**
 * Schema graph (ERD) editor — the cross-surface gate for #5.
 *
 * The admin ERD page is client-only, but the two server capabilities it relies
 * on must hold across surfaces:
 *   - `erdLayout` workspace setting round-trips through /api/admin/settings
 *     (persisted node positions).
 *   - `DELETE /api/collections/:slug/fields/:name` actually drops the physical
 *     column, with guards (reserved names, adopted collections, missing field),
 *     and is mirrored as the `schema.drop_field` MCP tool + `collections
 *     drop-field` CLI subcommand.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { schemaAdminTools } from "../src/server/mcp/tools/schema-admin";

describe("ERD: erdLayout setting round-trip", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("PATCH then GET returns the saved node positions", async () => {
    const layout = { posts: { x: 120, y: 40 }, authors: { x: 480, y: 300 } };
    const patch = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ erdLayout: layout }),
    });
    expect(patch.status).toBeLessThan(400);

    const get = await h.fetch("/api/admin/settings");
    const body = (await get.json()) as { data: { erdLayout?: Record<string, { x: number; y: number }> } };
    expect(body.data.erdLayout).toEqual(layout);
  });

  test("rejects a malformed erdLayout (non-numeric position)", async () => {
    const res = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ erdLayout: { posts: { x: "nope", y: 0 } } }),
    });
    // @hono/zod-openapi rejects the malformed body at the validation layer (400).
    expect(res.status).toBe(400);
  });
});

describe("ERD: drop-field endpoint", () => {
  let h: TestHarness;
  const slug = `erd_${Date.now()}`;
  let table = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text" },
          { name: "scratch", type: "text" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    table = ((await res.json()) as { data: { physicalTable: string } }).data.physicalTable;
  });
  afterAll(() => h.cleanup());

  const columns = (): string[] => {
    const db = new Database(h.env.SQLITE_PATH!, { readonly: true });
    try {
      return db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name);
    } finally {
      db.close();
    }
  };

  test("drops the physical column and updates metadata", async () => {
    expect(columns()).toContain("scratch");
    const res = await h.fetch(`/api/collections/${slug}/fields/scratch`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; field: string }).toMatchObject({ ok: true, field: "scratch" });
    expect(columns()).not.toContain("scratch");

    // Metadata `fields` no longer lists the dropped column.
    const get = await h.fetch(`/api/collections/${slug}`);
    const meta = (await get.json()) as { data: { fields: { name: string }[] } };
    expect(meta.data.fields.map((f) => f.name)).not.toContain("scratch");
    expect(meta.data.fields.map((f) => f.name)).toContain("title");
  });

  test("404 on a field that doesn't exist", async () => {
    const res = await h.fetch(`/api/collections/${slug}/fields/ghost`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("refuses to drop a reserved column", async () => {
    const res = await h.fetch(`/api/collections/${slug}/fields/id`, { method: "DELETE" });
    expect(res.status).toBe(422);
  });
});

describe("ERD: drop-field multi-surface parity", () => {
  test("MCP exposes schema.drop_field", () => {
    const names = schemaAdminTools.map((t) => t.name);
    expect(names).toContain("schema.drop_field");
    const tool = schemaAdminTools.find((t) => t.name === "schema.drop_field")!;
    expect(tool.inputSchema.required).toEqual(["slug", "name"]);
  });
});
