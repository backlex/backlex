import { drizzle as drizzleD1, type DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle as drizzleBunSqlite, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

export type SqliteDb =
  | DrizzleD1Database<typeof schema>
  | SQLiteBunDatabase<typeof schema>;

/**
 * `binding` should be a Cloudflare D1Database. We accept `unknown` here so
 * this package compiles without depending on @cloudflare/workers-types — the
 * caller (apps/api) already pulls those types in.
 */
export const createD1Client = (binding: unknown): SqliteDb =>
  drizzleD1(binding as Parameters<typeof drizzleD1>[0], { schema });

/**
 * Open a D1 Sessions-API client. The constraint (`first-unconstrained` by
 * default) routes the first read to the nearest replica and pins every
 * subsequent statement on the same session to that replica with read-your-
 * writes consistency. A bookmark string can be passed to anchor the session
 * to a known database state (e.g. from `X-D1-Bookmark` on a prior response)
 * for read-after-write across requests.
 *
 * The returned drizzle client is otherwise identical to `createD1Client` —
 * routes don't need to know about Sessions API.
 */
export const createD1SessionClient = (
  binding: unknown,
  constraint: string = "first-unconstrained",
): SqliteDb => {
  const session = (
    binding as { withSession: (c: string) => Parameters<typeof drizzleD1>[0] }
  ).withSession(constraint);
  return drizzleD1(session, { schema });
};

export const createBunSqliteClient = (path = "./.data/workeros.sqlite"): SqliteDb => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return drizzleBunSqlite({ client: db, schema });
};

export { schema };
