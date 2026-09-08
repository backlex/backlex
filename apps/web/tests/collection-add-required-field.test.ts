/**
 * Adding a field to a collection that already exists.
 *
 * `columnDefSql` is written for `CREATE TABLE`, and `schema-applier` reuses it
 * for the additive `ALTER TABLE … ADD COLUMN` path. One shape has no meaning
 * there: a `NOT NULL` column with no `DEFAULT`, on a table that already holds
 * rows — the engine has nothing to put in them and fails the statement.
 *
 * That arrived as an opaque `500 INTERNAL` on an ordinary
 * `PATCH /api/collections/:slug`, and as a per-collection `failed` entry in
 * `POST /api/admin/db/schema/reapply` whose raw driver text reads like
 * something a retry might fix. It is not — it fails identically every time,
 * which is how a live tenant's sweep stalled on it (#317, #360).
 *
 * WHAT THIS FILE IS MOSTLY FOR IS THE THREE CASES THAT MUST KEEP WORKING.
 * The fix refuses one shape; a fix that refused any of the neighbours would be
 * worse than the bug, and all four were MEASURED before it was written rather
 * than reasoned about:
 *
 *   required + no default + rows      → refused (was 500)
 *   required + no default + NO rows   → allowed
 *   required + a default + rows       → allowed
 *   optional + no default + rows      → allowed
 *
 * The second one is why the guard asks about rows at all. The first version of
 * this analysis claimed SQLite refuses `NOT NULL` without a default
 * unconditionally; the empty-table case disproves it, and a guard written from
 * that claim would have broken a working path.
 */
import { describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Create a collection, optionally put a row in it, then try to add `field`. */
const addField = async (
  field: Record<string, unknown>,
  opts: { withRow: boolean },
): Promise<{ status: number; body: string; h: TestHarness; slug: string }> => {
  const h = makeHarness();
  await seedAdmin(h);
  const slug = `add${Math.random().toString(36).slice(2, 10)}`;
  const made = await h.fetch(
    "/api/collections",
    json({ slug, fields: [{ name: "title", type: "text" }] }),
  );
  expect(made.status, await made.clone().text()).toBe(201);
  if (opts.withRow) {
    const row = await h.fetch(`/api/items/${slug}`, json({ title: "existing" }));
    expect(row.status, "the fixture row must land, or 'has rows' means nothing").toBe(201);
  }
  const res = await h.fetch(`/api/collections/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: [{ name: "title", type: "text" }, field] }),
  });
  return { status: res.status, body: await res.text(), h, slug };
};

describe("adding a field to an existing collection", () => {
  test("required with no default, on a table WITH rows, is refused with a sentence", async () => {
    const r = await addField({ name: "issue_date", type: "timestamp", required: true }, {
      withRow: true,
    });
    try {
      // 409, not 500. The status is half the point: an opaque INTERNAL tells a
      // caller nothing and reads like a bug in the server rather than in the
      // request.
      expect(r.status, r.body).toBe(409);
      // And the message has to say what to DO. Asserting the shape rather than
      // the exact wording, so the sentence can be improved without a test edit.
      expect(r.body).toContain("issue_date");
      expect(r.body).toContain("default");
    } finally {
      r.h.cleanup();
    }
  });

  test("required with no default, on an EMPTY table, is allowed", async () => {
    // The case that makes the row check load-bearing. There is nothing to fill,
    // so the column is addable and refusing it would break a real workflow —
    // defining a schema before any data arrives is the ordinary way round.
    const r = await addField({ name: "issue_date", type: "timestamp", required: true }, {
      withRow: false,
    });
    try {
      expect(r.status, r.body).toBe(200);
    } finally {
      r.h.cleanup();
    }
  });

  test("required WITH a default, on a table with rows, is allowed", async () => {
    // The escape hatch the refusal points at, so it has to work. The default
    // answers the question the engine was asking.
    const r = await addField(
      { name: "status_note", type: "text", required: true, default: "unset" },
      { withRow: true },
    );
    try {
      expect(r.status, r.body).toBe(200);
      // And the existing row really carries it — a 200 that left the old row
      // NULL under a NOT NULL column would be the worse outcome.
      const list = await r.h.fetch(`/api/items/${r.slug}?limit=10`);
      const rows = ((await list.json()) as { data: Record<string, unknown>[] }).data;
      expect(rows.map((x) => x.status_note)).toEqual(["unset"]);
    } finally {
      r.h.cleanup();
    }
  });

  test("optional with no default, on a table with rows, is allowed", async () => {
    // The overwhelmingly common edit. If this ever fails the guard has grown
    // past the one shape it was written for.
    const r = await addField({ name: "note", type: "text" }, { withRow: true });
    try {
      expect(r.status, r.body).toBe(200);
    } finally {
      r.h.cleanup();
    }
  });
});
