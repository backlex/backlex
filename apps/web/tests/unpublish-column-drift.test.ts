/**
 * Regression: publish / unpublish / schedule must not 500 on a versioned table
 * that predates scheduled publishing and is missing `_publish_at`.
 *
 * `_publish_at` was added with the scheduled-publish feature. Tables made
 * versioned before it — and never re-applied since — lack the column, but the
 * publish path writes it unconditionally, so the request 500'd with
 * "no such column: _publish_at". The write path now self-heals the versioned
 * system columns before touching the row (`ensureVersionedColumns`).
 *
 * We reproduce the drift by dropping `_publish_at` (+ its index) off a freshly
 * versioned table, then assert the publish endpoints succeed and re-add it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { introspectColumns } from "@backlex/db";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { execute } from "../src/server/services/items/sql-helpers";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Publish path heals `_publish_at` column drift", () => {
  let h: TestHarness;
  const slug = `drifted_${Date.now()}`;
  let table: string;
  let itemId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

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
    table = ((await create.json()) as { data: { physicalTable: string } }).data.physicalTable;

    const mk = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "row" }),
    });
    expect(mk.status).toBe(201);
    itemId = ((await mk.json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => h.cleanup());

  test("unpublish/publish succeed after `_publish_at` is dropped", async () => {
    const ctx = await buildContext(h.env);

    // Simulate an old versioned table: drop `_publish_at` and its index so the
    // column genuinely doesn't exist (SQLite refuses to drop an indexed column).
    await execute(ctx, sql.raw(`DROP INDEX IF EXISTS "${table}_publish_at_idx"`));
    await execute(ctx, sql.raw(`ALTER TABLE "${table}" DROP COLUMN "_publish_at"`));
    expect((await introspectColumns(ctx.db, ctx.dialect, table)).has("_publish_at")).toBe(false);

    // Publish would 500 pre-fix ("no such column: _publish_at"); now it heals.
    const pub = await h.fetch(`/api/items/${slug}/${itemId}/publish`, { method: "POST" });
    expect(pub.status).toBe(200);
    expect((await introspectColumns(ctx.db, ctx.dialect, table)).has("_publish_at")).toBe(true);

    // And unpublish round-trips the status back to draft.
    const unpub = await h.fetch(`/api/items/${slug}/${itemId}/publish?unpublish=1`, { method: "POST" });
    expect(unpub.status).toBe(200);
    const row = (await h.fetch(`/api/items/${slug}/${itemId}`).then((r) => r.json())) as {
      data: { _status: string };
    };
    expect(row.data._status).toBe("draft");
  });
});
