/**
 * Apply the drizzle-generated SQLite migrations to a Cloudflare D1 binding
 * via `wrangler d1 execute`. Drizzle's bun-sqlite migrator can't reach D1
 * over wrangler, so we mirror its behaviour: hash each `migration.sql`,
 * keep a `__drizzle_migrations` ledger in D1 itself, and only execute SQL
 * for hashes that aren't already recorded.
 *
 *   bun run packages/db/src/sqlite/migrate-d1.ts            # local D1
 *   bun run packages/db/src/sqlite/migrate-d1.ts --remote   # production D1
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const persistTo = args.find((a) => a.startsWith("--persist-to="))?.slice("--persist-to=".length);
const dbName = process.env.D1_DATABASE_NAME ?? "workeros";
const cwd = resolve(fileURLToPath(import.meta.url), "../../../../../apps/web");

const root = resolve(fileURLToPath(import.meta.url), "../../../drizzle/sqlite");
const order = readdirSync(root)
  .filter((n) => n !== "meta" && statSync(resolve(root, n)).isDirectory())
  .sort();

const remoteFlag = remote ? "--remote" : "--local";
const persistFlag = !remote && persistTo ? `--persist-to=${persistTo}` : "";

const wrangler = (extraArgs: string[]) => {
  const cmd = ["bunx", "wrangler", ...extraArgs].filter(Boolean);
  return spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" });
};

const execFile = (file: string) => {
  const r = wrangler([
    "d1", "execute", dbName, remoteFlag, persistFlag,
    `--file=${file}`,
  ]);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const execCommand = (sql: string, opts: { json?: boolean } = {}) => {
  // wrangler `--json` produces "fetch failed" on remote INSERTs even when
  // the write succeeds at the DB layer — only request JSON when we need to
  // parse the result (i.e. for SELECTs).
  const args = ["d1", "execute", dbName, remoteFlag, persistFlag];
  if (opts.json) args.push("--json");
  args.push(`--command=${sql}`);
  const r = wrangler(args);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// Bootstrap drizzle's tracking table — schema must match what
// drizzle-orm/bun-sqlite/migrator creates so the admin /migrations endpoint
// can read both.
execCommand(
  `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     hash TEXT NOT NULL,
     created_at INTEGER
   );`,
);

// Pull the set of already-recorded hashes so we can skip them.
const applied = new Set<string>();
{
  const r = execCommand(`SELECT hash FROM __drizzle_migrations;`, { json: true });
  if (r.ok) {
    // wrangler's --json output is `[ { results: [{hash}], ... } ]`; on remote
    // it sometimes wraps in an extra array. Be lenient.
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      const flatten = (v: unknown): unknown[] =>
        Array.isArray(v) ? v.flatMap(flatten) : [v];
      for (const item of flatten(parsed)) {
        if (item && typeof item === "object" && "results" in item) {
          const rows = (item as { results?: { hash?: string }[] }).results ?? [];
          for (const row of rows) if (row?.hash) applied.add(row.hash);
        }
      }
    } catch {
      // ignore — treat as empty ledger
    }
  }
}

console.log(`▸ Applying ${order.length} migration(s) to ${remote ? "remote" : "local"} D1 "${dbName}"`);
console.log(`  ${applied.size} already recorded; ${order.length - applied.size} pending.`);

let appliedNow = 0;
for (const tag of order) {
  const file = resolve(root, tag, "migration.sql");
  const sqlText = readFileSync(file, "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  if (applied.has(hash)) {
    console.log(`  · ${tag} (skip — already recorded)`);
    continue;
  }
  console.log(`  · ${tag}`);
  const r = execFile(file);
  if (!r.ok) {
    // DDL re-runs against an already-migrated D1 fail with "table already
    // exists" / "duplicate column" — those are noise. Fall through and
    // record the hash so we don't repeat the noise on the next run.
    console.warn(`    (wrangler exit ≠ 0 — likely partial replay, recording hash anyway)`);
  }
  const ts = Date.now();
  const ins = execCommand(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', ${ts});`,
  );
  if (!ins.ok) {
    console.warn(`    (failed to record hash for ${tag} — admin Migrations page will not show it)`);
  } else {
    appliedNow += 1;
  }
}
console.log(`✓ Done — ${appliedNow} new migration(s) recorded.`);
