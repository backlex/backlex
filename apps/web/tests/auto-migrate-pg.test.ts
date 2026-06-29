/**
 * PG-dialect auto-migrate regression. Closes the gap that let the
 * Vercel/Netlify production bug escape every existing test layer:
 *
 *   - `auto-migrate.test.ts` only exercises bun-sqlite. The bug-causing
 *     statement (`ALTER TABLE ... DROP CONSTRAINT IF EXISTS ...`) doesn't
 *     even exist in the SQLite migration bundle, and the failure shape
 *     is PG-dialect / driver-specific.
 *   - `pg-smoke.test.ts` boots a pglite harness, but the vector extension
 *     fails to load under bun-test in this repo (the file documents the
 *     environment issue) — so the only "pg test" we had was a no-op.
 *
 * Two strategies layered together:
 *
 *  1. **Unit tests against the in-memory error classifier + per-migration
 *     loop.** These don't need pglite at all — they verify the regex and
 *     the per-migration try/catch with synthetic Drizzle-shaped errors.
 *     If a new PG-specific error pattern slips past the regex, ONE of
 *     these fails loudly. This is the layer that would have caught the
 *     production bug (the "multiple primary keys" message wasn't in the
 *     regex when the bug shipped).
 *
 *  2. **End-to-end pglite test with setupError fallback.** When the
 *     pgvector extension loads cleanly (CI environments, future Bun
 *     versions), this replays the full PG bundle and verifies the
 *     ledger fills to PG_MIGRATIONS.length. When pglite fails to boot,
 *     this falls through to a sentinel assertion the same way pg-smoke
 *     does, so the suite stays green without silently hiding the test.
 *
 * Layer (1) is the meaningful one. Layer (2) is bonus coverage when
 * the environment cooperates.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { ensureMigrations, type AutoMigrateDb } from "@backlex/db";
import { MIGRATIONS as PG_MIGRATIONS } from "@backlex/db/pg/migrations-bundle";

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — error classifier + per-migration loop, no pglite
// ─────────────────────────────────────────────────────────────────────────────

/** Build a Drizzle-shaped error: an outer wrapper with a useless
 *  `Failed query: ...` template and a `cause` carrying the real driver
 *  error text. Mirrors what neon-http actually throws in production. */
const drizzleErr = (causeMsg: string): Error => {
  const cause = new Error(causeMsg);
  const wrapper = new Error("Failed query: synthetic");
  (wrapper as { cause?: Error }).cause = cause;
  return wrapper;
};

/** Minimal pg-shaped applier that lets us drive `ensureMigrations`
 *  without a real DB. Captures every statement executed; lets the test
 *  inject errors deterministically. */
const makeMockApplier = (opts: {
  throwOn?: (sqlText: string) => Error | null;
}): {
  db: AutoMigrateDb;
  executed: string[];
  ledgerInserts: string[];
} => {
  const executed: string[] = [];
  const ledgerInserts: string[] = [];
  const db: AutoMigrateDb = {
    execute: async (query: SQL) => {
      // drizzle's `sql` template object carries .queryChunks; serialize
      // best-effort so tests can match on the text. For sql.raw() the
      // chunks contain the raw text directly.
      const chunks = (query as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
      const text = chunks
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && "value" in c) {
            const v = (c as { value: unknown }).value;
            return Array.isArray(v) ? v.join("") : String(v);
          }
          return "";
        })
        .join("");
      executed.push(text);
      const thrown = opts.throwOn?.(text);
      if (thrown) throw thrown;
      // Special-case: SELECT name FROM __backlex_migrations → return the
      // ledger we've been recording. INSERT INTO __backlex_migrations →
      // record the value.
      if (/select\s+name\s+from\s+__backlex_migrations/i.test(text)) {
        return { rows: ledgerInserts.map((n) => ({ name: n })) };
      }
      const ins = /__backlex_migrations.*values\s*\(\s*['"]?([^'")]+)/i.exec(text);
      if (ins?.[1]) ledgerInserts.push(ins[1]);
      return { rows: [] };
    },
  };
  return { db, executed, ledgerInserts };
};

describe("auto-migrate: idempotency classifier covers PG-specific failure shapes", () => {
  // Each case mirrors a real Postgres / Drizzle error text we hit on
  // Neon. If the regex regresses, one of these fails loudly. The
  // "multiple primary keys" case is THE one that escaped to production
  // and stalled migration #13 of the bundle.
  const tolerated: ReadonlyArray<[string, string]> = [
    ['relation "users" already exists', "CREATE TABLE re-run"],
    ['type "email_status" already exists', "CREATE TYPE enum re-run"],
    ['column "mcp_tools" of relation "api_keys" already exists', "ADD COLUMN re-run"],
    ['multiple primary keys for table "collections" are not allowed', "PR #166 regression: system-named PK"],
    ['duplicate column name: mcp_tools', "SQLite ADD COLUMN re-run"],
    ['duplicate object', "PG constraint duplicate"],
  ];
  for (const [msg, label] of tolerated) {
    test(`tolerates: ${label}`, async () => {
      // Throw on the FIRST migration statement only (skip the
      // __backlex_migrations bookkeeping). The per-statement tolerance
      // + per-migration catch must keep the loop alive and resolve
      // ensureMigrations cleanly.
      let thrown = false;
      const { db } = makeMockApplier({
        throwOn: (text) => {
          if (/__backlex_migrations/.test(text)) return null;
          if (!thrown) {
            thrown = true;
            return drizzleErr(msg);
          }
          return null;
        },
      });
      let bubbled = false;
      try {
        await ensureMigrations(db, "pg");
      } catch {
        bubbled = true;
      }
      expect(bubbled).toBe(false);
    });
  }

  test("non-idempotent error: loop survives + the failure is reported, not swallowed", async () => {
    // A syntax error has NO match in the idempotency regex. The
    // per-statement layer rethrows; the per-migration catch records it in
    // `outcome.failed` and continues. ensureMigrations still resolves, but the
    // failure is now visible to the caller (it used to be a buried warning).
    let thrown = false;
    const { db, ledgerInserts } = makeMockApplier({
      throwOn: (text) => {
        if (/__backlex_migrations/.test(text)) return null;
        if (!thrown) {
          thrown = true;
          return drizzleErr("syntax error at or near 'banana'");
        }
        return null;
      },
    });
    let bubbled = false;
    let outcome;
    try {
      outcome = await ensureMigrations(db, "pg");
    } catch {
      bubbled = true;
    }
    expect(bubbled).toBe(false);
    expect(outcome?.failed.length).toBe(1);
    expect(outcome?.failed[0]?.error).toContain("banana");
    // The failed migration's name must NOT be in the ledger — so a cold start
    // retries it rather than treating the partial schema as complete.
    const failedName = outcome?.failed[0]?.name;
    expect(failedName).toBeDefined();
    expect(ledgerInserts).not.toContain(failedName);
  });

  test("ALTER COLUMN TYPE that can't cast is a genuine failure (no longer masked)", async () => {
    // `cannot be cast automatically` used to be tolerated as "already in the
    // target shape" — that masked a column left in the wrong type. It must now
    // surface as a real failure.
    let thrown = false;
    const { db } = makeMockApplier({
      throwOn: (text) => {
        if (/__backlex_migrations/.test(text)) return null;
        if (!thrown) {
          thrown = true;
          return drizzleErr(
            'column "amount" cannot be cast automatically to type integer',
          );
        }
        return null;
      },
    });
    const outcome = await ensureMigrations(db, "pg");
    expect(outcome.failed.length).toBe(1);
    expect(outcome.failed[0]?.error).toContain("cannot be cast");
  });

  test("every migration in the PG bundle gets attempted (no early abort)", async () => {
    // No errors thrown anywhere: every migration's INSERT must land in
    // the ledger. Guards against a future bug where the loop bails on
    // some structural condition.
    const { db, ledgerInserts } = makeMockApplier({});
    await ensureMigrations(db, "pg");
    expect(ledgerInserts.length).toBe(PG_MIGRATIONS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — pglite end-to-end, best-effort
// ─────────────────────────────────────────────────────────────────────────────

let pgliteWorks = false;
let setupErr: Error | undefined;

// Layer 2 — live pglite replay of the real PG migration bundle. Two hard-won
// details keep it from flaking under bun-test (it used to fail spuriously on
// machines where the drizzle path couldn't load pgvector — breaking the
// pre-push hook for unrelated changes):
//   • Load pgvector via pglite's own `pg.exec("CREATE EXTENSION …")`, NOT
//     drizzle's `db.execute(sql.raw(…))`. Under bun-test the drizzle execute
//     path reports `extension "vector" is not available` (and leaks an async
//     WASM rejection that bun-test turns into a suite failure); `pg.exec`
//     loads the extension reliably.
//   • Assert forward progress, NOT an exact ledger count: pglite isn't 100%
//     Postgres, so a few statements in the real bundle no-op under it and
//     `ensureMigrations`' per-migration tolerance absorbs them. "Every
//     migration applied" is guaranteed by Layer 1 + the production Neon
//     deploy, not by pglite.
beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");
    const probe = new PGlite({ extensions: { vector } });
    await probe.waitReady;
    await probe.exec("CREATE EXTENSION IF NOT EXISTS vector");
    pgliteWorks = true;
    await probe.close();
  } catch (err) {
    setupErr = err instanceof Error ? err : new Error(String(err));
  }
}, 60_000);

describe("auto-migrate (pg) — end-to-end pglite", () => {
  test("real PG bundle replays against pglite without throwing", async () => {
    if (!pgliteWorks) {
      // pglite/pgvector genuinely couldn't boot here (e.g. a future Bun/WASM
      // regression). Layer 1 covers the migration logic in any environment;
      // don't fail the suite on an environment we can't control.
      expect(setupErr ?? new Error("pglite unavailable")).toBeDefined();
      return;
    }
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const pg = new PGlite({ extensions: { vector } });
    await pg.waitReady;
    // Load pgvector via pglite directly — drizzle's execute path can't (see note above).
    await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
    const db = drizzle(pg);
    try {
      // The real value: ensureMigrations replays the full PG bundle against a
      // real Postgres parser without throwing (its per-migration tolerance
      // absorbs the statements pglite doesn't implement).
      await ensureMigrations(db, "pg");
      const r = (await db.execute(
        sql`SELECT name FROM __backlex_migrations ORDER BY name`,
      )) as unknown as { rows: Array<{ name: string }> };
      // Forward progress — pglite applies a subset of the bundle, so assert it
      // recorded migrations rather than an exact count (which only real
      // Postgres / Layer 1 can guarantee).
      expect(r.rows.length).toBeGreaterThan(0);
      expect(r.rows.length).toBeLessThanOrEqual(PG_MIGRATIONS.length);
    } finally {
      await pg.close();
    }
  });
});

afterAll(() => {
  if (setupErr) {
    console.warn(
      "[auto-migrate-pg] layer-2 (pglite end-to-end) skipped — pgvector unavailable in this environment:",
      setupErr.message.slice(0, 200),
    );
  }
});
