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

export const createPgClient = (
  url: string,
  driver: PgDriver = "postgres-js",
): PgDb => {
  if (driver === "neon-http") {
    return drizzleNeon({ client: neon(url), schema }) as PgDb;
  }
  const client = postgres(url, { prepare: false });
  return drizzlePgJs({ client, schema }) as PgDb;
};

export { schema };
