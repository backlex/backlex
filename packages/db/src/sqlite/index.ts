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

/** Drizzle client bound to a D1 Sessions-API session, plus a `getBookmark`
 *  accessor for the raw session — the bookmark must be propagated back to the
 *  client on the response so subsequent requests can pin the session forward. */
export interface D1SessionClient {
  db: SqliteDb;
  /** Latest bookmark from the underlying D1 session, or null if none yet. */
  getBookmark: () => string | null;
}

/**
 * Open a D1 Sessions-API client. The constraint (`first-unconstrained` by
 * default) routes the first read to the nearest replica and pins every
 * subsequent statement on the same session to that replica with read-your-
 * writes consistency *within* the session. To extend RYOW across requests,
 * the caller should read the prior `x-d1-bookmark` header off the request,
 * pass it here as the constraint, and write `getBookmark()` back into the
 * response's `x-d1-bookmark` header (per the D1 docs).
 *
 * The wrapped drizzle client is otherwise identical to `createD1Client` —
 * routes don't need to know about Sessions API.
 */
export const createD1SessionClient = (
  binding: unknown,
  constraint: string = "first-unconstrained",
): D1SessionClient => {
  const session = (
    binding as {
      withSession: (c: string) => Parameters<typeof drizzleD1>[0] & {
        getBookmark?: () => string | null;
      };
    }
  ).withSession(constraint);
  return {
    db: drizzleD1(session, { schema }),
    getBookmark: () => session.getBookmark?.() ?? null,
  };
};

export const createBunSqliteClient = (path = "./.data/workeros.sqlite"): SqliteDb => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return drizzleBunSqlite({ client: db, schema });
};

export { schema };
