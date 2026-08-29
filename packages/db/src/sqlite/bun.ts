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
  path = "./.data/backlex.sqlite",
  opts: { enforceForeignKeys?: boolean } = {},
): SqliteDb => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  // `PRAGMA foreign_keys` defaults to OFF in SQLite and is per-CONNECTION, so
  // the constraints this schema declares were simply not applied on the
  // request path. The only place they were ever on is `sqlite/migrate.ts`,
  // which sets the pragma on the MIGRATING connection — and a stray
  // `PRAGMA foreign_keys = ON;` at the end of one migration file meant a
  // first boot happened to end with them enabled and every boot afterwards
  // did not, because auto-migrate applies no files the second time.
  //
  // That difference is what made an app-plane identity's reach depend on how
  // many times the process had restarted. D1 and Postgres enforce
  // unconditionally, which is why the same request answered 500 there and 201
  // here.
  //
  // This is defence in depth, not the fix — the authorization gates are.
  // Opt-out exists because an existing self-host may hold rows violating a
  // constraint that was declared and never enforced, and that install needs to
  // boot while it cleans up rather than discovering the problem as a crash.
  if (opts.enforceForeignKeys !== false) {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return drizzleBunSqlite({ client: db, schema });
};
