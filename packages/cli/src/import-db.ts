/**
 * `backlex import-db` — migrate an external database INTO backlex.
 *
 * The pump runs HERE, client-side: the CLI connects to the *source* database
 * (usually firewalled away from the backlex server), introspects it, and
 * copies rows up through the admin ingest endpoint. Three-step flow, plan
 * reviewed as a file between steps:
 *
 *   backlex import-db inspect --source postgres://…          # what's there
 *   backlex import-db plan    --source … --out migration.json # editable plan
 *   backlex import-db run     migration.json --source …       # copy + verify
 *
 * `run` is resumable: progress (per-table PK cursor) persists in
 * `<plan>.state.json`, and the server ingest is idempotent
 * (INSERT … ON CONFLICT DO NOTHING), so re-running after a crash is safe.
 * Primary keys are preserved verbatim — that's what keeps the source's FK
 * values valid in the target without a remap table.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import {
  buildPlan,
  collectionPayloadFor,
  collectionShapeMismatch,
  createMysqlSource,
  createPgSource,
  createSqliteFileSource,
  parsePlan,
  transformRow,
  type MigrationPlan,
  type SourceConnector,
  type SourceQuery,
} from "@backlex/migrate";
import { flag, has, resolveContext, type Context } from "./client";

/** Injectable source factory — tests swap in a pglite-backed connector
 *  (pglite has no TCP listener for postgres.js to dial). */
export interface ImportDbDeps {
  openSource?: (url: string) =>
    | { connector: SourceConnector; close: () => Promise<unknown> }
    | Promise<{ connector: SourceConnector; close: () => Promise<unknown> }>;
}

const HELP = `backlex import-db <command> — migrate an external database into backlex

  inspect --source <postgres-url> [--json]
      List the source's tables (name, ~rows, PK, warnings).

  plan --source <postgres-url> [--tables a,b,…] [--out <file>]
      Introspect and emit an editable migration plan (JSON). Review it —
      prune tables, rename slugs/fields — then feed it to \`run\`.

  run <plan.json> --source <url> [--batch <n>] [--resume] [--dry-run] [--since <ISO|epoch>]
      Execute the plan: create the target collections (PK type preserved),
      copy rows in FK-dependency order, verify counts. Progress persists in
      <plan>.state.json; re-run with --resume after an interruption.
      --since re-copies only rows whose updated_at/created_at >= the
      watermark, UPSERTING in place — the pre-cutover delta pass.

  Sources: postgres://…  ·  mysql://…  ·  sqlite:<path> / <path>.sqlite|.db
      (MySQL/SQLite are CLI-only; the sqlite file source needs Bun.)

  Server-side runs (the source must be reachable FROM the backlex server —
  see docs/migrating-in.md; private hosts need MIGRATE_ALLOW_PRIVATE_SOURCES):
    sources                         list saved sources (URLs masked)
    sources add <name> --source-url <postgres-url>
    sources rm <id>                 delete a source
    sources test <id>               connectivity check
    server-plan --source-id <id> [--tables a,b] [--out <file>]
    start --source-id <id> --plan <file>   queue a server-side copy run
    runs                            list runs (newest first)
    status <runId> [--watch]        one run's progress (--watch polls)
    cancel <runId> | resume <runId>

  Target connection: --url/--key/--tenant/--profile as usual (the key needs
  the admin role). Source: --source or BACKLEX_IMPORT_SOURCE.
`;

const die = (msg: string): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

const sourceUrl = (args: string[]): string =>
  flag(args, "--source") ??
  process.env.BACKLEX_IMPORT_SOURCE ??
  die("--source <postgres-url> is required (or set BACKLEX_IMPORT_SOURCE)");

/** postgres.js-backed SourceQuery. `prepare:false` keeps PgBouncer-style
 *  transaction poolers happy; 2 connections is plenty for a linear pump. */
const openPostgres = (url: string) => {
  const sql = postgres(url, { max: 2, prepare: false });
  const query: SourceQuery = async (text, params) =>
    (await sql.unsafe(text, (params ?? []) as never[])) as unknown as Record<
      string,
      unknown
    >[];
  return { connector: createPgSource(query), close: () => sql.end() };
};

/** mysql2-backed SourceQuery (lazy import — most invocations never need
 *  the MySQL driver). The mysql connector emits `?` placeholders. */
const openMysql = async (url: string) => {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(url);
  const query: SourceQuery = async (text, params) => {
    const [rows] = await conn.query(text, params ?? []);
    return rows as Record<string, unknown>[];
  };
  return { connector: createMysqlSource(query), close: () => conn.end() };
};

/** bun:sqlite-backed SourceQuery over a local database FILE. Bun-only —
 *  same posture as `backlex migrate` (every remote command works under
 *  Node; the two commands that open a local SQLite need Bun). */
const openSqliteFile = async (path: string) => {
  let Database: typeof import("bun:sqlite").Database;
  try {
    ({ Database } = await import("bun:sqlite"));
  } catch {
    die(
      "sqlite sources require Bun (bun:sqlite). Run with `bun backlex import-db …`.",
    );
    throw new Error("unreachable");
  }
  const db = new Database(path, { readonly: true });
  const query: SourceQuery = async (text, params) =>
    db.query(text).all(...((params ?? []) as never[])) as Record<
      string,
      unknown
    >[];
  return { connector: createSqliteFileSource(query), close: async () => db.close() };
};

/** Pick the driver from the source URL: `mysql://…` → mysql2,
 *  `sqlite:<path>` / `*.sqlite` / `*.db` → bun:sqlite file, else postgres. */
const openSource = (url: string) => {
  if (/^(mysql|mariadb):\/\//i.test(url)) return openMysql(url);
  if (/^sqlite:/i.test(url)) return openSqliteFile(url.replace(/^sqlite:/i, ""));
  if (/\.(sqlite3?|db)$/i.test(url) && !url.includes("://")) return openSqliteFile(url);
  return openPostgres(url);
};

/** Authenticated JSON fetch against the TARGET backlex instance. */
const api = async (
  ctx: Context,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${ctx.url}${path}`, {
    method,
    headers: {
      ...(ctx.key ? { authorization: `Bearer ${ctx.key}` } : {}),
      ...(ctx.tenant ? { "x-backlex-tenant": ctx.tenant } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

// ── inspect ───────────────────────────────────────────────────────────────

const runInspect = async (args: string[], deps: ImportDbDeps): Promise<void> => {
  const ctx = resolveContext(args);
  const { connector, close } = await (deps.openSource ?? openSource)(sourceUrl(args));
  try {
    const tables = await connector.listTables();
    const detailed = [];
    for (const t of tables) {
      const ins = await connector.inspect(t.name);
      detailed.push({
        table: t.name,
        approxRows: t.approxRows,
        pk: ins.pk ? `${ins.pk.column} (${ins.pk.dbType})` : "NONE / composite",
        columns: ins.columns.length,
        foreignKeys: ins.foreignKeys.length,
      });
    }
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify(detailed, null, 2)}\n`);
      return;
    }
    for (const d of detailed) {
      process.stdout.write(
        `${d.table.padEnd(32)} ~${String(d.approxRows ?? "?").padEnd(10)} pk=${d.pk}  cols=${d.columns}  fks=${d.foreignKeys}\n`,
      );
    }
  } finally {
    await close();
  }
};

// ── plan ──────────────────────────────────────────────────────────────────

const runPlan = async (args: string[], deps: ImportDbDeps): Promise<void> => {
  const { connector, close } = await (deps.openSource ?? openSource)(sourceUrl(args));
  try {
    const only = flag(args, "--tables")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const all = await connector.listTables();
    const picked = only ? all.filter((t) => only.includes(t.name)) : all;
    if (only) {
      for (const name of only) {
        if (!all.some((t) => t.name === name)) die(`Source table not found: ${name}`);
      }
    }
    const inspections = [];
    for (const t of picked) inspections.push(await connector.inspect(t.name));
    const plan = buildPlan(inspections, new Map(picked.map((t) => [t.name, t])), connector.kind);
    const out = flag(args, "--out");
    const text = `${JSON.stringify(plan, null, 2)}\n`;
    if (out) {
      writeFileSync(out, text);
      const included = plan.tables.filter((t) => t.include).length;
      process.stderr.write(
        `✓ plan → ${out} (${included}/${plan.tables.length} tables included)\n`,
      );
      for (const t of plan.tables) {
        for (const w of t.warnings) process.stderr.write(`  ⚠ ${t.table}: ${w}\n`);
        if (!t.include) process.stderr.write(`  ✗ ${t.table} excluded: ${t.reason}\n`);
      }
    } else {
      process.stdout.write(text);
    }
  } finally {
    await close();
  }
};

// ── run ───────────────────────────────────────────────────────────────────

interface TableState {
  created: boolean;
  cursor: unknown;
  copied: number;
  /** upsert (`--since`) mode: rows overwritten in place. */
  updated?: number;
  failed: number;
  done: boolean;
}
interface RunState {
  tables: Record<string, TableState>;
}

const loadState = (path: string, resume: boolean): RunState => {
  if (existsSync(path)) {
    if (!resume) {
      die(
        `State file ${path} exists — a previous run was interrupted.\n` +
          `Re-run with --resume to continue it, or delete the file to start over.`,
      );
    }
    return JSON.parse(readFileSync(path, "utf8")) as RunState;
  }
  return { tables: {} };
};

const runRun = async (args: string[], deps: ImportDbDeps): Promise<void> => {
  const planPath = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  if (!planPath) die("usage: backlex import-db run <plan.json> --source <url>");
  let plan: MigrationPlan;
  try {
    plan = parsePlan(JSON.parse(readFileSync(planPath!, "utf8")));
  } catch (e) {
    return die(`Invalid plan: ${(e as Error).message}`);
  }
  const ctx = resolveContext(args);
  const batch = Math.min(2000, Math.max(1, Number(flag(args, "--batch") ?? 1000)));
  const dryRun = has(args, "--dry-run");
  // `--since <ISO|epoch>`: incremental re-sync — only rows whose detected
  // updated_at/created_at column is >= the watermark, upserted in place
  // (PK conflicts overwrite; created_at is preserved server-side). Delta
  // passes keep their own state file so a finished full copy's cursors
  // don't short-circuit them.
  const sinceRaw = flag(args, "--since");
  const since = sinceRaw === undefined
    ? undefined
    : /^\d+$/.test(sinceRaw)
      ? Number(sinceRaw)
      : (() => {
          if (Number.isNaN(Date.parse(sinceRaw))) {
            die(`--since must be an ISO date or epoch number (got "${sinceRaw}")`);
          }
          return sinceRaw;
        })();
  const statePath = since ? `${planPath}.since.state.json` : `${planPath}.state.json`;
  const state = loadState(statePath, has(args, "--resume"));
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  const byName = new Map(plan.tables.map((t) => [t.table, t] as const));
  const { connector, close } = await (deps.openSource ?? openSource)(sourceUrl(args));
  const summary: {
    table: string;
    slug: string;
    copied: number;
    updated: number;
    failed: number;
    source: number;
    target: number | null;
  }[] = [];

  try {
    if (dryRun) {
      process.stdout.write("Dry run — nothing will be written.\n");
      for (const name of plan.order) {
        const t = byName.get(name)!;
        const n = await connector.count(name);
        process.stdout.write(
          `  ${name} → collection "${t.slug}" (pk ${t.pkColumn}:${t.pkType}, ${t.fields.length} fields, ${n} rows)\n`,
        );
      }
      return;
    }

    for (const name of plan.order) {
      const t = byName.get(name)!;
      const st: TableState =
        state.tables[t.slug] ??
        (state.tables[t.slug] = {
          created: false,
          cursor: undefined,
          copied: 0,
          failed: 0,
          done: false,
        });

      // 1. Ensure the target collection exists (idempotent on resume).
      if (!st.created) {
        const existing = await api(ctx, "GET", `/api/collections/${t.slug}`);
        if (existing.status === 404) {
          const created = await api(ctx, "POST", "/api/collections", collectionPayloadFor(t));
          if (created.status !== 201) {
            die(
              `Failed to create collection "${t.slug}": ${created.status} ${JSON.stringify(created.json?.error ?? created.json)}`,
            );
          }
          process.stderr.write(`✓ created collection ${t.slug}\n`);
        } else if (existing.status === 200) {
          // Reuse is only safe when the shapes agree (the resume path). A
          // pre-existing collection of a different shape would fail every
          // row with "Unknown column" — bail with the fix instead.
          const mismatch = collectionShapeMismatch(t, existing.json.data);
          if (mismatch) {
            die(`${mismatch}\nEdit ${planPath} (the table's "slug") and re-run.`);
          }
          process.stderr.write(`· collection ${t.slug} already exists — resuming into it\n`);
        } else {
          die(`Failed to check collection "${t.slug}": ${existing.status}`);
        }
        st.created = true;
        saveState();
      }

      // 2. Copy rows, keyset-paged from the source, idempotent on the target.
      const sinceCol = t.updatedAtColumn ?? t.createdAtColumn;
      if (since !== undefined && !sinceCol && !st.done && st.copied === 0) {
        process.stderr.write(
          `  ⚠ ${t.slug}: no updated_at/created_at column detected — --since can't filter; copying the full table (upsert)\n`,
        );
      }
      let lastTotal: number | null = null;
      while (!st.done) {
        const rows = await connector.readBatch(name, t.pkColumn, {
          after: st.cursor,
          limit: batch,
          ...(since !== undefined && sinceCol
            ? { since: { column: sinceCol, value: since } }
            : {}),
        });
        if (rows.length === 0) {
          st.done = true;
          saveState();
          break;
        }
        const payload = rows.map((r) => transformRow(t, r));
        const res = await api(ctx, "POST", `/api/admin/migrate/ingest/${t.slug}`, {
          rows: payload,
          mode: since !== undefined ? "upsert" : "insert",
        });
        if (res.status !== 200) {
          die(
            `Ingest into "${t.slug}" failed: ${res.status} ${JSON.stringify(res.json?.error ?? res.json)}\n` +
              `Progress is saved — fix the issue and re-run with --resume.`,
          );
        }
        const data = res.json.data as {
          inserted: number;
          skipped: number;
          updated: number;
          failed: { index: number; error: string }[];
          total: number;
        };
        st.copied += data.inserted;
        st.updated = (st.updated ?? 0) + (data.updated ?? 0);
        st.failed += data.failed.length;
        lastTotal = data.total;
        for (const f of data.failed.slice(0, 5)) {
          process.stderr.write(`  ⚠ ${t.slug} row ${f.index}: ${f.error}\n`);
        }
        if (data.failed.length > 5) {
          process.stderr.write(`  ⚠ ${t.slug}: +${data.failed.length - 5} more row failures\n`);
        }
        st.cursor = rows[rows.length - 1]![t.pkColumn];
        st.done = rows.length < batch;
        saveState();
        process.stderr.write(
          `  ${t.slug}: ${st.copied} copied${st.updated ? `, ${st.updated} updated` : ""}${st.failed ? `, ${st.failed} failed` : ""}\r`,
        );
      }
      process.stderr.write("\n");

      // 3. Per-table verify: source COUNT(*) vs target count.
      const sourceCount = await connector.count(name);
      if (lastTotal === null) {
        const counted = await api(
          ctx,
          "GET",
          `/api/items/${t.slug}?limit=1&meta=filter_count`,
        );
        lastTotal =
          counted.status === 200
            ? Number(counted.json?.meta?.filter_count ?? 0)
            : null;
      }
      summary.push({
        table: name,
        slug: t.slug,
        copied: st.copied,
        updated: st.updated ?? 0,
        failed: st.failed,
        source: sourceCount,
        target: lastTotal,
      });
    }

    // Final report. In `--since` delta mode the copied subset is by design
    // smaller than the table, so source/target counts aren't compared —
    // only row failures fail the pass.
    let allOk = true;
    process.stdout.write(since !== undefined ? "\nDelta re-sync summary\n" : "\nMigration summary\n");
    for (const s of summary) {
      const ok =
        since !== undefined
          ? s.failed === 0
          : s.target !== null && s.target >= s.source && s.failed === 0;
      if (!ok) allOk = false;
      process.stdout.write(
        `  ${ok ? "✓" : "✗"} ${s.table} → ${s.slug}: ${
          since !== undefined
            ? `copied=${s.copied} updated=${s.updated}`
            : `source=${s.source} target=${s.target ?? "?"} copied=${s.copied}`
        }${s.failed ? ` FAILED=${s.failed}` : ""}\n`,
      );
    }
    if (allOk) {
      process.stdout.write("\nAll tables verified. ");
      process.stdout.write(`You can delete ${statePath} now.\n`);
    } else {
      process.stdout.write(
        "\nSome tables did not verify — inspect the row failures above, fix, and re-run with --resume.\n",
      );
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
};

// ── Server-side runs (wrap /api/admin/migrate — services/migrate.ts) ──────

const fail = (what: string, res: { status: number; json: any }): never =>
  die(`${what}: ${res.status} ${JSON.stringify(res.json?.error ?? res.json)}`);

const runStateLine = (run: {
  status: string;
  error?: string | null;
  state?: { tables?: Record<string, { table: string; copied: number; failed: number; done: boolean; sourceCount?: number; targetTotal?: number }> };
}): string => {
  const tables = Object.entries(run.state?.tables ?? {});
  const parts = tables.map(
    ([slug, t]) =>
      `${slug}=${t.copied}${t.failed ? `(+${t.failed}!)` : ""}${t.done ? "✓" : "…"}`,
  );
  return `${run.status}${run.error ? ` (${run.error})` : ""}  ${parts.join(" ")}`;
};

const runSources = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  const sub = args[0];
  if (sub === "add") {
    const name = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    const url = flag(args, "--source-url");
    if (!name || !url) die("usage: backlex import-db sources add <name> --source-url <postgres-url>");
    const res = await api(ctx, "POST", "/api/admin/migrate/sources", { name, url });
    if (res.status !== 201) fail("create source", res);
    process.stdout.write(`✓ source ${res.json.data.id} (${res.json.data.urlMasked})\n`);
    return;
  }
  if (sub === "rm") {
    const id = args[1] ?? die("usage: backlex import-db sources rm <id>");
    const res = await api(ctx, "DELETE", `/api/admin/migrate/sources/${encodeURIComponent(id!)}`);
    if (res.status !== 200) fail("delete source", res);
    process.stdout.write("✓ deleted\n");
    return;
  }
  if (sub === "test") {
    const id = args[1] ?? die("usage: backlex import-db sources test <id>");
    const res = await api(ctx, "POST", `/api/admin/migrate/sources/${encodeURIComponent(id!)}/test`);
    if (res.status !== 200) fail("test source", res);
    const d = res.json.data as { ok: boolean; tables?: number; error?: string };
    process.stdout.write(d.ok ? `✓ reachable (${d.tables} tables)\n` : `✗ ${d.error}\n`);
    if (!d.ok) process.exitCode = 1;
    return;
  }
  const res = await api(ctx, "GET", "/api/admin/migrate/sources");
  if (res.status !== 200) fail("list sources", res);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(res.json.data, null, 2)}\n`);
    return;
  }
  for (const s of res.json.data as { id: string; name: string; urlMasked: string }[]) {
    process.stdout.write(`${s.id}  ${s.name.padEnd(24)} ${s.urlMasked}\n`);
  }
};

const runServerPlan = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  const sourceId = flag(args, "--source-id") ?? die("--source-id <id> is required");
  const tables = flag(args, "--tables")?.split(",").map((s) => s.trim()).filter(Boolean);
  const res = await api(
    ctx,
    "POST",
    `/api/admin/migrate/sources/${encodeURIComponent(sourceId!)}/plan`,
    { tables },
  );
  if (res.status !== 200) fail("build plan", res);
  const text = `${JSON.stringify(res.json.data, null, 2)}\n`;
  const out = flag(args, "--out");
  if (out) {
    writeFileSync(out, text);
    process.stderr.write(`✓ plan → ${out}\n`);
  } else {
    process.stdout.write(text);
  }
};

const runStart = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  const sourceId = flag(args, "--source-id") ?? die("--source-id <id> is required");
  const planPath = flag(args, "--plan") ?? die("--plan <file> is required");
  const plan = JSON.parse(readFileSync(planPath!, "utf8"));
  const res = await api(ctx, "POST", "/api/admin/migrate/runs", { sourceId, plan });
  if (res.status !== 201) fail("start run", res);
  process.stdout.write(
    `✓ run ${res.json.data.id} queued — follow with: backlex import-db status ${res.json.data.id} --watch\n`,
  );
};

const runStatus = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  const id = args[0] && !args[0].startsWith("-") ? args[0] : die("usage: backlex import-db status <runId>");
  const watch = has(args, "--watch");
  for (;;) {
    const res = await api(ctx, "GET", `/api/admin/migrate/runs/${encodeURIComponent(id!)}`);
    if (res.status !== 200) fail("get run", res);
    const run = res.json.data;
    if (ctx.json && !watch) {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${runStateLine(run)}\n`);
    if (!watch || ["done", "failed", "cancelled"].includes(run.status)) {
      if (run.status === "failed") process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
};

const runRunOp = async (args: string[], op: "cancel" | "resume"): Promise<void> => {
  const ctx = resolveContext(args);
  const id = args[0] ?? die(`usage: backlex import-db ${op} <runId>`);
  const res = await api(ctx, "POST", `/api/admin/migrate/runs/${encodeURIComponent(id!)}/${op}`);
  if (res.status !== 200) fail(op, res);
  process.stdout.write(`✓ ${res.json.data.status}\n`);
};

const runRunsList = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  const res = await api(ctx, "GET", "/api/admin/migrate/runs");
  if (res.status !== 200) fail("list runs", res);
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(res.json.data, null, 2)}\n`);
    return;
  }
  for (const run of res.json.data as { id: string; status: string; createdAt: unknown }[]) {
    process.stdout.write(`${run.id}  ${String(run.status).padEnd(10)} ${String(run.createdAt)}\n`);
  }
};

export const runImportDb = async (
  args: string[],
  deps: ImportDbDeps = {},
): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "inspect":
      await runInspect(rest, deps);
      return;
    case "plan":
      await runPlan(rest, deps);
      return;
    case "run":
      await runRun(rest, deps);
      return;
    case "sources":
      await runSources(rest);
      return;
    case "server-plan":
      await runServerPlan(rest);
      return;
    case "start":
      await runStart(rest);
      return;
    case "runs":
      await runRunsList(rest);
      return;
    case "status":
      await runStatus(rest);
      return;
    case "cancel":
      await runRunOp(rest, "cancel");
      return;
    case "resume":
      await runRunOp(rest, "resume");
      return;
    default:
      process.stdout.write(HELP);
      if (sub) process.exit(1);
  }
};
