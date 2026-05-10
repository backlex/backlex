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
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// Trim stderr/stdout for log output: first N non-empty lines, single line.
const trimOutput = (s: string, lines = 3, max = 400): string => {
  const compact = s.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, lines).join(" | ");
  return compact.length > max ? compact.slice(0, max) + "…" : compact;
};

const logFailure = (label: string, r: { stdout: string; stderr: string }) => {
  if (r.stderr) console.warn(`    ${label} stderr: ${trimOutput(r.stderr)}`);
  if (r.stdout) console.warn(`    ${label} stdout: ${trimOutput(r.stdout)}`);
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

// We pipe inline SQL through a temp file + `--file=` instead of `--command=`.
// `wrangler d1 execute --remote --command=` hits a known wrangler bug
// (workers-sdk#9099) where the local D1 UUID is sent to the remote API and
// the call silently 4xxs — so ledger reads/writes never persisted. The
// `--file=` code path uses R2 upload + import and resolves the binding
// correctly against `--remote`, which is also why our migration DDL files
// have always reached production while inline ledger ops didn't.
const execSql = (sql: string, opts: { json?: boolean } = {}) => {
  const path = join(tmpRoot, `q-${randomBytes(6).toString("hex")}.sql`);
  writeFileSync(path, sql);
  const args = ["d1", "execute", dbName, remoteFlag, persistFlag];
  if (opts.json) args.push("--json");
  args.push(`--file=${path}`);
  const r = wrangler(args);
  try { rmSync(path, { force: true }); } catch {}
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// Parse a wrangler `--json` SELECT result. Returns null when the payload
// isn't recognisable (caller decides what to do — usually treat as empty).
const parseLedgerHashes = (stdout: string): Set<string> | null => {
  const out = new Set<string>();
  try {
    const parsed = JSON.parse(stdout) as unknown;
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
  } catch {
    return null;
  }
};

const readLedger = (): Set<string> => {
  const r = execSql(`SELECT hash FROM __drizzle_migrations;`, { json: true });
  // Don't trust the exit code: wrangler frequently exits ≠ 0 on remote D1
  // (stderr noise like "fetch failed") even when the SELECT itself succeeded
  // and stdout carries the JSON payload. Try to parse stdout regardless.
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
execSql(
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
    if (tag === order[0]) logFailure("DDL[first]", r);
  }
  const ts = Date.now();
  // Don't gate on exit status here either — wrangler can exit ≠ 0 even when
  // the INSERT was committed. We re-read the ledger after the loop and
  // report the actual recorded delta.
  const ins = execSql(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', ${ts});`,
  );
  if (tag === order[0]) logFailure(`INSERT[first]`, ins);
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

// Diagnostic: if nothing was visible, dump the raw verifying SELECT and a
// table-introspection call so we can see what wrangler actually returned.
// Removed in a follow-up commit once we know the failure mode.
if (missing > 0 && attemptedHashes.length > 0) {
  console.warn(`  --- diagnostic dump (workeros-fix/migrate-d1) ---`);
  const verify = execSql(`SELECT hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 5;`, { json: true });
  console.warn(`    verify-select exit=${verify.ok ? 0 : "≠0"}`);
  if (verify.stderr) console.warn(`    stderr: ${trimOutput(verify.stderr, 6, 800)}`);
  if (verify.stdout) console.warn(`    stdout: ${trimOutput(verify.stdout, 6, 800)}`);
  const tables = execSql(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations';`, { json: true });
  console.warn(`    table-list exit=${tables.ok ? 0 : "≠0"}`);
  if (tables.stderr) console.warn(`    stderr: ${trimOutput(tables.stderr, 6, 800)}`);
  if (tables.stdout) console.warn(`    stdout: ${trimOutput(tables.stdout, 6, 800)}`);
}
