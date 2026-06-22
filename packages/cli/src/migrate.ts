import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_DB = "./.data/backlex.sqlite";

/**
 * Locate the Drizzle SQLite migrations folder. Two layouts are supported so the
 * same code works whether the CLI runs from monorepo source or an installed
 * package:
 *   - published: migrations are copied into the package at `drizzle/sqlite`
 *     (relative to the bundled `dist/backlex.js`).
 *   - in-repo: fall back to the sibling `@backlex/db` package's folder.
 */
const findMigrationsFolder = (): string => {
  const here = dirname(new URL(import.meta.url).pathname);
  // published: dist/backlex.js → ../drizzle/sqlite ; src/migrate.ts → ../drizzle/sqlite
  const packaged = resolve(here, "../drizzle/sqlite");
  // in-repo source: packages/cli/src/migrate.ts → ../../db/drizzle/sqlite
  const sibling = resolve(here, "../../db/drizzle/sqlite");
  return existsSync(packaged) ? packaged : sibling;
};

/**
 * Apply the SQLite migrations to `dbPath`. Bun-only: it uses `bun:sqlite`, so
 * it's loaded lazily and fails with a clear message under Node (where the rest
 * of the CLI — every API command — works fine). Most consumers talk to a hosted
 * backlex and never run this; it's for self-hosting on Bun.
 */
export const runMigrate = async (dbPath?: string): Promise<void> => {
  let Database: typeof import("bun:sqlite").Database;
  let drizzle: typeof import("drizzle-orm/bun-sqlite").drizzle;
  let drizzleMigrate: typeof import("drizzle-orm/bun-sqlite/migrator").migrate;
  try {
    ({ Database } = await import("bun:sqlite"));
    ({ drizzle } = await import("drizzle-orm/bun-sqlite"));
    ({ migrate: drizzleMigrate } = await import("drizzle-orm/bun-sqlite/migrator"));
  } catch {
    process.stderr.write(
      "backlex migrate requires Bun (it uses bun:sqlite). Run it with `bun backlex migrate`,\n" +
        "or for Postgres use `drizzle-kit` directly. Every other command runs under Node.\n",
    );
    process.exit(1);
  }

  const target = dbPath ?? process.env.DATABASE_PATH ?? DEFAULT_DB;
  mkdirSync(dirname(target), { recursive: true });
  const client = new Database(target, { create: true });
  client.exec("PRAGMA journal_mode = WAL");
  const db = drizzle({ client });
  drizzleMigrate(db, { migrationsFolder: findMigrationsFolder() });
  client.close();
  console.log(`✓ migrations applied → ${target}`);
};
