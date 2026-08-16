/**
 * One-off compaction of the D1 `__drizzle_migrations` ledger, plus the guard
 * that stops it from ever growing again.
 *
 *   bun run packages/db/src/sqlite/compact-d1-ledger.ts                    # dry run, local
 *   bun run packages/db/src/sqlite/compact-d1-ledger.ts --remote           # dry run, production
 *   bun run packages/db/src/sqlite/compact-d1-ledger.ts --remote --apply   # writes
 *
 * `c5bc07bb` stopped the loop that filled the table: the ledger read selected
 * every row, ~2.8 MB of it overflowed spawnSync's 1 MB `maxBuffer`, the
 * truncated JSON read as "nothing recorded", and all 120 migrations replayed —
 * appending 120 more rows for next time. Production reached 34,811 rows for
 * 121 distinct hashes across ~290 deploys.
 *
 * The rows are still there. That fix made them cheap to read (the query is
 * `SELECT DISTINCT`) but not cheap to store, and it removed the trigger
 * without removing the possibility. This script does both halves:
 *
 *   1. delete every row but the earliest per hash
 *   2. add a UNIQUE index on hash, so a duplicate cannot be inserted at all
 *
 * On the guard's blast radius, since adding a constraint to the path every
 * deploy walks deserves a straight answer: `migrate-d1.ts` reports a failed
 * ledger INSERT and keeps going (see `reportFailure("ledger INSERT", …)`), it
 * does not abort. So if the read ever breaks again, the duplicate INSERT is
 * rejected by the index, the rejection is printed, migrations replay once —
 * and the table does not grow, which is the part that made the old failure
 * compound instead of just repeat. The guard cannot fail a deploy that would
 * otherwise have succeeded.
 *
 * Not affected, checked rather than assumed: managed cloud instances have no
 * `__drizzle_migrations` table. They are migrated by the control plane's own
 * `_cloud_template_migrations` ledger, which is `name TEXT PRIMARY KEY` +
 * `INSERT OR IGNORE` and is bounded by the number of migration files.
 *
 * The wrangler plumbing below is duplicated from `migrate-d1.ts` rather than
 * shared: that file is a script with top-level side effects (it migrates on
 * import), and it is the single path every deploy takes. Refactoring it to
 * export helpers is a change to the deploy path in service of a one-off
 * maintenance task. The two invariants that duplication could drift on — a
 * space-free `--command=` and a raised `maxBuffer` — are pinned for BOTH files
 * by `apps/web/tests/migrate-d1-ledger.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEDGER_COUNT_SQL,
  LEDGER_DEDUPE_SQL,
  LEDGER_GUARD_INDEX,
  LEDGER_GUARD_SQL,
  LEDGER_INDEX_LIST_SQL,
} from "./ledger-sql";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const apply = args.includes("--apply");
const persistTo = args.find((a) => a.startsWith("--persist-to="))?.slice("--persist-to=".length);
const configPath = args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
const cwd = resolve(fileURLToPath(import.meta.url), "../../../../../apps/web");

// Same derivation as migrate-d1.ts, and for the same reason: `wrangler d1
// execute <name>` resolves <name> against the ACCOUNT, not against --config,
// so a wrong name silently operates on a different database that happens to
// exist. Deleting rows from the wrong D1 is a worse version of that mistake
// than migrating one, so the name is derived, printed, and never defaulted
// silently.
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
    `⚠ D1_DATABASE_NAME="${dbName}" overrides "${configDbName}" from ${configFile} — compacting "${dbName}".`,
  );
}

const remoteFlag = remote ? "--remote" : "--local";
const persistFlag = !remote && persistTo ? `--persist-to=${persistTo}` : "";
const configFlag = configPath ? `--config=${resolve(process.cwd(), configPath)}` : "";

// maxBuffer: see migrate-d1.ts. Exceeding the 1 MB default is silent in the
// worst shape — status null, truncated stdout, EMPTY stderr — which is the bug
// this script exists to clean up after.
const wrangler = (extraArgs: string[]) => {
  const cmd = ["bunx", "wrangler", configFlag, ...extraArgs].filter(Boolean);
  return spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI CSI introducer IS a control character — matching it is the point
const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, "");
const redact = (line: string): string => line.replace(/(https?:\/\/\S+?)\?\S*/g, "$1?<redacted>");
const errorLines = (stderr: string, max = 5): string[] => {
  const lines = stripAnsi(stderr)
    .split("\n")
    .map((l) => redact(l.trim()))
    .filter((l) => l.length > 0 && !/^[─━-]+$/.test(l));
  const flagged = lines.filter((l) => /✘|\[ERROR\]|error/i.test(l));
  return (flagged.length > 0 ? flagged : lines.slice(-max)).slice(0, max);
};

const tmpRoot = mkdtempSync(join(tmpdir(), "backlex-compact-d1-"));
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

/** Writes go through `--file=` (R2 upload + /import), which returns statistics
 *  only — never rows. Fine for DELETE/CREATE INDEX, useless for SELECT. */
const execSqlWrite = (sql: string) => {
  const path = join(tmpRoot, `q-${randomBytes(6).toString("hex")}.sql`);
  writeFileSync(path, sql);
  const r = wrangler(["d1", "execute", dbName, remoteFlag, persistFlag, `--file=${path}`]);
  try { rmSync(path, { force: true }); } catch {}
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** Reads go through `--command=` (the /query API), which returns row data. */
const execSqlRead = (sql: string) => {
  const argv = ["d1", "execute", dbName, remoteFlag, persistFlag, "--json", `--command=${sql}`];
  const r = wrangler(argv);
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    argv,
    spawnError: r.error ? `${(r.error as NodeJS.ErrnoException).code ?? ""} ${r.error.message}`.trim() : "",
  };
};

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

/** Rows out of a wrangler `--json` result, or null when unrecognisable.
 *  null and [] are kept distinct on purpose: "the read failed" and "the table
 *  is empty" are the two things that got confused into a 290-deploy loop. */
const parseRows = (stdout: string): Record<string, unknown>[] | null => {
  const parsed = tryParseJsonTail(stdout);
  if (parsed === null) return null;
  const flatten = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(flatten) : [v]);
  let sawResults = false;
  const out: Record<string, unknown>[] = [];
  for (const item of flatten(parsed)) {
    if (item && typeof item === "object" && "results" in item) {
      sawResults = true;
      out.push(...((item as { results?: Record<string, unknown>[] }).results ?? []));
    }
  }
  return sawResults ? out : null;
};

/** Read one row, or exit. A read that fails must never be mistaken for a
 *  result — that mistake is the whole reason this table needs compacting. */
const readOne = (label: string, sql: string): Record<string, unknown> => {
  const r = execSqlRead(sql);
  const rows = r.ok ? parseRows(r.stdout) : null;
  if (rows === null) {
    console.error(`✘ ${label} FAILED — refusing to continue.`);
    if (r.spawnError) console.error(`  spawn: ${r.spawnError}`);
    for (const l of errorLines(r.stderr)) console.error(`  ${l}`);
    console.error(`  argv: ${r.argv.join(" ")}`);
    process.exit(1);
  }
  return rows[0] ?? {};
};

const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toLocaleString("en-US");

console.log(`\n▸ D1 ledger compaction — database "${dbName}" (${remote ? "REMOTE" : "local"})`);

const before = readOne("ledger count", LEDGER_COUNT_SQL);
const beforeTotal = num(before.total);
const beforeHashes = num(before.hashes);
const indexRows = execSqlRead(LEDGER_INDEX_LIST_SQL);
const hadGuard = (parseRows(indexRows.stdout) ?? []).some((r) => r.name === LEDGER_GUARD_INDEX);

console.log(`  rows:            ${fmt(beforeTotal)}`);
console.log(`  distinct hashes: ${fmt(beforeHashes)}`);
console.log(`  duplicates:      ${fmt(beforeTotal - beforeHashes)}`);
console.log(`  guard index:     ${hadGuard ? "present" : "absent"}`);

if (beforeTotal === beforeHashes && hadGuard) {
  console.log("\n✓ Already compacted and guarded — nothing to do.\n");
  process.exit(0);
}

if (!apply) {
  console.log("\n  DRY RUN — nothing written. Re-run with --apply to:");
  if (beforeTotal > beforeHashes) console.log(`    · delete ${fmt(beforeTotal - beforeHashes)} duplicate rows (keep the earliest per hash)`);
  if (!hadGuard) console.log(`    · create UNIQUE INDEX ${LEDGER_GUARD_INDEX} on (hash)`);
  console.log("");
  process.exit(0);
}

if (beforeTotal > beforeHashes) {
  console.log(`\n  deleting ${fmt(beforeTotal - beforeHashes)} duplicate rows…`);
  const del = execSqlWrite(LEDGER_DEDUPE_SQL);
  if (!del.ok) {
    console.error("✘ dedupe FAILED — the table is unchanged (single statement, nothing partial).");
    for (const l of errorLines(del.stderr)) console.error(`  ${l}`);
    process.exit(1);
  }
}

// After the delete, never before: on a table that still holds duplicates this
// fails, and the failure would be the correct answer to the wrong question.
console.log(`  creating ${LEDGER_GUARD_INDEX}…`);
const guard = execSqlWrite(LEDGER_GUARD_SQL);
if (!guard.ok) {
  console.error("✘ guard index FAILED — duplicates are gone but the table can still regrow.");
  for (const l of errorLines(guard.stderr)) console.error(`  ${l}`);
  process.exit(1);
}

const after = readOne("post-compaction count", LEDGER_COUNT_SQL);
const afterTotal = num(after.total);
const afterHashes = num(after.hashes);
const guardNow = (parseRows(execSqlRead(LEDGER_INDEX_LIST_SQL).stdout) ?? []).some((r) => r.name === LEDGER_GUARD_INDEX);

console.log(`\n  rows:            ${fmt(beforeTotal)} → ${fmt(afterTotal)}`);
console.log(`  distinct hashes: ${fmt(beforeHashes)} → ${fmt(afterHashes)}`);
console.log(`  guard index:     ${guardNow ? "present" : "ABSENT"}`);

// The one thing that must not have happened is losing a hash. Assert it
// explicitly rather than trusting the row count to imply it.
const problems: string[] = [];
if (afterHashes !== beforeHashes) problems.push(`distinct hashes changed (${beforeHashes} → ${afterHashes}) — a migration record was LOST`);
if (afterTotal !== afterHashes) problems.push(`rows (${afterTotal}) still exceed distinct hashes (${afterHashes})`);
if (!guardNow) problems.push("guard index is not present");

if (problems.length > 0) {
  console.error("\n✘ verification FAILED:");
  for (const p of problems) console.error(`  · ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`\n✓ Compacted: ${fmt(beforeTotal - afterTotal)} rows removed, all ${fmt(afterHashes)} hashes intact, regrowth blocked.\n`);
