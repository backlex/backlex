/**
 * Run with: bun run packages/db/src/pg/migrate.ts
 * Requires DATABASE_URL.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle({ client });

// Make sure pgvector is available before running drizzle migrations.
await client`CREATE EXTENSION IF NOT EXISTS vector`;

await migrate(db, { migrationsFolder: "./drizzle/pg" });

await client.end();
console.log("✓ Postgres migrations applied");
