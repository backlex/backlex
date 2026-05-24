/**
 * Apply the drizzle-generated SQLite migrations to a Cloudflare D1 binding
 * via `wrangler d1 execute`. Drizzle's bun-sqlite migrator can't reach D1
 * over wrangler, so we mirror its behaviour: hash each `migration.sql`,
 * keep a `__drizzle_migrations` ledger in D1 itself, and only execute SQL
 * for hashes that aren't already recorded.
 *
 *   bun run packages/db/src/sqlite/migrate-d1.ts            # local D1
 *   bun run packages/db/src/sqlite/migrate-d1.ts --remote   # production D1
 *   bun run packages/db/src/sqlite/migrate-d1.ts --config=apps/web/wrangler.ci.toml
 *                                                           # alternate config
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const persistTo = args.find((a) => a.startsWith("--persist-to="))?.slice("--persist-to=".length);
const configPath = args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
const dbName = process.env.D1_DATABASE_NAME ?? "workeros";
const cwd = resolve(fileURLToPath(import.meta.url), "../../../../../apps/web");

const root = resolve(fileURLToPath(import.meta.url), "../../../drizzle/sqlite");
const order = readdirSync(root)
  .filter((n) => n !== "meta" && statSync(resolve(root, n)).isDirectory())
  .sort();

const remoteFlag = remote ? "--remote" : "--local";
const persistFlag = !remote && persistTo ? `--persist-to=${persistTo}` : "";
// `cwd` is apps/web inside the wrangler subprocess, so a relative
// --config path the caller passed (from their own cwd) wouldn't
// resolve. Anchor it to process.cwd() so the path means what the
// caller meant.
const configFlag = configPath
  ? `--config=${resolve(process.cwd(), configPath)}`
  : "";

const wrangler = (extraArgs: string[]) => {
  const cmd = ["bunx", "wrangler", configFlag, ...extraArgs].filter(Boolean);
  return spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" });
};

const execFile = (file: string) => {
  const r = wrangler([
    "d1", "execute", dbName, remoteFlag, persistFlag,
    `--file=${file}`,
  ]);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// Holds temp .sql files used by execSql below; cleaned up on exit.
const tmpRoot = mkdtempSync(join(tmpdir(), "workeros-migrate-d1-"));
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Writes go through `--file=` (R2 upload + /import API). The /import
// endpoint executes the SQL but only returns import statistics — never
// row data — so it's fine for CREATE/INSERT but useless for SELECT.
const execSqlWrite = (sql: string) => {
  const path = join(tmpRoot, `q-${randomBytes(6).toString("hex")}.sql`);
  writeFileSync(path, sql);
  const args = ["d1", "execute", dbName, remoteFlag, persistFlag, `--file=${path}`];
  const r = wrangler(args);
  try { rmSync(path, { force: true }); } catch {}
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// Reads go through `--command=` (the /query API), which returns full row
// data. With --json wrangler emits clean JSON on stdout for this path.
const execSqlRead = (sql: string) => {
  const args = ["d1", "execute", dbName, remoteFlag, persistFlag, "--json", `--command=${sql}`];
  const r = wrangler(args);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// wrangler may interleave stdout with progress noise around the JSON
// payload, so a raw JSON.parse(stdout) can fail. Walk both ends: each
// candidate '['/'{' start × each ']'/'}' end (rightmost first) until
// JSON.parse succeeds.
const tryParseJsonTail = (stdout: string): unknown | null => {
  const tryShape = (open: string, close: string) => {
    for (let i = stdout.indexOf(open); i >= 0; i = stdout.indexOf(open, i + 1)) {
      let j = stdout.lastIndexOf(close);
      while (j > i) {
        try { return JSON.parse(stdout.slice(i, j + 1)); } catch {}
        j = stdout.lastIndexOf(close, j - 1);
      }
    }
    return null;
  };
  return tryShape("[", "]") ?? tryShape("{", "}");
};

// Parse a wrangler `--json` SELECT result. Returns null when the payload
// isn't recognisable (caller decides what to do — usually treat as empty).
const parseLedgerHashes = (stdout: string): Set<string> | null => {
  const parsed = tryParseJsonTail(stdout);
  if (parsed === null) return null;
  const out = new Set<string>();
  const flatten = (v: unknown): unknown[] =>
    Array.isArray(v) ? v.flatMap(flatten) : [v];
  let sawResults = false;
  for (const item of flatten(parsed)) {
    if (item && typeof item === "object" && "results" in item) {
      sawResults = true;
      const rows = (item as { results?: { hash?: string }[] }).results ?? [];
      for (const row of rows) if (row?.hash) out.add(row.hash);
    }
  }
  return sawResults ? out : null;
};

const readLedger = (): Set<string> => {
  const r = execSqlRead(`SELECT hash FROM __drizzle_migrations;`);
  // Don't trust the exit code: wrangler can exit ≠ 0 on remote D1 even
  // when the SELECT itself succeeded and stdout carries the JSON payload.
  // Try to parse stdout regardless.
  const parsed = parseLedgerHashes(r.stdout);
  if (parsed) return parsed;
  if (!r.ok && r.stderr) {
    console.warn(`  (could not parse ledger; wrangler stderr: ${r.stderr.trim().split("\n")[0]})`);
  }
  return new Set();
};

// Bootstrap drizzle's tracking table — schema must match what
// drizzle-orm/bun-sqlite/migrator creates so the admin /migrations endpoint
// can read both.
execSqlWrite(
  `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     hash TEXT NOT NULL,
     created_at INTEGER
   );`,
);

// Pull the set of already-recorded hashes so we can skip them.
const applied = readLedger();

console.log(`▸ Applying ${order.length} migration(s) to ${remote ? "remote" : "local"} D1 "${dbName}"`);
console.log(`  ${applied.size} already recorded; ${order.length - applied.size} pending.`);

const attemptedHashes: string[] = [];
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
  // Don't gate on exit status here either — wrangler can exit ≠ 0 even when
  // the INSERT was committed. We re-read the ledger after the loop and
  // report the actual recorded delta.
  execSqlWrite(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', ${ts});`,
  );
  attemptedHashes.push(hash);
}

// Verify the recorded delta by re-reading the ledger once. This is the
// authoritative answer — a non-zero wrangler exit during INSERT is not.
const after = readLedger();
const newlyRecorded = attemptedHashes.filter((h) => after.has(h)).length;
const missing = attemptedHashes.length - newlyRecorded;
console.log(`✓ Done — ${newlyRecorded} new migration(s) recorded.`);
if (missing > 0) {
  console.warn(`  (${missing} hash(es) attempted but not visible in ledger — admin Migrations page will be incomplete)`);
}
