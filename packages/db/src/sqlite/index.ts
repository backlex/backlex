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

export const createBunSqliteClient = (path = "./.data/workeros.sqlite"): SqliteDb => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return drizzleBunSqlite({ client: db, schema });
};

export { schema };
