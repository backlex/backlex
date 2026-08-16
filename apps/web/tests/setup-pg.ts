/**
 * Postgres test harness — boots an in-process pglite, loads the pgvector
 * extension, applies every `packages/db/drizzle/pg` migration, and injects
 * the resulting drizzle client into `buildContext` via
 * `__setDbOverrideForTests`. Returns the same shape as the SQLite harness so
 * spec files can share fixtures.
 *
 * Why pglite: it ships a WASM Postgres that runs in-process, no Docker, no
 * external server. The trade-offs vs real Postgres are minor for our use
 * (no LISTEN/NOTIFY, no parallel queries) and the extension surface we need
 * (pgvector) is supported.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@backlex/db/pg";
import { createApp } from "../src/server/app";
import { __setDbOverrideForTests } from "../src/server/context";
import { nextSyntheticIp, withSyntheticIp } from "./setup";
import { invalidateAllPermissions } from "../src/server/services/permissions-cache";
import type { Env } from "../src/server/env";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const MIGRATIONS = resolve(ROOT, "packages/db/drizzle/pg");

export interface PgTestHarness {
  env: Env;
  app: ReturnType<typeof createApp>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  cookies: () => Record<string, string>;
  /** The synthetic client IP this harness presents. See the SQLite twin. */
  clientIp: string;
  /** Raw SQL against the same in-process Postgres the app is using. Exposed so
   *  a spec can assert what the DATABASE holds — `pg_policies`, `pg_class`, or
   *  what a second identity sees after `SET ROLE`. Simple protocol, like the
   *  migration runner above, so DDL and `SET` behave. */
  exec: (sql: string) => Promise<Array<Record<string, unknown>>>;
  cleanup: () => Promise<void>;
}

const DEFAULT_APP_URL = "http://localhost:5173";

/** Apply every migration file under `MIGRATIONS` to the pglite instance, in
 *  ascending directory order. We bypass drizzle-kit's migrator because it
 *  wants a real connection string; pglite's `exec` runs raw SQL fine.
 *
 *  Raw `pg.exec` (simple protocol) instead of drizzle `db.execute` (extended
 *  protocol) throughout: the extended protocol's prepared-statement path races
 *  the vector extension's lazy VFS load — `CREATE EXTENSION vector` failed
 *  deterministically on macOS with "extension is not available" while the
 *  same statement through `pg.exec` succeeds. */
const applyPgMigrations = async (pg: PGlite): Promise<void> => {
  // Wait for the WASM postgres + extension bundles (vector.tar.gz) to finish
  // unpacking before issuing the first CREATE EXTENSION — otherwise the
  // control file lookup races the extension loader.
  await pg.waitReady;
  // Enable pgvector so the `vector(N)` column types in later migrations parse.
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");

  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const file = resolve(MIGRATIONS, dir, "migration.sql");
    const body = readFileSync(file, "utf8");
    // drizzle-kit emits statement-breakpoint markers; split on them so a
    // failing statement points at the right SQL.
    const statements = body
      .split(/-->\s*statement-breakpoint\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
  }
};

export const makeHarnessPg = async (
  overrides: Partial<Env> = {},
): Promise<PgTestHarness> => {
  // `{ client: pg }`, NOT positional `drizzle(pg, …)`: the beta-22 pglite
  // driver destructures its first argument as a config object, so a bare
  // instance falls through to `construct(new PGlite(undefined))` — drizzle
  // silently runs against a fresh EMPTY database (no vector extension, no
  // migrated tables) while raw `pg.*` calls hit ours. That's why this harness
  // "failed to load pgvector" everywhere and pg-smoke silently skipped.
  const pg = new PGlite({ extensions: { vector } });
  const db = drizzle({ client: pg, schema });
  // Same reset the sqlite harness does (setup.ts): the permission/tenant
  // caches are module-global, so a previous spec's DEFAULT-tenant id would
  // otherwise leak into this fresh database and FK-violate on sign-up.
  invalidateAllPermissions();
  try {
    await applyPgMigrations(pg);
  } catch (err) {
    // Close the WASM instance so the bun test runner doesn't see a lingering
    // open handle (which it counts as an "unfinished" run → exit 100 even on
    // pass).
    try {
      await pg.close();
    } catch {
      // already closing
    }
    throw err;
  }

  const env: Env = {
    APP_URL: DEFAULT_APP_URL,
    AUTH_SECRET: "test-secret-not-for-prod-but-stable-across-calls",
    DATABASE_URL: "postgres://pglite-in-memory",
    ...overrides,
  };
  __setDbOverrideForTests(env, db as unknown as Parameters<typeof __setDbOverrideForTests>[1], "pg");

  const app = createApp(env);

  const cookieJar = new Map<string, string>();
  // Shares the SQLite harness's sequence — both run in the same bun-test
  // process, so two independent random draws could (and did) collide with each
  // other. See `nextSyntheticIp` for why this is a counter and not a random pick.
  const syntheticIp = nextSyntheticIp();
  const fetchWithCookies = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = input.startsWith("http") ? input : `${env.APP_URL}${input}`;
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Origin")) headers.set("Origin", env.APP_URL);
    if (!headers.has("X-Forwarded-For"))
      headers.set("X-Forwarded-For", syntheticIp);
    if (cookieJar.size > 0) {
      const cookieHeader = [...cookieJar.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      headers.set("Cookie", cookieHeader);
    }
    const res = await app.fetch(new Request(url, { ...init, headers }));
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value === "" || value === "deleted") cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
    return res;
  };

  return {
    env,
    app: withSyntheticIp(app, syntheticIp),
    clientIp: syntheticIp,
    fetch: fetchWithCookies,
    cookies: () => Object.fromEntries(cookieJar),
    exec: async (text: string) => {
      const res = await pg.exec(text);
      const last = res[res.length - 1];
      return (last?.rows ?? []) as Array<Record<string, unknown>>;
    },
    cleanup: async () => {
      try {
        await pg.close();
      } catch {
        // already closed
      }
    },
  };
};

/**
 * Boot the Postgres harness, and **fail loudly** when it cannot.
 *
 * Every `*-pg.test.ts` used to hand-roll the same block: `try { harness = await
 * makeHarnessPg() } catch { console.warn("skipping"); return }`, then guard each
 * test with `if (!harness) return`. Seventeen copies of it, and the effect was
 * that a broken harness turned fifty-one Postgres specs into fifty-one passes.
 * bun does not report those as skipped — a test that registers and returns early
 * is a **pass** — so a run in which the entire pg dialect went untested is
 * indistinguishable, in the summary line and in CI, from one where it all
 * worked. A gate that goes green with nothing behind it is not a gate.
 *
 * The reason to fail rather than skip is specific to this harness: it needs
 * nothing external. `@electric-sql/pglite` is a WASM Postgres in the dependency
 * tree, with pgvector shipped in the same package — no Docker, no server, no
 * `DATABASE_URL` (the one the harness writes is a placeholder that is never
 * dialled). So a boot failure is not "this machine lacks Postgres", it is a real
 * defect: a bad driver call, a migration pglite cannot take, a dependency bump.
 * That has already happened once — the beta-22 positional `drizzle(pg)` call
 * silently produced an empty database, and the silence is why it survived.
 *
 * `BACKLEX_PG_TESTS=optional` restores the old behaviour for someone genuinely
 * stuck (an unsupported arch, a locked-down sandbox). It is opt-in, it says so
 * on stderr, and CI never sets it — so the escape hatch cannot be the accident.
 */
export const PG_TESTS_OPTIONAL =
  (process.env.BACKLEX_PG_TESTS ?? "").trim().toLowerCase() === "optional";

export const makeHarnessPgOrFail = async (
  tag: string,
  overrides: Partial<Env> = {},
): Promise<PgTestHarness | null> => {
  try {
    return await makeHarnessPg(overrides);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (PG_TESTS_OPTIONAL) {
      console.warn(
        `[${tag}] pglite harness unavailable and BACKLEX_PG_TESTS=optional — this spec asserted NOTHING: ${e.message}`,
      );
      return null;
    }
    throw new Error(
      `[${tag}] the in-process Postgres harness failed to boot. This is a real failure, not a missing environment — ` +
        `pglite ships the server and pgvector in the dependency tree, so nothing external is required. ` +
        `Fix the cause, or re-run with BACKLEX_PG_TESTS=optional to skip the pg dialect deliberately. Cause: ${e.message}`,
      { cause: e },
    );
  }
};
