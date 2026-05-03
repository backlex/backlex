/**
 * Apply SQLite migrations to a local Bun SQLite file.
 *   bun run packages/db/src/sqlite/migrate.ts [path]
 * Default path: ./.data/workeros.sqlite
 */
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const path = process.argv[2] ?? "./.data/workeros.sqlite";
mkdirSync(dirname(path), { recursive: true });

const client = new Database(path, { create: true });
client.exec("PRAGMA journal_mode = WAL");
const db = drizzle({ client });

const migrationsFolder = resolve(import.meta.dir, "../../drizzle/sqlite");
migrate(db, { migrationsFolder });

client.close();
console.log(`✓ SQLite migrations applied to ${path}`);
