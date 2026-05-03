import { drizzle as drizzleD1, type DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle as drizzleBunSqlite, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";

export type SqliteDb =
  | DrizzleD1Database<typeof schema>
  | BunSQLiteDatabase<typeof schema>;

/**
 * `binding` should be a Cloudflare D1Database. We accept `unknown` here so
 * this package compiles without depending on @cloudflare/workers-types — the
 * caller (apps/api) already pulls those types in.
 */
export const createD1Client = (binding: unknown): SqliteDb =>
  drizzleD1(binding as Parameters<typeof drizzleD1>[0], { schema });

export const createBunSqliteClient = (path = "./.data/workeros.sqlite"): SqliteDb => {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return drizzleBunSqlite(db, { schema });
};

export { schema };
