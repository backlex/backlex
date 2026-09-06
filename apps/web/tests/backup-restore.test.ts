/**
 * Backup / restore, scheduled auto-backups + retention, and per-collection
 * CSV/JSON export-import. Exercises everything on SQLite end-to-end through the
 * HTTP surface, plus the scheduler sweep + CSV helpers directly.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const sqlRaw = (q: string) => drizzleSql.raw(q);
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
    const saved = ((await put.json()) as { data: { schedule: string; retain: number; retainDays: number | null } }).data;
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

/**
 * Overwrite-mode restore.
 *
 * The pre-existing round-trip above DELETES rows and asserts they come back —
 * which passes under either mode, so it cannot tell the two apart. These tests
 * exercise the case `ON CONFLICT DO NOTHING` deliberately SKIPS: a row that
 * still exists but has been changed since the backup. That is the whole reason
 * overwrite exists (undo a bad write, recover a dropped column's data), and it
 * is the only shape that fails if the mode is ignored.
 */
describe("restore: overwrite mode", () => {
  let h: TestHarness;
  const slug = `bkov_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await makeCollection(h, slug);
  });
  afterAll(() => h.cleanup());

  const readTitle = async (id: string): Promise<string> => {
    const res = await h.fetch(`/api/items/${slug}/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { title: string } }).data.title;
  };

  const restore = async (
    id: string,
    query = "",
  ): Promise<{
    tableCount: number;
    rowCount: number;
    skipped: number;
    overwritten: number;
    keptAdditive: string[];
    unfoldedRows: number;
  }> => {
    const res = await h.fetch(`/api/admin/db/backups/${id}/restore${query}`, {
      method: "POST",
      headers: { ...json, "x-backlex-confirm": "yes" },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Awaited<ReturnType<typeof restore>> }).data;
  };

  test("additive leaves a changed row alone; overwrite restates it", async () => {
    const id = await createItem(h, slug, { title: "Alpha", qty: 1, active: true });

    const backupRes = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: "overwrite-test" }),
    });
    expect(backupRes.status).toBe(201);
    const backup = ((await backupRes.json()) as { data: { id: string; status: string } }).data;
    expect(backup.status).toBe("done");

    // The row still EXISTS — it has just been changed. This is what `DO NOTHING`
    // skips and `DO UPDATE` restates.
    const patch = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ title: "Corrupted" }),
    });
    expect(patch.status).toBe(200);
    expect(await readTitle(id)).toBe("Corrupted");

    // Additive: the row is counted (so we know the path ran and reached it —
    // without this the next assertion would also pass if the restore silently
    // did nothing at all), and deliberately left as it is.
    const additive = await restore(backup.id);
    expect(additive.rowCount).toBeGreaterThan(0);
    expect(additive.overwritten).toBe(0);
    // The post-restore fold pass finished. It is capped at 100,000 rows per
    // column and returns what it could not reach — a number that used to be
    // dropped inside an empty `catch`, so a restore too big to finish folding
    // reported plain success while `_icontains` stopped matching the remainder.
    // Asserting 0 here (rather than just "the key exists") is what makes a
    // build that hard-codes the field fail: see
    // `security-audit-2026-09-fold-backlog.test.ts` for the capped case.
    expect(additive.unfoldedRows).toBe(0);
    expect(await readTitle(id)).toBe("Corrupted");

    // Overwrite: the backup-era value comes back.
    const overwrite = await restore(backup.id, "?mode=overwrite");
    expect(overwrite.overwritten).toBeGreaterThan(0);
    expect(await readTitle(id)).toBe("Alpha");
  });

  test("tables with no single-column id stay additive and are reported", async () => {
    const list = await h.fetch("/api/admin/db/backups");
    const first = ((await list.json()) as { data: { id: string }[] }).data[0];
    expect(first).toBeTruthy();

    const r = await restore(first!.id, "?mode=overwrite");
    // `user_roles` is keyed (user_id, role_id) and carries no `id` column, so
    // `ON CONFLICT (id) DO UPDATE` has no target to name. Asserting the specific
    // table — not merely "non-empty" — is what makes this fail loudly if the
    // eligibility check is ever widened to cover it by mistake.
    expect(r.keptAdditive).toContain("user_roles");
  });

  test("onlyTables narrows the restore to the named tables", async () => {
    const id = await createItem(h, slug, { title: "Solo", qty: 9, active: true });
    const backupRes = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: "narrow" }),
    });
    const backup = ((await backupRes.json()) as { data: { id: string } }).data;

    const patch = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ title: "Changed" }),
    });
    expect(patch.status).toBe(200);

    // Naming only `roles` must leave this collection's table untouched even in
    // overwrite mode — otherwise a targeted recovery would drag every other
    // table back to backup time, which is the reason onlyTables exists.
    const narrowed = await restore(backup.id, "?mode=overwrite&onlyTables=roles");
    expect(narrowed.keptAdditive).not.toContain("user_roles");
    expect(await readTitle(id)).toBe("Changed");

    // Same backup, unrestricted: now it is restated. The pair proves the
    // narrowing did the skipping, not that the restore was a no-op.
    await restore(backup.id, "?mode=overwrite");
    expect(await readTitle(id)).toBe("Solo");
  });

  test("a restore writes an audit row naming the mode", async () => {
    const list = await h.fetch("/api/admin/db/backups");
    const first = ((await list.json()) as { data: { id: string }[] }).data[0];
    await restore(first!.id, "?mode=overwrite");

    const act = await h.fetch("/api/activity?limit=50");
    expect(act.status).toBe(200);
    const rows = ((await act.json()) as {
      data: { action: string; payload?: { mode?: string } | null }[];
    }).data;
    const restored = rows.find((r) => r.action === "backup.restored");
    expect(restored).toBeTruthy();
    expect(restored?.payload?.mode).toBe("overwrite");
  });
});

/**
 * Overwrite must not reach a GLOBAL identity.
 *
 * `rowBelongs` lets `users` rows through because the dump was already narrowed
 * to this workspace's members — harmless additively, since an existing identity
 * is simply skipped. Under overwrite it is not: the same person can belong to
 * several workspaces, so restating their profile from one workspace's backup
 * would be visible in all of them. Scoped tables (memberships, roles,
 * permissions) stay overwritable.
 */
describe("restore: overwrite never restates a shared identity", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("`users` is reported in keptAdditive under overwrite", async () => {
    const backupRes = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: "identity" }),
    });
    expect(backupRes.status).toBe(201);
    const backup = ((await backupRes.json()) as { data: { id: string } }).data;

    const res = await h.fetch(`/api/admin/db/backups/${backup.id}/restore?mode=overwrite`, {
      method: "POST",
      headers: { ...json, "x-backlex-confirm": "yes" },
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { keptAdditive: string[] } }).data;
    // Named specifically: "non-empty" would also be satisfied by `user_roles`,
    // which is kept additive for an unrelated reason (no `id` column).
    expect(data.keptAdditive).toContain("users");
  });
});

/**
 * Overwrite must not restate INSTANCE-GLOBAL configuration.
 *
 * `tenantColumnWhere` scopes most system tables as `tenant_id = <mine> OR
 * tenant_id IS NULL`, so every workspace's dump deliberately carries the
 * instance-global rows — default email templates, global `app_settings`,
 * instance-wide `api_keys`. Additively that is inert: those rows exist, so they
 * are skipped. Under overwrite the UPDATE keys on `id` alone, which would let a
 * workspace admin revert instance-wide configuration to its backup-era value
 * from an operation scoped to their own workspace.
 *
 * Found in the security review of this feature, not by a failing test.
 */
describe("restore: overwrite never restates an instance-global row", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a global app_settings row survives an overwrite restore unchanged", async () => {
    const ctx = await buildContext(h.env);
    const key = `guard_probe_${Date.now()}`;
    const insert = (value: string) =>
      (ctx.db as any).run(
        sqlRaw(
          `INSERT INTO app_settings (id, tenant_id, key, value, updated_at)
           VALUES ('${key}', NULL, '${key}', '${JSON.stringify(value)}', ${Date.now()})`,
        ),
      );
    await insert("backup-era");

    const backupRes = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: "global-guard" }),
    });
    expect(backupRes.status).toBe(201);
    const backup = ((await backupRes.json()) as { data: { id: string } }).data;

    // The instance is hardened after the backup was taken.
    await (ctx.db as any).run(
      sqlRaw(`UPDATE app_settings SET value = '"hardened"' WHERE id = '${key}'`),
    );

    const res = await h.fetch(`/api/admin/db/backups/${backup.id}/restore?mode=overwrite`, {
      method: "POST",
      headers: { ...json, "x-backlex-confirm": "yes" },
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { keptAdditive: string[] } }).data;

    // The whole point: the global row is NOT reverted.
    const after = (await (ctx.db as any).all(
      sqlRaw(`SELECT value FROM app_settings WHERE id = '${key}'`),
    )) as Array<{ value: unknown }>;
    expect(String(after[0]?.value)).toContain("hardened");
    // And it is reported rather than silently downgraded.
    expect(data.keptAdditive).toContain("app_settings");
  });
});
