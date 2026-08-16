/**
 * The two ways a job is claimed have to produce the same object.
 *
 * Postgres claims with `UPDATE … RETURNING <explicit column list>`; SQLite
 * claims with `select()`, which is every column. So the pg list is a hand-
 * maintained copy of the table, and a column added to the schema does not
 * appear in it — it simply comes back `undefined` on Postgres and populated on
 * SQLite, with no error on either.
 *
 * That is exactly what had happened: the list named ten columns, so
 * `claimedAt`, `lastError`, `result`, the three timestamps — and then
 * `progress` — were missing from every job handed to a handler on Postgres. It
 * cost nothing while no handler read them. The moment one resumes from
 * `job.progress` it works on SQLite, silently starts from zero on Postgres, and
 * the suite (which runs on SQLite) agrees with it.
 *
 * This test is the gate. It reads the RETURNING list out of the source and
 * compares it against the table definition itself, so a new column fails here
 * rather than in production on the one dialect CI does not exercise.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableColumns } from "drizzle-orm";
import * as sqlite from "@backlex/db/sqlite";
import * as pg from "@backlex/db/pg";

const SOURCE = resolve(import.meta.dir, "../src/server/services/jobs.ts");

/**
 * Pull the aliased property names out of the `JOB_RETURNING` template.
 *
 * Each entry is either `identifier("run_at") AS "runAt"` or a bare
 * `identifier("queue")` whose property name is the column name. Parsing the
 * source rather than exporting the list keeps the production code free of a
 * shape that exists only for a test.
 */
const returningProperties = (): string[] => {
  const src = readFileSync(SOURCE, "utf8");
  const block = src.match(/const JOB_RETURNING = sql`([\s\S]*?)`;/);
  if (!block?.[1]) throw new Error("JOB_RETURNING not found in services/jobs.ts");
  const props: string[] = [];
  // The `}` closes the template interpolation, so it sits between the
  // identifier call and its `AS` alias.
  const entry = /sql\.identifier\("([a-z_]+)"\)\}?(?:\s*AS\s*"([A-Za-z]+)")?/g;
  for (const m of block[1].matchAll(entry)) {
    props.push(m[2] ?? m[1]!);
  }
  return props;
};

describe("job row parity across dialects", () => {
  test("the Postgres claim projects every column SQLite's select() returns", () => {
    const sqliteProps = Object.keys(getTableColumns(sqlite.schema.jobs)).sort();
    const projected = returningProperties().sort();
    // Set equality, not a subset: a column in the projection that the table no
    // longer has is a query that will fail at run time on Postgres only.
    expect(projected).toEqual(sqliteProps);
  });

  test("the projection names the real Postgres column for every property", () => {
    const src = readFileSync(SOURCE, "utf8");
    const block = src.match(/const JOB_RETURNING = sql`([\s\S]*?)`;/)![1]!;
    const pgColumns = Object.values(getTableColumns(pg.schema.jobs)).map((c) => c.name);
    const named = [...block.matchAll(/sql\.identifier\("([a-z_]+)"\)/g)].map((m) => m[1]!);
    for (const col of named) {
      // A typo here is invisible in review and fatal at run time: Postgres
      // answers `column "attemptss" does not exist`, and only on Postgres.
      expect({ col, known: pgColumns.includes(col) }).toEqual({ col, known: true });
    }
  });

  test("JobRow declares everything the claim returns", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/server/services/jobs.ts"), "utf8");
    const iface = src.match(/export interface JobRow \{([\s\S]*?)\n\}/);
    expect(iface?.[1]).toBeTruthy();
    const declared = [...iface![1]!.matchAll(/^\s{2}([A-Za-z]+)[?]?:/gm)].map((m) => m[1]!);
    for (const prop of returningProperties()) {
      expect({ prop, declared: declared.includes(prop) }).toEqual({ prop, declared: true });
    }
  });
});
