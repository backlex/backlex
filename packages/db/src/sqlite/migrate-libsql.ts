/**
 * Apply hand-written SQLite migrations to a libSQL (Turso) database.
 *   LIBSQL_URL=libsql://my-db-org.turso.io \
 *   LIBSQL_AUTH_TOKEN=eyJ... \
 *     bun run packages/db/src/sqlite/migrate-libsql.ts
 *
 * Mirrors `migrate.ts` (Bun SQLite) and `migrate-d1.ts` (Cloudflare D1):
 * each `migration.sql` is hashed, `__drizzle_migrations` keeps the ledger,
 * statements run individually so a single failure points at the right
 * SQL. The only difference from `migrate.ts` is the client + the use of
 * `executeMultiple` for batches with their own `BEGIN…COMMIT` semantics.
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.LIBSQL_URL ?? process.argv[2];
if (!url) {
  console.error(
    "✘ LIBSQL_URL not set (and no positional arg). Example:\n" +
      "    LIBSQL_URL=libsql://my-db-org.turso.io LIBSQL_AUTH_TOKEN=… bun run packages/db/src/sqlite/migrate-libsql.ts",
  );
  process.exit(1);
}
const authToken = process.env.LIBSQL_AUTH_TOKEN;

const client = createClient(authToken ? { url, authToken } : { url });

const root = resolve(import.meta.dir, "../../drizzle/sqlite");
const order = readdirSync(root)
  .filter((n) => n !== "meta" && statSync(resolve(root, n)).isDirectory())
  .sort();

await client.execute(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  created_at INTEGER
)`);

const ledger = await client.execute("SELECT hash FROM __drizzle_migrations");
const applied = new Set<string>(
  ledger.rows.map((r) => r.hash as string),
);

console.log(`▸ Applying ${order.length} migration(s) to ${url}`);
console.log(`  ${applied.size} already recorded; ${order.length - applied.size} pending.`);

let newCount = 0;
for (const tag of order) {
  const file = resolve(root, tag, "migration.sql");
  const sqlText = readFileSync(file, "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  if (applied.has(hash)) {
    console.log(`  · ${tag} (skip — already recorded)`);
    continue;
  }
  console.log(`  · ${tag}`);
  const statements = sqlText
    .split(/-->\s*statement-breakpoint\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    try {
      await client.execute(stmt);
    } catch (err) {
      console.error(`✘ ${tag}: failed statement\n${stmt.slice(0, 200)}…`);
      throw err;
    }
  }
  await client.execute({
    sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    args: [hash, Date.now()],
  });
  newCount++;
}

console.log(`✓ Done — ${newCount} new migration(s) applied to ${url}`);
client.close();
