/**
 * Postgres client factory. Two drivers, picked by `driver`:
 *
 *  - `postgres-js` (default) — `postgres` npm package over `node:net`/`node:tls`.
 *    Works on Bun, Node self-host, Cloudflare Workers (under `nodejs_compat`),
 *    and Netlify Edge (Deno provides node:net polyfill). Does **not** work on
 *    Vercel Edge (V8 isolate, no node:net).
 *
 *  - `neon-http` — `@neondatabase/serverless` over `fetch()`. Works on every
 *    runtime including Vercel Edge. Requires a Neon database OR a self-hosted
 *    `wsproxy` in front of any Postgres. Driver also accepts `prepare: false`
 *    semantics implicitly (no prepared statements).
 *
 * `prepare: false` is set on the postgres-js path so Supabase / PgBouncer
 * transaction-pooler URLs (which forbid PREPARE) work out of the box.
 */
import { drizzle as drizzlePgJs, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle as drizzleNeon, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import postgres from "postgres";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

/** Driver-agnostic Drizzle client. Both drivers expose the same query
 *  builder; their result types differ only in row-array vs result-object
 *  shapes, which Drizzle smooths over. */
export type PgDb =
  | PostgresJsDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

export type PgDriver = "postgres-js" | "neon-http";

/**
 * Connection options for the request-path `postgres-js` client.
 *
 * Pure and exported so it can be asserted directly: pglite does not use
 * postgres-js, so there is no harness in which the real client's behaviour can
 * be observed, and pinning the resolved object is the honest substitute for a
 * behavioural test.
 *
 * `max` and `connect_timeout` mirror what `services/migrate.ts` already passes
 * to its own client — a known-good shape, not a new guess.
 *
 * **`statement_timeout` is opt-in and unset by default, deliberately.** This is
 * the same handle the boot migration runner uses, and a timed-out `CREATE INDEX`
 * is recorded as a failed migration and retried on every cold start — an
 * expensive loop that gets worse the bigger the table is. Anyone enabling it
 * must set it above their slowest migration.
 */
export const pgClientOptions = (opts?: {
  statementTimeoutMs?: string | number | null;
}): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    prepare: false,
    max: 10,
    connect_timeout: 10,
  };
  const raw = Number(opts?.statementTimeoutMs ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    base.connection = { statement_timeout: String(Math.floor(raw)) };
  }
  return base;
};

export const createPgClient = (
  url: string,
  driver: PgDriver = "postgres-js",
  opts?: { statementTimeoutMs?: string | number | null },
): PgDb => {
  if (driver === "neon-http") {
    return drizzleNeon({ client: neon(url), schema }) as PgDb;
  }
  const client = postgres(url, pgClientOptions(opts) as never);
  return drizzlePgJs({ client, schema }) as PgDb;
};

export { schema };
