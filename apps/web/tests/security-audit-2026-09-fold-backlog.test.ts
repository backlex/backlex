/**
 * Phase 9 of the 2026-09 pre-production audit — a progress report nobody read.
 *
 * `backfillFoldColumns` fills the `<name>__fold` companion for rows that predate
 * it. A NULL companion is not a degraded filter, it is an invisible row:
 * `NULL LIKE '%x%'` is NULL, so `_icontains` stops matching. The pass is
 * deliberately capped — `batch × maxBatches`, 100,000 rows by default — so one
 * call cannot run for ever, and its own doc comment states why it returns
 * anything at all:
 *
 *   > **Bounded, and it SAYS SO.** A cap keeps one call from running for ever;
 *   > the return value is how many rows are still unfolded, so a caller can
 *   > report "not finished" instead of reporting success over a half-done job.
 *
 * Both callers discarded it. `applyCollection` returned `void`; `restoreBackup`
 * called it inside an empty `catch`. So above the cap the companion columns
 * stayed NULL, search quietly stopped matching those rows, and every surface
 * reported plain success — the house's own silent-2xx shape, at >100k rows.
 *
 * These tests drive the cap directly (three rows, `maxBatches: 1`) rather than
 * inserting a hundred thousand. An unreachable branch is an untested one, which
 * is why `applyCollection` now takes the caps as an argument.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { applyCollection, backfillFoldColumns, type FieldDef } from "@backlex/db";

const tmpDirs: string[] = [];

const freshDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "faz9-fold-"));
  tmpDirs.push(dir);
  const client = new Database(join(dir, "t.sqlite"), { create: true });
  return { client, db: drizzleBunSqlite({ client }) as never };
};

const FIELDS: FieldDef[] = [{ name: "name", type: "text" }];

/** A managed collection with one foldable `text` field. `tenantScoped: false`
 *  keeps the table to the columns this spec is about. */
const shapeFor = (table: string) => ({
  table,
  fields: FIELDS,
  tenantScoped: false,
  ownerScoped: false,
});

const foldValues = (client: Database, table: string): Array<string | null> =>
  (client.query(`SELECT name__fold AS f FROM ${table} ORDER BY id`).all() as Array<{
    f: string | null;
  }>).map((r) => r.f);

describe("the fold backfill reports what it could not finish", () => {
  test("creating a table reports an empty backlog — there are no rows yet", async () => {
    const { client, db } = freshDb();
    const outcome = await applyCollection(db, "sqlite", shapeFor("c_new"));
    expect(outcome.foldBacklog).toEqual({});
    client.close();
  });

  test("a capped pass over pre-existing rows reports the remainder", async () => {
    const { client, db } = freshDb();
    // A table that exists WITHOUT the companion column, i.e. every workspace
    // the moment folded search shipped.
    client.run(`CREATE TABLE c_legacy (id text PRIMARY KEY NOT NULL, name text)`);
    for (const [i, name] of ["Ada", "Bob", "Cem"].entries()) {
      client.run(`INSERT INTO c_legacy (id, name) VALUES (?, ?)`, [`r${i}`, name] as never);
    }

    // One batch of one row, then stop: the shape of a table too large to finish
    // in a single apply.
    const outcome = await applyCollection(db, "sqlite", shapeFor("c_legacy"), {
      fold: { batch: 1, maxBatches: 1 },
    });

    // The claim under test. Before this phase the same call returned `void`.
    expect(outcome.foldBacklog).toEqual({ name: 2 });

    // And the report is true: exactly one row was folded.
    expect(foldValues(client, "c_legacy").filter((v) => v !== null).length).toBe(1);
    client.close();
  });

  test("an uncapped pass finishes and reports nothing owed", async () => {
    const { client, db } = freshDb();
    client.run(`CREATE TABLE c_small (id text PRIMARY KEY NOT NULL, name text)`);
    for (const [i, name] of ["Ada", "Bob", "Cem"].entries()) {
      client.run(`INSERT INTO c_small (id, name) VALUES (?, ?)`, [`r${i}`, name] as never);
    }

    const outcome = await applyCollection(db, "sqlite", shapeFor("c_small"));

    // Empty rather than "some small number" — a guard that reported a backlog
    // on every call would be as useless as one that never did.
    expect(outcome.foldBacklog).toEqual({});
    expect(foldValues(client, "c_small")).toEqual(["ada", "bob", "cem"]);
    client.close();
  });

  test("the backlog shrinks across passes, which is what makes it resumable", async () => {
    const { client, db } = freshDb();
    client.run(`CREATE TABLE c_resume (id text PRIMARY KEY NOT NULL, name text)`);
    for (const [i, name] of ["Ada", "Bob", "Cem"].entries()) {
      client.run(`INSERT INTO c_resume (id, name) VALUES (?, ?)`, [`r${i}`, name] as never);
    }

    const first = await applyCollection(db, "sqlite", shapeFor("c_resume"), {
      fold: { batch: 1, maxBatches: 1 },
    });
    expect(first.foldBacklog).toEqual({ name: 2 });

    const second = await applyCollection(db, "sqlite", shapeFor("c_resume"), {
      fold: { batch: 1, maxBatches: 1 },
    });
    expect(second.foldBacklog).toEqual({ name: 1 });

    const third = await applyCollection(db, "sqlite", shapeFor("c_resume"));
    expect(third.foldBacklog).toEqual({});
    expect(foldValues(client, "c_resume")).toEqual(["ada", "bob", "cem"]);
    client.close();
  });

  test("an adopted collection reports an empty backlog and touches nothing", async () => {
    // The applier never DDLs somebody else's table, so there is no companion
    // column to fill and nothing to be behind on. Asserted because the early
    // return had to grow a value and a wrong one would be invisible.
    const { client, db } = freshDb();
    client.run(`CREATE TABLE wp_posts (id text PRIMARY KEY NOT NULL, name text)`);
    client.run(`INSERT INTO wp_posts (id, name) VALUES ('r0', 'Ada')`);

    const outcome = await applyCollection(db, "sqlite", {
      ...shapeFor("wp_posts"),
      adopted: true,
    });
    expect(outcome.foldBacklog).toEqual({});
    const cols = (client.query("PRAGMA table_info(wp_posts)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(["id", "name"]);
    client.close();
  });

  test("the count comes from the pass itself, not from the applier's bookkeeping", async () => {
    // Separates the two layers on purpose. Everything above drives
    // `applyCollection`, so a build where the APPLIER invented the number and
    // the pass had gone silent would still be green. This one asks the pass
    // directly, with the same caps, and requires the same answer — so a failure
    // here versus a failure above says which half broke.
    const { client, db } = freshDb();
    client.run(`CREATE TABLE c_direct (id text PRIMARY KEY NOT NULL, name text)`);
    for (const [i, name] of ["Ada", "Bob", "Cem"].entries()) {
      client.run(`INSERT INTO c_direct (id, name) VALUES (?, ?)`, [`r${i}`, name] as never);
    }
    // The companion column has to exist before the pass has anything to fill —
    // `applyCollection` is what adds it, so run it uncapped first and then NULL
    // the companions back out, which is exactly what a restore from an older
    // dump leaves behind.
    await applyCollection(db, "sqlite", shapeFor("c_direct"));
    client.run(`UPDATE c_direct SET name__fold = NULL`);

    const backlog = await backfillFoldColumns(db, "sqlite", "c_direct", FIELDS, {
      batch: 1,
      maxBatches: 1,
    });
    expect(backlog).toEqual({ name: 2 });
    client.close();
  });
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
