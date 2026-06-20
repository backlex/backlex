/**
 * Full-text + hybrid search. Exercises the keyword index end-to-end on SQLite
 * (FTS5 shadow table): the on-write hook, the `?q=` precision filter, the
 * `POST /:slug/search` ranked endpoint, the RRF mode-resolution guards, and
 * the `/:slug/fts-reindex` backfill. Reads the shadow table directly to prove
 * the DDL + content actually landed, not just the metadata.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = { "content-type": "application/json" };

interface SearchResp {
  data: Array<{ id: string; title?: string; body?: string }>;
  mode: string;
  limit: number;
}

const createItem = async (
  h: TestHarness,
  slug: string,
  data: Record<string, unknown>,
): Promise<string> => {
  const res = await h.fetch(`/api/items/${slug}`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(data),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
};

const search = async (
  h: TestHarness,
  slug: string,
  body: Record<string, unknown>,
): Promise<SearchResp> => {
  const res = await h.fetch(`/api/items/${slug}/search`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResp;
};

describe("full-text search", () => {
  let h: TestHarness;
  const slug = `fts_${Date.now()}`;
  let table = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        fts: true,
        fields: [
          { name: "title", type: "text", searchable: true },
          { name: "body", type: "longtext", searchable: true },
          { name: "note", type: "text" }, // not searchable
        ],
      }),
    });
    expect(res.status).toBe(201);
    table = ((await res.json()) as { data: { physicalTable: string } }).data.physicalTable;

    await createItem(h, slug, {
      title: "Postgres tuning guide",
      body: "indexes vacuum and query planning",
      note: "postgres",
    });
    await createItem(h, slug, {
      title: "SQLite internals",
      body: "btree wal and the page cache",
      note: "sqlite",
    });
    await createItem(h, slug, {
      title: "Cooking pasta",
      body: "scattered notes about boiling water",
      note: "food",
    });
    // Two redis docs: one mentions the term twice (denser → should rank first).
    await createItem(h, slug, { title: "Redis redis caching", body: "redis as a cache" });
    await createItem(h, slug, { title: "Background jobs", body: "a queue backed by redis" });
  });
  afterAll(() => h.cleanup());

  const ftsTableRows = (): Array<{ item_id: string; content: string }> => {
    const db = new Database(h.env.SQLITE_PATH!, { readonly: true });
    try {
      return db
        .query<{ item_id: string; content: string }, []>(
          `SELECT item_id, content FROM "${table}__fts"`,
        )
        .all();
    } finally {
      db.close();
    }
  };

  test("the FTS5 shadow table exists and the write hook populated it", () => {
    const db = new Database(h.env.SQLITE_PATH!, { readonly: true });
    const exists = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get(`${table}__fts`);
    db.close();
    expect(exists?.name).toBe(`${table}__fts`);

    const rows = ftsTableRows();
    expect(rows.length).toBe(5);
    // `note` is not searchable → its value must NOT be in the index content.
    const all = rows.map((r) => r.content).join("\n");
    expect(all).toContain("Postgres tuning guide");
    expect(all).not.toContain("food");
  });

  test("POST /search (fts) returns only the keyword match, mode defaults to fts", async () => {
    const r = await search(h, slug, { q: "postgres" });
    expect(r.mode).toBe("fts");
    expect(r.data.length).toBe(1);
    expect(r.data[0]!.title).toBe("Postgres tuning guide");
  });

  test("FTS is token-precise — 'cat' does NOT match 'scattered' (LIKE would)", async () => {
    const r = await search(h, slug, { q: "cat" });
    expect(r.data.length).toBe(0);
  });

  test("bm25 ranks the denser document first", async () => {
    const r = await search(h, slug, { q: "redis", limit: 5 });
    expect(r.data.length).toBe(2);
    expect(r.data[0]!.title).toBe("Redis redis caching");
  });

  test("?q= on an FTS collection narrows by keyword (not substring)", async () => {
    const hit = await h.fetch(`/api/items/${slug}?q=btree`);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { data: Array<{ title: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.title).toBe("SQLite internals");

    // 'scat' is a substring of 'scattered' but not a token → no FTS match.
    const miss = await h.fetch(`/api/items/${slug}?q=scat`);
    const missBody = (await miss.json()) as { data: unknown[] };
    expect(missBody.data.length).toBe(0);
  });

  test("requesting vector/hybrid mode 422s when vector isn't configured", async () => {
    for (const mode of ["vector", "hybrid"]) {
      const res = await h.fetch(`/api/items/${slug}/search`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ q: "redis", mode }),
      });
      expect(res.status).toBe(422);
    }
  });

  test("updating an item re-indexes it; deleting removes it from the index", async () => {
    const id = await createItem(h, slug, { title: "Ephemeral widget", body: "temp" });
    let r = await search(h, slug, { q: "widget" });
    expect(r.data.length).toBe(1);

    await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ title: "Renamed gadget" }),
    });
    r = await search(h, slug, { q: "widget" });
    expect(r.data.length).toBe(0);
    r = await search(h, slug, { q: "gadget" });
    expect(r.data.length).toBe(1);

    await h.fetch(`/api/items/${slug}/${id}`, { method: "DELETE" });
    r = await search(h, slug, { q: "gadget" });
    expect(r.data.length).toBe(0);
  });
});

describe("full-text search — enabling + backfill on an existing collection", () => {
  let h: TestHarness;
  const slug = `ftsbf_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Start WITHOUT fts.
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(res.status).toBe(201);
    await createItem(h, slug, { title: "Existing alpha doc" });
    await createItem(h, slug, { title: "Existing beta doc" });
  });
  afterAll(() => h.cleanup());

  test("legacy ?q= falls back to substring LIKE when FTS is off", async () => {
    // 'alph' is a substring, not a token — LIKE matches it, proving fallback.
    const res = await h.fetch(`/api/items/${slug}?q=alph`);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(1);
  });

  test("enabling fts + backfill indexes pre-existing rows", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({
        fts: true,
        fields: [{ name: "title", type: "text", searchable: true }],
      }),
    });
    expect(patch.status).toBe(200);

    // Before reindex the shadow table is empty → no hits.
    let r = await search(h, slug, { q: "alpha" });
    expect(r.data.length).toBe(0);

    const re = await h.fetch(`/api/collections/${slug}/fts-reindex`, { method: "POST" });
    expect(re.status).toBe(200);
    const reBody = (await re.json()) as { processed: number; total: number };
    expect(reBody.total).toBe(2);
    expect(reBody.processed).toBe(2);

    r = await search(h, slug, { q: "alpha" });
    expect(r.data.length).toBe(1);
    expect(r.data[0]!.title).toBe("Existing alpha doc");
  });

  test("fts-reindex 422s on a collection without fts enabled", async () => {
    const other = `ftsoff_${Date.now()}`;
    await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug: other, fields: [{ name: "title", type: "text" }] }),
    });
    const re = await h.fetch(`/api/collections/${other}/fts-reindex`, { method: "POST" });
    expect(re.status).toBe(422);
  });
});
