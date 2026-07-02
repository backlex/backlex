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
  createPgSource,
  parsePlan,
  type MigrationPlan,
  type PlanTable,
  type SourceConnector,
  type SourceQuery,
} from "@backlex/migrate";
import { flag, has, resolveContext, type Context } from "./client";

/** Injectable source factory — tests swap in a pglite-backed connector
 *  (pglite has no TCP listener for postgres.js to dial). */
export interface ImportDbDeps {
  openSource?: (url: string) => {
    connector: SourceConnector;
    close: () => Promise<unknown>;
  };
}

const HELP = `backlex import-db <command> — migrate an external database into backlex

  inspect --source <postgres-url> [--json]
      List the source's tables (name, ~rows, PK, warnings).

  plan --source <postgres-url> [--tables a,b,…] [--out <file>]
      Introspect and emit an editable migration plan (JSON). Review it —
      prune tables, rename slugs/fields — then feed it to \`run\`.

  run <plan.json> --source <postgres-url> [--batch <n>] [--resume] [--dry-run]
      Execute the plan: create the target collections (PK type preserved),
      copy rows in FK-dependency order, verify counts. Progress persists in
      <plan>.state.json; re-run with --resume after an interruption.

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
const openSource = (url: string) => {
  const sql = postgres(url, { max: 2, prepare: false });
  const query: SourceQuery = async (text, params) =>
    (await sql.unsafe(text, (params ?? []) as never[])) as unknown as Record<
      string,
      unknown
    >[];
  return { connector: createPgSource(query), close: () => sql.end() };
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
  const { connector, close } = (deps.openSource ?? openSource)(sourceUrl(args));
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
  const { connector, close } = (deps.openSource ?? openSource)(sourceUrl(args));
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
    const plan = buildPlan(inspections, new Map(picked.map((t) => [t.name, t])));
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

/** Build the POST /api/collections payload for a plan table. */
const collectionPayload = (t: PlanTable) => ({
  slug: t.slug,
  pkType: t.pkType,
  fields: t.fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(f.choices
      ? {
          interface: "dropdown",
          options: { choices: f.choices.map((value) => ({ value })) },
        }
      : {}),
  })),
});

/** Reshape one source row into the ingest body shape (rename columns to
 *  field names, hoist PK + system timestamps). */
const transformRow = (
  t: PlanTable,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: row[t.pkColumn] };
  if (t.createdAtColumn && row[t.createdAtColumn] !== undefined) {
    out.created_at = row[t.createdAtColumn];
  }
  if (t.updatedAtColumn && row[t.updatedAtColumn] !== undefined) {
    out.updated_at = row[t.updatedAtColumn];
  }
  for (const f of t.fields) {
    const v = row[f.column];
    if (v !== undefined) out[f.name] = v;
  }
  return out;
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
  const statePath = `${planPath}.state.json`;
  const state = loadState(statePath, has(args, "--resume"));
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  const byName = new Map(plan.tables.map((t) => [t.table, t] as const));
  const { connector, close } = (deps.openSource ?? openSource)(sourceUrl(args));
  const summary: {
    table: string;
    slug: string;
    copied: number;
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
          const created = await api(ctx, "POST", "/api/collections", collectionPayload(t));
          if (created.status !== 201) {
            die(
              `Failed to create collection "${t.slug}": ${created.status} ${JSON.stringify(created.json?.error ?? created.json)}`,
            );
          }
          process.stderr.write(`✓ created collection ${t.slug}\n`);
        } else if (existing.status === 200) {
          process.stderr.write(`· collection ${t.slug} already exists — resuming into it\n`);
        } else {
          die(`Failed to check collection "${t.slug}": ${existing.status}`);
        }
        st.created = true;
        saveState();
      }

      // 2. Copy rows, keyset-paged from the source, idempotent on the target.
      let lastTotal: number | null = null;
      while (!st.done) {
        const rows = await connector.readBatch(name, t.pkColumn, {
          after: st.cursor,
          limit: batch,
        });
        if (rows.length === 0) {
          st.done = true;
          saveState();
          break;
        }
        const payload = rows.map((r) => transformRow(t, r));
        const res = await api(ctx, "POST", `/api/admin/migrate/ingest/${t.slug}`, {
          rows: payload,
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
          failed: { index: number; error: string }[];
          total: number;
        };
        st.copied += data.inserted;
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
          `  ${t.slug}: ${st.copied} copied${st.failed ? `, ${st.failed} failed` : ""}\r`,
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
        failed: st.failed,
        source: sourceCount,
        target: lastTotal,
      });
    }

    // Final report.
    let allOk = true;
    process.stdout.write("\nMigration summary\n");
    for (const s of summary) {
      const ok = s.target !== null && s.target >= s.source && s.failed === 0;
      if (!ok) allOk = false;
      process.stdout.write(
        `  ${ok ? "✓" : "✗"} ${s.table} → ${s.slug}: source=${s.source} target=${s.target ?? "?"} copied=${s.copied}${s.failed ? ` FAILED=${s.failed}` : ""}\n`,
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
    default:
      process.stdout.write(HELP);
      if (sub) process.exit(1);
  }
};
