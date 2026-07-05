/**
 * Backup / restore, scheduled auto-backups + retention, and per-collection
 * CSV/JSON export-import. Exercises everything on SQLite end-to-end through the
 * HTTP surface, plus the scheduler sweep + CSV helpers directly.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { maybeRunScheduledBackups } from "../src/server/services/backup";
import { toCsv, parseCsv } from "../src/server/services/items/csv";

const json = { "content-type": "application/json" };

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

const listCount = async (h: TestHarness, slug: string): Promise<number> => {
  const res = await h.fetch(`/api/items/${slug}?limit=200`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: unknown[] }).data.length;
};

const makeCollection = async (h: TestHarness, slug: string): Promise<void> => {
  const res = await h.fetch("/api/collections", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      slug,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "qty", type: "integer" },
        { name: "active", type: "boolean" },
      ],
    }),
  });
  expect(res.status).toBe(201);
};

describe("backup → restore round-trip", () => {
  let h: TestHarness;
  const slug = `bk_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await makeCollection(h, slug);
  });
  afterAll(() => h.cleanup());

  test("backs up, then re-inserts hard-deleted rows additively", async () => {
    const ids = [
      await createItem(h, slug, { title: "Alpha", qty: 1, active: true }),
      await createItem(h, slug, { title: "Beta", qty: 2, active: false }),
      await createItem(h, slug, { title: "Gamma", qty: 3, active: true }),
    ];
    expect(await listCount(h, slug)).toBe(3);

    // Run a manual backup and wait for the inline dump to finish.
    const backupRes = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: "test" }),
    });
    expect(backupRes.status).toBe(201);
    const backup = ((await backupRes.json()) as { data: { id: string; status: string } }).data;
    expect(backup.status).toBe("done");

    // Hard-delete two of the three rows (collection isn't soft-delete).
    for (const id of ids.slice(0, 2)) {
      const del = await h.fetch(`/api/items/${slug}/${id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
    }
    expect(await listCount(h, slug)).toBe(1);

    // Restore — missing rows come back, the surviving row is left as-is.
    const restoreRes = await h.fetch(`/api/admin/db/backups/${backup.id}/restore`, {
      method: "POST",
      headers: { ...json, "x-backlex-confirm": "yes" },
    });
    expect(restoreRes.status).toBe(200);
    const restore = ((await restoreRes.json()) as {
      data: { tableCount: number; rowCount: number; skipped: number };
    }).data;
    expect(restore.rowCount).toBeGreaterThan(0);

    expect(await listCount(h, slug)).toBe(3);
  });

  test("restore without the confirm header is rejected", async () => {
    const list = await h.fetch("/api/admin/db/backups");
    const first = ((await list.json()) as { data: { id: string }[] }).data[0];
    expect(first).toBeTruthy();
    const res = await h.fetch(`/api/admin/db/backups/${first!.id}/restore`, {
      method: "POST",
      headers: json,
    });
    expect(res.status).toBe(403);
  });
});

describe("scheduled backups + retention", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("config defaults to off and round-trips through the API", async () => {
    const initial = await h.fetch("/api/admin/db/backups/config");
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as { data: { schedule: string } }).data.schedule).toBe("off");

    const put = await h.fetch("/api/admin/db/backups/config", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ schedule: "daily", retain: 1 }),
    });
    expect(put.status).toBe(200);
    const saved = ((await put.json()) as { data: { schedule: string; retain: number } }).data;
    expect(saved).toEqual({ schedule: "daily", retain: 1, retainDays: null });
  });

  test("sweep runs when due, skips when not, and prunes to the retention count", async () => {
    const ctx = await buildContext(h.env);

    const t0 = new Date();
    const first = await maybeRunScheduledBackups(ctx, t0);
    expect(first.ran).toBe(1);

    // Immediately again — the daily window hasn't elapsed, so nothing runs.
    const again = await maybeRunScheduledBackups(ctx, t0);
    expect(again.ran).toBe(0);

    // A day later it's due again; retain=1 means the older auto is pruned.
    const later = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
    const second = await maybeRunScheduledBackups(ctx, later);
    expect(second.ran).toBe(1);
    expect(second.pruned).toBe(1);

    const list = await h.fetch("/api/admin/db/backups");
    const autos = ((await list.json()) as { data: { kind: string }[] }).data.filter(
      (b) => b.kind === "auto",
    );
    expect(autos.length).toBe(1);
  });

  test("age rule prunes autos older than retainDays even under the count cap", async () => {
    const ctx = await buildContext(h.env);
    // Plenty of count headroom, but a 2-day age ceiling.
    const put = await h.fetch("/api/admin/db/backups/config", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ schedule: "daily", retain: 100, retainDays: 2 }),
    });
    expect(put.status).toBe(200);

    const base = new Date();
    // Continues from the previous test's timeline (one auto exists at ~+25h);
    // running the sweep 5 days out takes a fresh auto AND ages out every
    // older one, despite retain=100 never biting.
    const far = new Date(base.getTime() + 5 * 24 * 60 * 60 * 1000);
    const sweep = await maybeRunScheduledBackups(ctx, far);
    expect(sweep.ran).toBe(1);
    expect(sweep.pruned).toBeGreaterThanOrEqual(1);

    const list = await h.fetch("/api/admin/db/backups");
    const autos = ((await list.json()) as { data: { kind: string }[] }).data.filter(
      (b) => b.kind === "auto",
    );
    // Only the just-taken auto survives the age rule.
    expect(autos.length).toBe(1);
  });
});

describe("per-collection export / import", () => {
  let h: TestHarness;
  const src = `exp_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await makeCollection(h, src);
    await createItem(h, src, { title: "One, with comma", qty: 10, active: true });
    await createItem(h, src, { title: 'Two "quoted"', qty: 20, active: false });
    await createItem(h, src, { title: "Three", qty: 30, active: true });
  });
  afterAll(() => h.cleanup());

  test("JSON export round-trips into a fresh collection", async () => {
    const exp = await h.fetch(`/api/items/${src}/export?format=json`);
    expect(exp.status).toBe(200);
    const rows = (await exp.json()) as Record<string, unknown>[];
    expect(rows.length).toBe(3);

    const dst = `${src}_j`;
    await makeCollection(h, dst);
    const imp = await h.fetch(`/api/items/${dst}/import?format=json`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(rows),
    });
    expect(imp.status).toBe(200);
    const summary = ((await imp.json()) as { data: { inserted: number; failed: number } }).data;
    expect(summary.inserted).toBe(3);
    expect(summary.failed).toBe(0);
    expect(await listCount(h, dst)).toBe(3);
  });

  test("CSV export quotes correctly and re-imports", async () => {
    const exp = await h.fetch(`/api/items/${src}/export?format=csv`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/csv");
    const csv = await exp.text();
    const header = csv.split("\n")[0] ?? "";
    expect(header).toContain("title");
    expect(header).toContain("qty");
    // Quoted fields survive a parse round-trip.
    const parsed = parseCsv(csv);
    expect(parsed.length).toBe(3);
    expect(parsed.some((r) => r.title === "One, with comma")).toBe(true);
    expect(parsed.some((r) => r.title === 'Two "quoted"')).toBe(true);

    const dst = `${src}_c`;
    await makeCollection(h, dst);
    const imp = await h.fetch(`/api/items/${dst}/import?format=csv`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csv,
    });
    expect(imp.status).toBe(200);
    const summary = ((await imp.json()) as { data: { inserted: number } }).data;
    expect(summary.inserted).toBe(3);
  });

  test("import reports per-row failures without aborting the batch", async () => {
    const dst = `${src}_e`;
    await makeCollection(h, dst);
    const imp = await h.fetch(`/api/items/${dst}/import?format=json`, {
      method: "POST",
      headers: json,
      body: JSON.stringify([
        { title: "Good" },
        { title: "Bad", nonexistent_field: "x" },
        { qty: 5 }, // missing required `title`
      ]),
    });
    expect(imp.status).toBe(200);
    const summary = ((await imp.json()) as {
      data: { inserted: number; failed: number; errors: { row: number }[] };
    }).data;
    expect(summary.inserted).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.errors.length).toBe(2);
  });

  // Regression: a user exported a collection and re-imported the file into the
  // SAME collection. Previously every row re-inserted and collided on unique
  // columns (or duplicated rows). Rows carrying an existing id must UPDATE.
  test("re-importing an export upserts by id (round-trips into the same collection)", async () => {
    const exp = await h.fetch(`/api/items/${src}/export?format=json`);
    const rows = (await exp.json()) as Record<string, unknown>[];
    expect(rows.length).toBe(3);
    expect(typeof rows[0]?.id).toBe("string");

    const imp = await h.fetch(`/api/items/${src}/import?format=json`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(rows),
    });
    expect(imp.status).toBe(200);
    const summary = ((await imp.json()) as {
      data: { inserted: number; updated: number; failed: number };
    }).data;
    expect(summary.updated).toBe(3);
    expect(summary.inserted).toBe(0);
    expect(summary.failed).toBe(0);
    expect(await listCount(h, src)).toBe(3); // no duplicates created
  });

  // Regression: creating a row whose unique column collides used to surface a
  // raw 500. It must map to a clean 409 CONFLICT (drives the Duplicate action
  // and any save with a duplicate unique value).
  test("duplicate unique value returns 409 CONFLICT, not 500", async () => {
    const u = `uniq_${Date.now()}`;
    const mk = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug: u,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "sku", type: "text", unique: true },
        ],
      }),
    });
    expect(mk.status).toBe(201);

    const first = await h.fetch(`/api/items/${u}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "A", sku: "X1" }),
    });
    expect(first.status).toBe(201);

    const dup = await h.fetch(`/api/items/${u}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "B", sku: "X1" }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
  });
});

describe("csv helpers", () => {
  test("toCsv quotes delimiters, quotes and newlines; parseCsv inverts it", () => {
    const rows = [
      { a: "plain", b: "has,comma", c: 'has"quote' },
      { a: "line\nbreak", b: "", c: "ok" },
    ];
    const csv = toCsv(rows, ["a", "b", "c"]);
    const parsed = parseCsv(csv);
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toEqual({ a: "plain", b: "has,comma", c: 'has"quote' });
    expect(parsed[1]).toEqual({ a: "line\nbreak", b: "", c: "ok" });
  });

  test("parseCsv tolerates CRLF and a trailing newline", () => {
    const parsed = parseCsv("x,y\r\n1,2\r\n3,4\r\n");
    expect(parsed).toEqual([
      { x: "1", y: "2" },
      { x: "3", y: "4" },
    ]);
  });

  test("parseCsv on empty input is []", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
