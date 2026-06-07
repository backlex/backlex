/**
 * Phase 6 — per-field B-tree indexes. A field flagged `indexed: true` should
 * get a `CREATE INDEX` on the physical table; `unique` fields are skipped (the
 * UNIQUE constraint already indexes them). Asserted by reading the SQLite
 * catalog directly so we verify the DDL actually ran, not just the metadata.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("collection field indexes", () => {
  let h: TestHarness;
  const slug = `idx_${Date.now()}`;
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
          { name: "email", type: "text", indexed: true },
          { name: "sku", type: "text", unique: true, indexed: true },
          { name: "plain", type: "text" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    table = ((await res.json()) as { data: { physicalTable: string } }).data.physicalTable;
  });
  afterAll(() => h.cleanup());

  const indexNames = (): string[] => {
    const db = new Database(h.env.SQLITE_PATH!, { readonly: true });
    try {
      return db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?",
        )
        .all(table)
        .map((r) => r.name);
    } finally {
      db.close();
    }
  };

  test("indexed field gets a named B-tree index", () => {
    expect(indexNames()).toContain(`${table}_email_idx`);
  });

  test("unique field is NOT given a redundant named index (UNIQUE already indexes it)", () => {
    expect(indexNames()).not.toContain(`${table}_sku_idx`);
  });

  test("plain (un-flagged) field gets no index", () => {
    expect(indexNames()).not.toContain(`${table}_plain_idx`);
  });

  test("re-applying (add an indexed field via update) creates the new index idempotently", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "email", type: "text", indexed: true },
          { name: "sku", type: "text", unique: true, indexed: true },
          { name: "plain", type: "text" },
          { name: "country", type: "text", indexed: true },
        ],
      }),
    });
    expect(patch.status).toBeLessThan(400);
    const names = indexNames();
    expect(names).toContain(`${table}_country_idx`);
    expect(names).toContain(`${table}_email_idx`); // still there, no error
  });
});
