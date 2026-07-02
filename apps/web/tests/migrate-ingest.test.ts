/**
 * External-DB migration — ingest endpoint + pkType foundation.
 *
 * Contract under test (see services/migrate-ingest.ts + docs/migrating-in.md):
 *   • `POST /api/collections` accepts `pkType: uuid|text|integer` for managed
 *     creates; integer-keyed collections require the PK in item POST bodies.
 *   • `POST /api/admin/migrate/ingest/:slug` preserves source PKs and
 *     created_at/updated_at, is idempotent (ON CONFLICT DO NOTHING), fails
 *     rows structurally (unknown column / missing PK / required-null) without
 *     failing the batch, and rejects adopted collections.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = { "Content-Type": "application/json" };

describe("external-DB migration: pkType + ingest", () => {
  let h: TestHarness;
  const slug = `orders_${Date.now()}`;

  const ingest = (rows: unknown[], target = slug) =>
    h.fetch(`/api/admin/migrate/ingest/${target}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ rows }),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        pkType: "integer",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "amount", type: "number" },
          { name: "meta", type: "json" },
          { name: "active", type: "boolean" },
          { name: "ordered_at", type: "timestamp" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { pkType: string } };
    expect(body.data.pkType).toBe("integer");
  });
  afterAll(() => h.cleanup());

  test("integer-pk collection: item POST without id is a 422, with id lands", async () => {
    const missing = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "no id" }),
    });
    expect(missing.status).toBe(422);

    const withId = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ id: 999001, title: "manual" }),
    });
    expect(withId.status).toBe(201);
    const created = (await withId.json()) as { data: { id: string } };
    expect(String(created.data.id)).toBe("999001");
  });

  test("ingest preserves PKs, timestamps, and types round-trip", async () => {
    const res = await ingest([
      {
        id: 1,
        title: "first",
        amount: "12.5", // numeric string — postgres.js returns bigint/numeric as strings
        meta: { source: "legacy" },
        active: true,
        ordered_at: "2023-05-01T10:00:00.000Z",
        created_at: "2020-01-02T03:04:05.000Z",
        updated_at: "2021-02-03T04:05:06.000Z",
      },
      { id: 2, title: "second", active: false },
    ]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any };
    expect(data.received).toBe(2);
    expect(data.inserted).toBe(2);
    expect(data.failed).toEqual([]);

    const got = await h.fetch(`/api/items/${slug}/1`);
    expect(got.status).toBe(200);
    const row = ((await got.json()) as { data: any }).data;
    expect(String(row.id)).toBe("1");
    expect(row.title).toBe("first");
    expect(row.amount).toBe(12.5);
    expect(row.meta).toEqual({ source: "legacy" });
    expect(row.active).toBe(true);
    expect(new Date(row.orderedAt ?? row.ordered_at).toISOString()).toBe(
      "2023-05-01T10:00:00.000Z",
    );
    expect(new Date(row.createdAt).toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(new Date(row.updatedAt).toISOString()).toBe("2021-02-03T04:05:06.000Z");
  });

  test("re-ingesting the same rows is a no-op (resume safety)", async () => {
    const res = await ingest([
      { id: 1, title: "first CHANGED — must not overwrite" },
      { id: 2, title: "second" },
      { id: 3, title: "third (new)" },
    ]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any };
    expect(data.inserted).toBe(1); // only id 3
    expect(data.skipped).toBe(2);
    expect(data.failed).toEqual([]);

    // Existing row was NOT overwritten — restore is additive, ingest too.
    const got = await h.fetch(`/api/items/${slug}/1`);
    expect(((await got.json()) as { data: any }).data.title).toBe("first");
  });

  test("structural row failures don't sink the batch", async () => {
    const res = await ingest([
      { id: 10, title: "good" },
      { title: "no pk" },
      { id: 11, title: "typo", nonexistent_col: 1 },
      { id: 12, title: null }, // required NOT NULL
      { id: 13, title: "also good" },
    ]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any };
    expect(data.inserted).toBe(2);
    expect(data.failed.length).toBe(3);
    const errs = Object.fromEntries(
      data.failed.map((f: { index: number; error: string }) => [f.index, f.error]),
    );
    expect(errs[1]).toContain("Primary key");
    expect(errs[2]).toContain('Unknown column "nonexistent_col"');
    expect(errs[3]).toContain('Required field "title"');
  });

  test("many rows chunk under the parameter budget", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: 1000 + i,
      title: `bulk ${i}`,
      amount: i,
    }));
    const res = await ingest(rows);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any };
    expect(data.inserted).toBe(250);
    expect(data.failed).toEqual([]);

    const count = await h.fetch(`/api/items/${slug}?limit=1&meta=filter_count`);
    const meta = ((await count.json()) as { meta: { filter_count: number } }).meta;
    // 1 manual + 3 first-wave + 2 partial-batch + 250 bulk
    expect(meta.filter_count).toBe(256);
  });

  test("relation values survive because PKs are preserved", async () => {
    const child = `items_${Date.now()}`;
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug: child,
        pkType: "integer",
        fields: [
          { name: "label", type: "text" },
          { name: "order_id", type: "relation", to: slug },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const r = await ingest(
      [
        { id: 1, label: "line a", order_id: 1 },
        { id: 2, label: "line b", order_id: 2 },
      ],
      child,
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: any }).data.inserted).toBe(2);

    const expanded = await h.fetch(`/api/items/${child}/1?expand=order_id`);
    expect(expanded.status).toBe(200);
    const row = ((await expanded.json()) as { data: any }).data;
    expect(row.order_id?.title ?? row.order_id).toBeTruthy();
  });

  test("versioned collections default migrated rows to published", async () => {
    const vslug = `posts_${Date.now()}`;
    await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug: vslug,
        pkType: "integer",
        versioned: true,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    const r = await ingest(
      [
        { id: 1, title: "published by default" },
        { id: 2, title: "explicit draft", _status: "draft" },
      ],
      vslug,
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: any }).data.inserted).toBe(2);
    const list = await h.fetch(`/api/items/${vslug}?status=published`);
    const rows = ((await list.json()) as { data: any[] }).data;
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe("1");
  });

  test("adopted collections are rejected (their data already lives there)", async () => {
    const phys = `legacy_things_${Date.now()}`;
    const mk = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...json, "X-Backlex-Confirm": "yes" },
      body: JSON.stringify({
        sql: `CREATE TABLE ${phys} (id INTEGER PRIMARY KEY, name TEXT)`,
      }),
    });
    expect(mk.status).toBe(200);
    const adopt = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        adopted: true,
        physicalTable: phys,
        slug: `legacy_${Date.now()}`,
        pkColumn: "id",
        fields: [{ name: "name", type: "text" }],
      }),
    });
    expect(adopt.status).toBe(201);
    const adoptedSlug = ((await adopt.json()) as { data: { slug: string } }).data.slug;
    const r = await ingest([{ id: 1, name: "nope" }], adoptedSlug);
    expect(r.status).toBe(422);
  });

  test("upsert mode overwrites in place, preserving created_at", async () => {
    const first = await ingest([
      { id: 7000, title: "original", amount: 1, created_at: "2020-05-05T05:05:05.000Z" },
    ]);
    expect(((await first.json()) as { data: any }).data.inserted).toBe(1);

    const res = await h.fetch(`/api/admin/migrate/ingest/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        rows: [{ id: 7000, title: "overwritten", amount: 2 }],
        mode: "upsert",
      }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any };
    expect(data).toMatchObject({ inserted: 0, updated: 1, skipped: 0 });

    const got = await h.fetch(`/api/items/${slug}/7000`);
    const row = ((await got.json()) as { data: any }).data;
    expect(row.title).toBe("overwritten");
    expect(row.amount).toBe(2);
    // The delta pass must not re-stamp creation time.
    expect(new Date(row.createdAt).toISOString()).toBe("2020-05-05T05:05:05.000Z");
  });

  test("oversized batches are rejected with a clear error", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ id: i, title: "x" }));
    const res = await ingest(rows);
    expect(res.status).toBe(422);
  });

  test("ingest requires the admin gate", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch(`/api/admin/migrate/ingest/${slug}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ rows: [{ id: 1 }] }),
      });
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
