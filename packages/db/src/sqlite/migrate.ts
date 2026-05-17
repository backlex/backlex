/**
 * Apply hand-written SQLite migrations to a local Bun SQLite file.
 *   bun run packages/db/src/sqlite/migrate.ts [path]
 * Default path: ./.data/workeros.sqlite
 *
 * Mirrors `migrate-d1.ts`'s contract: each `migration.sql` is hashed,
 * `__drizzle_migrations` keeps the ledger, and we only execute SQL for
 * hashes that aren't already recorded. Drizzle's native bun-sqlite
 * migrator expects a `meta/_journal.json` we don't generate (CLAUDE.md:
 * "drizzle migrations are hand-written SQL in this repo"), so we run
 * our own loop the same way migrate-d1.ts does for Cloudflare D1.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const path = process.argv[2] ?? "./.data/workeros.sqlite";
mkdirSync(dirname(path), { recursive: true });

const db = new Database(path, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const root = resolve(import.meta.dir, "../../drizzle/sqlite");
const order = readdirSync(root)
  .filter((n) => n !== "meta" && statSync(resolve(root, n)).isDirectory())
  .sort();

db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  created_at INTEGER
)`);

const applied = new Set<string>(
  (db.query("SELECT hash FROM __drizzle_migrations").all() as { hash: string }[]).map(
    (r) => r.hash,
  ),
);

console.log(`▸ Applying ${order.length} migration(s) to ${path}`);
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
  // `--> statement-breakpoint` lines parse as SQL comments (start with
  // `--`), so the whole file goes through `exec` as one batch. We split
  // anyway so a failing statement points at the right SQL.
  const statements = sqlText
    .split(/-->\s*statement-breakpoint\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err) {
      console.error(`✘ ${tag}: failed statement\n${stmt.slice(0, 200)}…`);
      throw err;
    }
  }
  db.run(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    [hash, Date.now()],
  );
  newCount++;
}

db.close();
console.log(`✓ Done — ${newCount} new migration(s) applied to ${path}`);
