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
 *
 * The target database name comes from the config's first `[[d1_databases]]`
 * entry (override with `D1_DATABASE_NAME`), so pointing `--config` at another
 * deploy's wrangler.toml is enough to migrate that deploy's D1.
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
const cwd = resolve(fileURLToPath(import.meta.url), "../../../../../apps/web");

// `wrangler d1 execute <name>` resolves <name> against the ACCOUNT, not
// against `--config` — so a wrong name silently migrates a different
// database that happens to exist (this is how the playground D1 drifted 5
// migrations behind while every build "succeeded" against the admin one).
// Derive the name from the config we were pointed at instead.
const configFile = resolve(process.cwd(), configPath ?? join(cwd, "wrangler.toml"));
const dbNameFromConfig = (file: string): string | null => {
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as {
      d1_databases?: { database_name?: string }[];
    };
    return parsed.d1_databases?.[0]?.database_name ?? null;
  } catch {
    return null;
  }
};
const configDbName = dbNameFromConfig(configFile);
const dbName = process.env.D1_DATABASE_NAME ?? configDbName ?? "workeros";
if (configDbName && dbName !== configDbName) {
  console.warn(
    `⚠ D1_DATABASE_NAME="${dbName}" overrides "${configDbName}" from ${configFile} — migrating "${dbName}".`,
  );
}

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

// `maxBuffer` defaults to 1 MB, and exceeding it is SILENT in the shape that
// matters here: spawnSync returns `status: null`, `error.code === "ENOBUFS"`,
// stdout truncated mid-JSON, and **stderr empty**. A ledger SELECT over a table
// that had grown to 34,811 rows produced ~2.8 MB, so every remote read came
// back unparseable with nothing to explain it. 64 MB is far past any plausible
// ledger while still bounded.
const wrangler = (extraArgs: string[]) => {
  const cmd = ["bunx", "wrangler", configFlag, ...extraArgs].filter(Boolean);
  return spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
};

// Pull the lines from a wrangler stderr that actually explain a failure.
//
// Taking the *first* line was wrong: on a remote `--file=` write wrangler leads
// with `▲ [WARNING] ⚠️ This process may take some time, during which your D1
// database will be unavailable to serve queries.` — the import API announcing
// itself, not the error. It also colours its output, so the line starts with an
// ANSI escape rather than the `▲` a naive filter looks for. Strip the escapes,
// prefer lines that carry an error marker, and fall back to the TAIL rather
// than the head, because wrangler puts the verdict last.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI CSI introducer IS a control character — matching it is the point
const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, "");

// These lines land in a CI build log that outlives the run. The remote import
// path signs an R2 upload URL, and a signed URL is a credential in query-string
// form — wrangler does not print one today, but a log line is a bad place to
// find out it started. Drop every query string before anything is echoed.
const redact = (line: string): string => line.replace(/(https?:\/\/\S+?)\?\S*/g, "$1?<redacted>");

const errorLines = (stderr: string, max = 5): string[] => {
  const lines = stripAnsi(stderr)
    .split("\n")
    .map((l) => redact(l.trim()))
    .filter((l) => l.length > 0 && !/^[─━-]+$/.test(l));
  const flagged = lines.filter((l) => /✘|\[ERROR\]|error/i.test(l));
  return (flagged.length > 0 ? flagged : lines.slice(-max)).slice(0, max);
};

const execFile = (file: string) => {
  const r = wrangler([
    "d1", "execute", dbName, remoteFlag, persistFlag,
    `--file=${file}`,
  ]);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// Holds temp .sql files used by execSql below; cleaned up on exit.
const tmpRoot = mkdtempSync(join(tmpdir(), "backlex-migrate-d1-"));
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
  // `spawnError` is the case with no exit code and no stderr — ENOBUFS being
  // the one that actually bit. Surfaced separately so a failed READ can never
  // again be mistaken for an empty ledger.
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    argv: args,
    spawnError: r.error ? `${(r.error as NodeJS.ErrnoException).code ?? ""} ${r.error.message}`.trim() : "",
  };
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

// Written without a single space on purpose. On the Cloudflare Builds runner
// this argv element reached wrangler split into four — it answered
// `Unknown arguments: hash, FROM, __drizzle_migrations;` on every build — so
// the ledger never parsed and all 120 migrations replayed each deploy, which
// was ~15 of a 16-minute build (the whole vite build is 12 seconds). It could
// not be reproduced locally: spawnSync passes the argv intact under bun 1.3.14
// and 1.4.0-canary on macOS, wrangler is 4.123.0 on both sides, and `--remote`
// parses fine here. What every WORKING wrangler call in this file has in common
// is that no argv element contains a space (`--file=` takes a temp path); this
// was the only one that did. SQLite treats `/**/` as whitespace, so the query
// is now a single token no re-splitting can break.
//
// DISTINCT is load-bearing, not tidiness. Only the SET of applied hashes is
// ever consulted, but the table accumulates one row per hash per deploy because
// nothing dedupes it — production reached 34,811 rows for 121 distinct hashes.
// Selecting them all produced ~2.8 MB of stdout, blew spawnSync's 1 MB
// maxBuffer, and returned truncated JSON with an empty stderr, which read as an
// empty ledger, which replayed all 120 migrations, which appended 120 more
// rows. DISTINCT takes the result back to ~121 rows and breaks that loop at the
// source; the raised maxBuffer is the belt to this pair of braces.
const LEDGER_SELECT = `SELECT/**/DISTINCT/**/hash/**/FROM/**/__drizzle_migrations;`;

const readLedger = (): Set<string> => {
  const r = execSqlRead(LEDGER_SELECT);
  // Don't trust the exit code: wrangler can exit ≠ 0 on remote D1 even
  // when the SELECT itself succeeded and stdout carries the JSON payload.
  // Try to parse stdout regardless.
  const parsed = parseLedgerHashes(r.stdout);
  if (parsed) return parsed;

  // A read that FAILED and a ledger that is genuinely EMPTY produce the same
  // `new Set()` here, and the caller cannot tell them apart — it just replays
  // everything. That silence is why this went unnoticed across ~290 deploys:
  // the ENOBUFS truncation left `status: null` and an EMPTY stderr, so the old
  // `if (!r.ok && r.stderr)` guard printed nothing at all. Never let a failed
  // read pass as an empty one again — say so unconditionally, and say why.
  console.warn(`  ⚠ ledger read FAILED — treating as empty, so every migration will replay.`);
  if (r.spawnError) console.warn(`    spawn error: ${r.spawnError}`);
  if (r.stderr.trim()) console.warn(`    wrangler stderr: ${redact(stripAnsi(r.stderr).trim().split("\n")[0] ?? "")}`);
  if (!r.spawnError && !r.stderr.trim()) {
    console.warn(`    (no stderr and no spawn error — stdout was ${r.stdout.length} bytes, likely truncated)`);
  }
  // The argv is the evidence that matters if this ever regresses: it says
  // whether wrangler was handed one token or several.
  console.warn(`    argv: ${JSON.stringify(r.argv)}`);
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

// The same wrangler failure repeats for all 120 migrations, so the detail is
// printed once. Without this the log carries 120 identical stack-like blocks
// and the one line that matters is impossible to spot.
let loggedApplyFailure = false;
let loggedInsertFailure = false;
let loggedInsertOk = false;
const reportFailure = (label: string, stderr: string, already: boolean): boolean => {
  if (already) return true;
  const lines = errorLines(stderr);
  console.warn(`    ${label} — wrangler said:`);
  for (const l of lines.length > 0 ? lines : ["(stderr was empty)"]) console.warn(`      ${l}`);
  return true;
};

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
    //
    // Print wrangler's own words, though: swallowing them is how a genuine
    // write failure hid behind this "probably harmless" message for months.
    // The ledger stayed empty on every remote deploy, so all 120 migrations
    // replayed each time, and the reason was never in the log to read.
    console.warn(`    (wrangler exit ≠ 0 — likely partial replay, recording hash anyway)`);
    loggedApplyFailure = reportFailure("migration apply", r.stderr, loggedApplyFailure);
  }
  const ts = Date.now();
  // Don't gate on exit status here either — wrangler can exit ≠ 0 even when
  // the INSERT was committed. We re-read the ledger after the loop and
  // report the actual recorded delta.
  const ins = execSqlWrite(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', ${ts});`,
  );
  if (!ins.ok) {
    loggedInsertFailure = reportFailure("ledger INSERT", ins.stderr, loggedInsertFailure);
  } else if (!loggedInsertOk) {
    // The harder case to debug is the INSERT that reports SUCCESS and still
    // leaves the ledger empty, which is exactly what remote does today: no
    // `ledger INSERT` failure line has ever appeared, yet the next build reads
    // back `0 already recorded`. The /import endpoint answers with statistics
    // (rows read/written), so print them once — a write that claims zero rows
    // and a write that claims one point at very different bugs.
    loggedInsertOk = true;
    const stats = stripAnsi(ins.stdout)
      .split("\n")
      .map((l) => redact(l.trim()))
      .filter((l) => l.length > 0)
      .slice(-6);
    console.warn(`    (first ledger INSERT reported success — wrangler stdout:)`);
    for (const l of stats.length > 0 ? stats : ["(stdout was empty)"]) console.warn(`      ${l}`);
  }
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
