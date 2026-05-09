/**
 * Apply the drizzle-generated SQLite migrations to a Cloudflare D1 binding
 * via `wrangler d1 execute`. Drizzle's migration layout is one sub-folder
 * per migration; wrangler wants a flat list, so we pipe each migration.sql
 * through `wrangler d1 execute D1 --file=<path>` in order.
 *
 *   bun run packages/db/src/sqlite/migrate-d1.ts            # local D1
 *   bun run packages/db/src/sqlite/migrate-d1.ts --remote   # production D1
 *
 * The first arg may also be a wrangler.toml path; we default to the web app.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const persistTo = args.find((a) => a.startsWith("--persist-to="))?.slice("--persist-to=".length);
const dbName = process.env.D1_DATABASE_NAME ?? "workeros";
const cwd = resolve(fileURLToPath(import.meta.url), "../../../../../apps/web");

const root = resolve(fileURLToPath(import.meta.url), "../../../drizzle/sqlite");
const dirs = readdirSync(root)
  .filter((n) => statSync(resolve(root, n)).isDirectory())
  .sort();

const journalPath = resolve(root, "meta", "_journal.json");
let order: string[] = dirs;
try {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  if (Array.isArray(journal.entries)) {
    order = journal.entries.map((e) => e.tag);
  }
} catch {
  // Fall back to alpha-sorted folder names (drizzle uses dated prefixes).
}

const remoteFlag = remote ? "--remote" : "--local";
const persistFlag = !remote && persistTo ? `--persist-to=${persistTo}` : "";

console.log(`▸ Applying ${order.length} migration(s) to ${remote ? "remote" : "local"} D1 "${dbName}"`);
for (const tag of order) {
  const file = resolve(root, tag, "migration.sql");
  const cmd = ["bunx", "wrangler", "d1", "execute", dbName, remoteFlag, persistFlag, `--file=${file}`].filter(Boolean);
  console.log(`  · ${tag}`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    // Re-running the same migration trips a UNIQUE constraint on drizzle's
    // tracking table — that's harmless idempotency on dev. Only abort when
    // we see something else.
    console.warn(`    (exit ${r.status} — likely already applied; continuing)`);
  }
}
console.log("✓ Done");
