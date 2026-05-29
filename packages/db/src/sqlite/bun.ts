/**
 * Bun-only SQLite client. Lives in its own subpath so the top-level
 * `@backlex/db/sqlite` module can be loaded on edge runtimes (Vercel Edge /
 * Netlify Deno Deploy) that don't ship `bun:sqlite`. Import this file via
 * dynamic `await import("@backlex/db/sqlite/bun")` from a code path that
 * has already decided it's running on Bun (or under Vite + miniflare for
 * dev — the Worker bundle aliases `bun:sqlite` to a throwing shim).
 */
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";
import type { SqliteDb } from "./index";

export const createBunSqliteClient = (
  path = "./.data/workeros.sqlite",
): SqliteDb => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return drizzleBunSqlite({ client: db, schema });
};
