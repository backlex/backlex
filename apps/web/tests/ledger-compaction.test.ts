/**
 * Exercises the SQL that compacts `__drizzle_migrations` against a real SQLite
 * database, seeded into the shape production actually reached: 121 hashes
 * appended once per deploy for ~290 deploys, 34,811 rows.
 *
 * The plumbing in `compact-d1-ledger.ts` can only be reviewed by reading it —
 * it talks to wrangler. These four statements can be *run*, and they are the
 * part where a mistake is expensive: this deletes from the table that decides
 * whether 120 migrations replay, against a production database, once.
 *
 * Sibling to `migrate-d1-ledger.test.ts`, which pins why the table filled up.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  LEDGER_COUNT_SQL,
  LEDGER_CREATE_SQL,
  LEDGER_DEDUPE_SQL,
  LEDGER_GUARD_INDEX,
  LEDGER_GUARD_SQL,
  LEDGER_INDEX_LIST_SQL,
} from "../../../packages/db/src/sqlite/ledger-sql";

const HASHES = 121;
const DEPLOYS = 5; // enough to prove the shape; production ran ~290

/** A ledger filled the way the loop filled it: every hash re-appended per
 *  deploy, `created_at` increasing, so the earliest row is the first deploy's. */
const seed = () => {
  const db = new Database(":memory:");
  db.run(LEDGER_CREATE_SQL);
  const insert = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  for (let deploy = 0; deploy < DEPLOYS; deploy++) {
    for (let h = 0; h < HASHES; h++) {
      insert.run(`hash_${h}`, 1_700_000_000_000 + deploy * 1_000 + h);
    }
  }
  return db;
};

const counts = (db: Database) =>
  db.query("SELECT COUNT(*) AS total, COUNT(DISTINCT hash) AS hashes FROM __drizzle_migrations").get() as {
    total: number;
    hashes: number;
  };

describe("ledger compaction SQL", () => {
  test("collapses to exactly one row per hash and loses none", () => {
    const db = seed();
    expect(counts(db)).toEqual({ total: HASHES * DEPLOYS, hashes: HASHES });

    db.run(LEDGER_DEDUPE_SQL);

    expect(counts(db)).toEqual({ total: HASHES, hashes: HASHES });
    const kept = db
      .query("SELECT hash FROM __drizzle_migrations ORDER BY hash")
      .all() as { hash: string }[];
    expect(new Set(kept.map((r) => r.hash)).size).toBe(HASHES);
  });

  test("keeps the EARLIEST row per hash, not an arbitrary one", () => {
    // The whole point of preserving `created_at`: the ledger's own record of
    // when a migration was first applied survives the cleanup.
    const db = seed();
    const earliest = db
      .query("SELECT hash, MIN(created_at) AS first_seen FROM __drizzle_migrations GROUP BY hash")
      .all() as { hash: string; first_seen: number }[];

    db.run(LEDGER_DEDUPE_SQL);

    const after = db.query("SELECT hash, created_at FROM __drizzle_migrations").all() as {
      hash: string;
      created_at: number;
    }[];
    const byHash = new Map(after.map((r) => [r.hash, r.created_at]));
    for (const row of earliest) expect(byHash.get(row.hash)).toBe(row.first_seen);
  });

  test("keeps the earliest even when id order disagrees with created_at", () => {
    // `MIN(id)` and "earliest created_at" agree today because drizzle appends
    // in order. They are not the same property, and the SQL ranks by
    // created_at first — so a row inserted later with an older timestamp wins.
    const db = new Database(":memory:");
    db.run(LEDGER_CREATE_SQL);
    db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', 2000)"); // id 1
    db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', 1000)"); // id 2, older

    db.run(LEDGER_DEDUPE_SQL);

    const rows = db.query("SELECT id, created_at FROM __drizzle_migrations").all() as {
      id: number;
      created_at: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe(1000);
    expect(rows[0]?.id).toBe(2);
  });

  test("is idempotent — a second run deletes nothing", () => {
    const db = seed();
    db.run(LEDGER_DEDUPE_SQL);
    const first = counts(db);
    db.run(LEDGER_DEDUPE_SQL);
    expect(counts(db)).toEqual(first);
  });

  test("leaves an already-clean ledger untouched", () => {
    const db = new Database(":memory:");
    db.run(LEDGER_CREATE_SQL);
    db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2)");
    db.run(LEDGER_DEDUPE_SQL);
    expect(counts(db)).toEqual({ total: 2, hashes: 2 });
  });
});

describe("ledger regrowth guard", () => {
  test("rejects the exact INSERT migrate-d1.ts issues for an already-recorded hash", () => {
    const db = seed();
    db.run(LEDGER_DEDUPE_SQL);
    db.run(LEDGER_GUARD_SQL);

    // Verbatim shape from migrate-d1.ts, which is what would run if the ledger
    // read ever came back empty again.
    expect(() =>
      db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('hash_0', 1800000000000);"),
    ).toThrow(/UNIQUE/i);

    expect(counts(db)).toEqual({ total: HASHES, hashes: HASHES });
  });

  test("still admits a genuinely new migration", () => {
    // The guard must block re-recording, not recording.
    const db = seed();
    db.run(LEDGER_DEDUPE_SQL);
    db.run(LEDGER_GUARD_SQL);
    db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('hash_new', 1800000000000);");
    expect(counts(db)).toEqual({ total: HASHES + 1, hashes: HASHES + 1 });
  });

  test("cannot be created before the dedupe — which is why the script orders them", () => {
    const db = seed();
    expect(() => db.run(LEDGER_GUARD_SQL)).toThrow(/UNIQUE/i);
  });

  test("is idempotent (IF NOT EXISTS) and discoverable by the index query", () => {
    const db = seed();
    db.run(LEDGER_DEDUPE_SQL);
    db.run(LEDGER_GUARD_SQL);
    db.run(LEDGER_GUARD_SQL); // must not throw

    // The script decides "already guarded" from this query's rows.
    const names = db
      .query(LEDGER_INDEX_LIST_SQL.replace(/\/\*\*\//g, " "))
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toContain(LEDGER_GUARD_INDEX);
  });
});

describe("read statements survive the wrangler argv split", () => {
  // A `--command=` argv element containing a real space reached wrangler on the
  // Cloudflare runner split into four tokens. `/**/` is a comment SQLite treats
  // as whitespace, keeping the statement a single token. Same invariant as
  // migrate-d1-ledger.test.ts, applied to the statements this script sends.
  test.each([
    ["LEDGER_COUNT_SQL", LEDGER_COUNT_SQL],
    ["LEDGER_INDEX_LIST_SQL", LEDGER_INDEX_LIST_SQL],
  ])("%s contains no spaces", (_name, sql) => {
    expect(sql).not.toMatch(/ /);
  });

  test("and both still parse as SQL", () => {
    // Space-free is worthless if it stopped being valid SQL — run them.
    const db = seed();
    expect(() => db.query(LEDGER_COUNT_SQL).get()).not.toThrow();
    expect(() => db.query(LEDGER_INDEX_LIST_SQL).all()).not.toThrow();
    expect(counts(db)).toEqual(
      db.query(LEDGER_COUNT_SQL).get() as { total: number; hashes: number },
    );
  });
});
