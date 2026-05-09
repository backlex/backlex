import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_DB = "./.data/workeros.sqlite";

const findMigrationsFolder = (): string => {
  // Resolve relative to this file:
  // packages/cli/src/migrate.ts → ../../db/drizzle/sqlite
  const here = dirname(new URL(import.meta.url).pathname);
  return resolve(here, "../../db/drizzle/sqlite");
};

export const runMigrate = async (dbPath?: string): Promise<void> => {
  const target = dbPath ?? process.env.DATABASE_PATH ?? DEFAULT_DB;
  mkdirSync(dirname(target), { recursive: true });
  const client = new Database(target, { create: true });
  client.exec("PRAGMA journal_mode = WAL");
  const db = drizzle({ client });
  const folder = findMigrationsFolder();
  drizzleMigrate(db, { migrationsFolder: folder });
  client.close();
  console.log(`✓ migrations applied → ${target}`);
};
