/**
 * A backup must never report success for a dump it could not complete.
 *
 * `runBackup` used to wrap both of its read loops in a bare `catch { rows = [] }`.
 * That made two very different things indistinguishable: a table that is
 * legitimately absent (a partial migration, an adopted table dropped outside
 * backlex) and a table that EXISTS but could not be read. The second silently
 * dropped its rows from the dump and the backup still recorded `status: done` —
 * the worst possible failure for the one artifact recovery depends on, because
 * nothing surfaces it until someone actually needs to restore.
 *
 * The assertions here are deliberately paired. "A backup succeeds" passes today
 * and proves nothing, so each test pins the *distinction*: absent → `done` with
 * the table named, unreadable → `failed` with no storage object written.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { runBackup, recordAndRunBackup } from "../src/server/services/backup";

const json = { "content-type": "application/json" };

/** Recover the SQL text from a drizzle statement. `String(stmt)` is
 *  `[object Object]` and there is no `.sql` property — the text lives in
 *  `queryChunks[].value`, which is a string array per chunk. */
const stmtText = (stmt: unknown): string => {
  const chunks = (stmt as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c) => (Array.isArray(c?.value) ? c.value.join("") : String(c?.value ?? "")))
    .join("");
};

/**
 * A db whose `all` throws for the dump's data SELECT on `table`, and records
 * that it fired. Everything else passes straight through.
 *
 * Matched on the exact `SELECT * FROM "<table>"` the dump emits, NOT on the
 * table name anywhere in the statement. `tableExists` probes `sqlite_master`
 * with the same name in its predicate, so a loose match would throw during the
 * existence check instead — and the test would pass while exercising the branch
 * that is already tolerated, rather than the read failure it claims to cover.
 */
const dbFailingOn = (
  realDb: any,
  table: string,
  message: string,
): { db: any; fired: () => boolean } => {
  let fired = false;
  const needle = `SELECT * FROM "${table}"`;
  const db = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "all") {
        return (stmt: unknown) => {
          if (stmtText(stmt).includes(needle)) {
            fired = true;
            throw new Error(message);
          }
          return target.all(stmt);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db, fired: () => fired };
};

const makeCollection = async (h: TestHarness, slug: string): Promise<void> => {
  const res = await h.fetch("/api/collections", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
  });
  expect(res.status).toBe(201);
};

describe("backup integrity", () => {
  let h: TestHarness;
  const slug = `bkint_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await makeCollection(h, slug);
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "Alpha" }),
    });
  });
  afterAll(() => h.cleanup());

  test("an absent table is reported, not silently dropped", async () => {
    const ctx = await buildContext(h.env);

    // Point a real collection's metadata at a table that does not exist. This
    // is the shape a partial migration leaves behind, and the ONE read failure
    // the dump is meant to tolerate.
    const ghost = `c_ghost_${Date.now()}`;
    await (ctx.db as any).run(
      sql.raw(
        `UPDATE collections SET physical_table = '${ghost}' WHERE slug = '${slug}'`,
      ),
    );

    const r = await runBackup(ctx, {
      tenantId: null,
      storageKey: `test/absent-${Date.now()}.jsonl`,
    });

    // Both halves matter: the backup completed (so absence is still tolerated),
    // AND it says which table it could not find. Asserting only "non-empty"
    // would pass if some unrelated table were reported instead.
    expect(r.missingTables).toContain(ghost);
    expect(r.rowCount).toBeGreaterThan(0);

    // Put it back so the next test reads a table that genuinely exists.
    await (ctx.db as any).run(
      sql.raw(
        `UPDATE collections SET physical_table = 'c_${slug}' WHERE slug = '${slug}'`,
      ),
    );
  });

  test("a table that exists but cannot be read FAILS the backup", async () => {
    const ctx = await buildContext(h.env);

    // `tableExists` says yes and the SELECT still throws — a permission error, a
    // corrupt page, a transient driver failure. Simulated by proxying the one
    // call `queryRows` makes, because there is no way to make SQLite refuse a
    // SELECT on a table it will happily report as present.
    const { db, fired } = dbFailingOn(
      ctx.db as any,
      "notifications",
      "database disk image is malformed",
    );

    await expect(
      runBackup({ ...ctx, db } as typeof ctx, {
        tenantId: null,
        storageKey: `test/unreadable-${Date.now()}.jsonl`,
      }),
    ).rejects.toThrow(/malformed/);
    // Proves the proxy actually fired — without this the rejection could come
    // from anywhere and the test would pass for the wrong reason.
    expect(fired()).toBe(true);
  });

  test("a failed dump records status:failed and writes no storage object", async () => {
    const ctx = await buildContext(h.env);
    const storageKey = `test/failed-${Date.now()}.jsonl`;

    const { db: proxied, fired } = dbFailingOn(
      ctx.db as any,
      "notifications",
      "unreadable table",
    );

    // Seed the tracking row the way the route does, then run through the
    // wrapper that owns the status lifecycle.
    const id = crypto.randomUUID();
    await (ctx.db as any).run(
      sql.raw(
        `INSERT INTO backups (id, tenant_id, kind, label, storage_key, size, table_count, status, created_at)
         VALUES ('${id}', NULL, 'manual', 'integrity', '${storageKey}', 0, 0, 'queued', ${Date.now()})`,
      ),
    );

    const outcome = await recordAndRunBackup({ ...ctx, db: proxied } as typeof ctx, {
      id,
      tenantId: null,
      storageKey,
      userId: null,
      label: "integrity",
    });
    expect(outcome.ok).toBe(false);
    expect(fired()).toBe(true);

    const rows = (await (ctx.db as any).all(
      sql.raw(`SELECT status, error FROM backups WHERE id = '${id}'`),
    )) as Array<{ status: string; error: string | null }>;
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toContain("unreadable table");

    // The artifact must not exist. A `failed` row next to a half-written dump
    // would still invite someone to restore from it.
    const stored = await ctx.storage.get(storageKey);
    expect(stored).toBeFalsy();
  });

  test("BACKUP_MAX_ROWS refuses rather than OOMing the isolate", async () => {
    // The dump is assembled in memory; past the budget it must fail loudly with
    // a row an operator can see, not die in a way that leaves `running` forever.
    const ctx = await buildContext({ ...h.env, BACKUP_MAX_ROWS: "1" });
    await expect(
      runBackup(ctx, {
        tenantId: null,
        storageKey: `test/budget-${Date.now()}.jsonl`,
      }),
    ).rejects.toThrow(/BACKUP_MAX_ROWS/);
  });
});
