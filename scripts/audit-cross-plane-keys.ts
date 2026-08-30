/**
 * Incident-response audit for the identity layer. READ-ONLY, always.
 *
 * This answers the questions a maintainer has to settle BEFORE deciding the
 * disclosure scope of an identity bug, and it has to be safe to point at a
 * production database while the incident is still open. Every statement it
 * runs is a `SELECT`; the pg path additionally asks the server for a
 * read-only session and the sqlite path opens the file `readonly`, so a typo
 * in this file cannot become a write against a live workspace.
 *
 * What it looks for:
 *
 *   1. **Cross-plane contamination.** backlex has two auth planes: "platform"
 *      (dashboard operators — `users` / `sessions` / `tenant_members` /
 *      `user_roles`) and "app" (a workspace's own end-users — `app_users` /
 *      `app_sessions`, authenticated with a bearer token). Control-plane rows
 *      are supposed to reference `users.id`. An `api_keys`, `tenant_members`
 *      or `user_roles` row whose `user_id` resolves inside `app_users`
 *      instead is the residue of an app-plane identity that reached a
 *      control-plane write — i.e. an end-user of somebody's app holding an
 *      operator-shaped credential. That is the finding that decides whether
 *      this is a hardening change or a disclosure.
 *
 *   2. **Orphans.** `POST /api/tenants` is not atomic: it writes the tenant,
 *      the membership, the roles and the role binding as separate statements,
 *      so a foreign-key violation on the fourth write leaves the first three
 *      behind. A `tenants.created_by` or `tenant_members.user_id` that
 *      resolves in NEITHER identity table is that residue. (`tenant_members`
 *      rows for an invited-but-not-yet-accepted person legitimately carry a
 *      NULL `user_id` and are excluded — they are an invite, not an orphan.)
 *
 *   3. **The workspace inventory.** On managed cloud one deployment is
 *      expected to hold exactly ONE workspace. If this database holds more,
 *      the blast radius of a cross-workspace bug is larger than the "one
 *      tenant per Worker" model assumes, and the disclosure scope changes.
 *      Informational: it never fails the run on its own.
 *
 *   4. **Ownerless workspaces.** A tenant with zero `tenant_members` rows at
 *      role `owner` has nobody who can administer or delete it, which is both
 *      an operational dead end and a symptom of (2).
 *
 * **Categories 1 and 2 are the SAME bug wearing whichever face the dialect
 * allows, which is why both are always checked.** `api_keys.user_id` and
 * `user_roles.user_id` carry a real, enforced foreign key to `users.id` on
 * Postgres — verified against the pg migration bundle, which refuses the
 * contaminated insert outright — so on a Postgres deployment those two shapes
 * of category 1 cannot exist at all, and the same failed write surfaces as
 * category 2 residue instead: the tenant and the membership were already
 * committed when the role binding was rejected. SQLite is the mirror image:
 * `PRAGMA foreign_keys` defaults OFF and only `packages/db/src/sqlite/migrate.ts`
 * turns it on, so the request-path Bun client never enforces it and the
 * contaminated row lands quietly. `tenant_members.user_id` has no foreign key
 * in either dialect (an index only), so it is reachable everywhere. Reading a
 * clean category 1 on Postgres therefore proves nothing on its own — read the
 * orphan count next to it.
 *
 * Exit status: non-zero when anything in categories 1, 2 or 4 is found, so
 * this can be wired as a gate. Category 3 alone always exits 0.
 *
 * Usage:
 *   bun scripts/audit-cross-plane-keys.ts                       # ./.data/backlex.sqlite, or $DATABASE_URL if set
 *   bun scripts/audit-cross-plane-keys.ts --sqlite ./.data/backlex.sqlite
 *   bun scripts/audit-cross-plane-keys.ts --pg "postgres://…"
 *   bun scripts/audit-cross-plane-keys.ts --json
 *   bun scripts/audit-cross-plane-keys.ts --print-sql            # for a D1 operator, see below
 *
 * **Cloudflare D1 is deliberately not a target of this script.** Nothing in
 * this repo opens a live D1 from a plain process — the only script that
 * reaches one, `packages/db/src/sqlite/migrate-d1.ts`, does it by spawning
 * `wrangler d1 execute`, and that path carries two traps this tool must not
 * inherit while an incident is open: `spawnSync`'s 1 MB `maxBuffer` truncates
 * a large result set with `status: null` and an EMPTY stderr (an audit that
 * silently reads as "no findings" is worse than no audit). So a D1 operator
 * runs the SQL themselves, against a surface where they can see the raw
 * output:
 *
 *   bun scripts/audit-cross-plane-keys.ts --print-sql > /tmp/identity-audit.sql
 *   cd apps/web && bunx wrangler d1 execute <db> --remote --json --file=/tmp/identity-audit.sql
 *
 * `--file` rather than `--command=` on purpose: a `--command=` argv element
 * containing spaces has reached wrangler on a CI runner split into separate
 * tokens (`Unknown arguments: hash, FROM, …`), which every query here would
 * trip over. `--print-sql` emits exactly the statements the native path runs,
 * each preceded by a `-- <name>` comment, so the two routes cannot drift apart
 * and the results can be matched back to their categories by order.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The identity tables this audit reads. Checked up front rather than let a
 * missing table surface as a mid-run SQL error: a database that predates the
 * app plane has no `app_users` at all, and "the query failed" reads far too
 * much like "the query found nothing".
 */
const REQUIRED_TABLES = [
  "tenants",
  "tenant_members",
  "users",
  "app_users",
  "user_roles",
  "api_keys",
  "roles",
] as const;

/**
 * Written to run unmodified on Postgres, SQLite and D1. That rules out a few
 * conveniences worth naming so nobody "tidies" them back in: no `ILIKE`, no
 * boolean literals (SQLite has none — the `also_platform_user` probes return
 * 1/0 through a `CASE`), and no `::` casts.
 *
 * `also_platform_user` exists because an id colliding across both tables is
 * not impossible, and a row that resolves in `users` too is a materially
 * different finding from one that resolves only in `app_users` — the first is
 * ambiguous, the second is unambiguous contamination. Reporting them as one
 * number would hide that distinction exactly when it matters.
 */
const QUERIES = {
  contaminatedApiKeys: `
    SELECT k.id                AS key_id,
           k.name              AS key_name,
           k.prefix            AS key_prefix,
           k.tenant_id         AS key_tenant_id,
           k.user_id           AS user_id,
           k.revoked_at        AS revoked_at,
           k.created_at        AS created_at,
           a.email             AS app_user_email,
           a.tenant_id         AS app_user_tenant_id,
           (CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = k.user_id)
                 THEN 1 ELSE 0 END) AS also_platform_user
      FROM api_keys k
      JOIN app_users a ON a.id = k.user_id
     ORDER BY k.created_at`,

  contaminatedTenantMembers: `
    SELECT m.id                AS member_id,
           m.tenant_id         AS tenant_id,
           m.user_id           AS user_id,
           m.email             AS member_email,
           m.role              AS role,
           m.status            AS status,
           m.created_at        AS created_at,
           a.email             AS app_user_email,
           a.tenant_id         AS app_user_tenant_id,
           (CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)
                 THEN 1 ELSE 0 END) AS also_platform_user
      FROM tenant_members m
      JOIN app_users a ON a.id = m.user_id
     ORDER BY m.created_at`,

  contaminatedUserRoles: `
    SELECT ur.user_id          AS user_id,
           ur.role_id          AS role_id,
           r.name              AS role_name,
           r.tenant_id         AS role_tenant_id,
           r.admin             AS role_admin,
           ur.created_at       AS created_at,
           a.email             AS app_user_email,
           a.tenant_id         AS app_user_tenant_id,
           (CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = ur.user_id)
                 THEN 1 ELSE 0 END) AS also_platform_user
      FROM user_roles ur
      JOIN app_users a ON a.id = ur.user_id
      LEFT JOIN roles r ON r.id = ur.role_id
     ORDER BY ur.created_at`,

  orphanTenants: `
    SELECT t.id                AS tenant_id,
           t.slug              AS slug,
           t.name              AS name,
           t.created_by        AS created_by,
           t.created_at        AS created_at
      FROM tenants t
     WHERE t.created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.created_by)
       AND NOT EXISTS (SELECT 1 FROM app_users a WHERE a.id = t.created_by)
     ORDER BY t.created_at`,

  orphanTenantMembers: `
    SELECT m.id                AS member_id,
           m.tenant_id         AS tenant_id,
           m.user_id           AS user_id,
           m.email             AS member_email,
           m.role              AS role,
           m.status            AS status,
           m.created_at        AS created_at
      FROM tenant_members m
     WHERE m.user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)
       AND NOT EXISTS (SELECT 1 FROM app_users a WHERE a.id = m.user_id)
     ORDER BY m.created_at`,

  /**
   * Categories 3 and 4 come from this ONE query. Deriving "ownerless" from
   * the same rows the inventory prints means the two can never disagree —
   * a second query counting owners its own way is exactly how a report ends
   * up claiming a workspace is both fine and ownerless.
   */
  tenantInventory: `
    SELECT t.id                AS tenant_id,
           t.slug              AS slug,
           t.name              AS name,
           t.created_at        AS created_at,
           t.created_by        AS created_by,
           (SELECT COUNT(*) FROM tenant_members m
             WHERE m.tenant_id = t.id)                       AS member_count,
           (SELECT COUNT(*) FROM tenant_members m
             WHERE m.tenant_id = t.id AND m.role = 'owner')  AS owner_count,
           (SELECT COUNT(*) FROM app_users a
             WHERE a.tenant_id = t.id)                       AS app_user_count
      FROM tenants t
     ORDER BY t.created_at`,
} as const;

type QueryName = keyof typeof QUERIES;
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

interface Runner {
  dialect: "pg" | "sqlite";
  /** Human-readable target, safe to print — never a URL carrying a password. */
  label: string;
  listTables: () => Promise<Set<string>>;
  run: (sql: string) => Promise<Row[]>;
  close: () => Promise<void>;
  /** Set when the read-only guard could not be applied; surfaced in the report. */
  readOnlyWarning?: string;
}

/**
 * `create: false` is the load-bearing half. bun:sqlite happily CREATES a file
 * for a path that does not exist, and an audit that invents an empty database
 * for a mistyped path then reports "clean, 0 findings" is the worst possible
 * failure mode for this tool — it answers the disclosure question wrongly and
 * confidently.
 */
const openSqlite = async (path: string): Promise<Runner> => {
  if (!existsSync(path)) {
    throw new Error(
      `no SQLite database at ${path} — pass --sqlite <path>, and note that this ` +
        `script will not create one (a fabricated empty database would report "clean").`,
    );
  }
  const { Database } = await import("bun:sqlite");
  let readOnlyWarning: string | undefined;
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(path, { readonly: true, create: false });
  } catch (err) {
    // A database with a hot WAL needs write access to its `-shm` companion
    // before it can be read at all, so a readonly open legitimately fails on
    // a live file. Fall back, but say so — every statement below is a SELECT,
    // yet the operator deserves to know the guard is off rather than assume it.
    readOnlyWarning = `could not open ${path} read-only (${(err as Error).message}); opened writable — every statement is still a SELECT`;
    // `{ readonly: false }` is NOT the way to say "writable" here: bun:sqlite
    // maps the option set straight onto SQLite's open flags, and passing
    // `readonly: false` alongside `create: false` produces a flag word with
    // neither SQLITE_OPEN_READONLY nor SQLITE_OPEN_READWRITE set, which the
    // driver rejects with "flags must include SQLITE_OPEN_READONLY or
    // SQLITE_OPEN_READWRITE". `readwrite: true` is the positive form, and it
    // is what makes this fallback actually run — the WAL case it exists for is
    // the ordinary shape of any live database, so a broken fallback here means
    // the script only ever worked against a file nobody was using.
    db = new Database(path, { readwrite: true, create: false });
  }
  return {
    dialect: "sqlite",
    label: path,
    readOnlyWarning,
    listTables: async () =>
      new Set(
        (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]).map((r) => r.name),
      ),
    run: async (sql) => db.query(sql).all() as Row[],
    close: async () => db.close(),
  };
};

/** The sliver of the `postgres` client surface this audit touches. Declared
 *  here rather than imported because the package is resolved dynamically (see
 *  `openPg`), so there is no static specifier for TypeScript to follow. */
interface PgClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  unsafe: (sql: string) => Promise<Row[]>;
  end: () => Promise<void>;
}

/**
 * `default_transaction_read_only` goes in the STARTUP packet rather than a
 * `SET` statement, because a transaction-pooling PgBouncer/Supabase URL hands
 * out a different backend per transaction and a session-level `SET` would not
 * survive to the next query. The startup parameter is forwarded by the pooler,
 * so the guard actually holds where it is most needed. Some managed endpoints
 * reject unknown startup parameters outright, so a failure there falls back to
 * a plain connection with a loud warning instead of aborting the audit.
 */
const openPg = async (url: string): Promise<Runner> => {
  // `postgres` is a dependency of `@backlex/db`, not of the repo root, and bun
  // does not hoist it — a bare `import("postgres")` from `scripts/` fails with
  // "Cannot find package". Resolve it from the workspace that actually
  // declares it, so the driver this audit uses is byte-for-byte the one the
  // application uses rather than a second copy someone installed at the root.
  const pgEntry = Bun.resolveSync(
    "postgres",
    resolve(import.meta.dir, "../packages/db"),
  );
  const { default: postgres } = (await import(pgEntry)) as {
    default: (url: string, opts?: unknown) => PgClient;
  };
  const base = { max: 1, prepare: false, connect_timeout: 10 } as Record<string, unknown>;
  let readOnlyWarning: string | undefined;

  const connect = async (opts: Record<string, unknown>): Promise<PgClient> => {
    const sql = postgres(url, opts);
    // Force a real round-trip now: postgres.js connects lazily, so a rejected
    // startup parameter would otherwise surface on the first audit query and
    // read as "the audit failed" rather than "the guard is unsupported".
    await sql`SELECT 1`;
    return sql;
  };

  let client: PgClient;
  try {
    client = await connect({
      ...base,
      connection: { default_transaction_read_only: "on" },
    });
  } catch (err) {
    readOnlyWarning = `server rejected the read-only session guard (${(err as Error).message}); connected without it — every statement is still a SELECT`;
    client = await connect(base);
  }

  // Never print the URL: it carries the password.
  const label = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return "postgres";
    }
  })();

  return {
    dialect: "pg",
    label,
    readOnlyWarning,
    listTables: async () =>
      new Set(
        (
          await client.unsafe(
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()",
          )
        ).map((r) => String(r.name)),
      ),
    run: async (sql) => await client.unsafe(sql),
    close: async () => {
      await client.end();
    },
  };
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  sqlitePath: string | null;
  pgUrl: string | null;
  json: boolean;
  printSql: boolean;
}

const USAGE = `bun scripts/audit-cross-plane-keys.ts [--sqlite PATH | --pg URL] [--json] [--print-sql]

  --sqlite PATH   audit a SQLite/D1-shaped file (default ./.data/backlex.sqlite)
  --pg URL        audit a Postgres database (default $DATABASE_URL when set)
  --json          machine-readable output on stdout
  --print-sql     print the SELECTs and exit — for a D1 operator to run as
                  \`wrangler d1 execute <db> --remote --json --file=…\`

Exits non-zero when cross-plane contamination, orphaned identity rows, or an
ownerless workspace is found. The workspace inventory alone never fails.`;

const parseArgs = (argv: string[]): Args => {
  const out: Args = { sqlitePath: null, pgUrl: null, json: false, printSql: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const next = argv[i + 1];
    const inline = (flag: string) =>
      a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : null;

    if (a === "--sqlite" && next) { out.sqlitePath = next; i++; }
    else if (inline("--sqlite")) { out.sqlitePath = inline("--sqlite"); }
    else if (a === "--pg" && next) { out.pgUrl = next; i++; }
    else if (inline("--pg")) { out.pgUrl = inline("--pg"); }
    else if (a === "--json") { out.json = true; }
    else if (a === "--print-sql") { out.printSql = true; }
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  // Postgres returns COUNT(*) as a bigint, which postgres.js hands back as a
  // string to avoid precision loss. `0` and `"0"` must not report differently.
  const n = typeof v === "bigint" ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** SQLite stores these as epoch-ms integers, Postgres as `timestamptz` (a
 *  `Date` through postgres.js). Both land as one ISO string so the report is
 *  comparable across dialects and pasteable into an incident note. */
const when = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  const asNum = Number(v);
  if (typeof v === "string" && v !== "" && Number.isFinite(asNum) && /^\d+$/.test(v)) {
    return new Date(asNum).toISOString();
  }
  return String(v);
};

/** The queries are indented to read well in this file, which makes them read
 *  badly in a `.sql` file an operator is about to paste into wrangler. Strip
 *  the common leading indent so the printed form is the same SQL, plainly. */
const dedent = (sql: string): string => {
  const lines = sql.replace(/^\n+/, "").replace(/\s+$/, "").split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return lines.map((l) => l.slice(indent)).join("\n");
};

const str = (v: unknown): string => (v === null || v === undefined ? "—" : String(v));

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.printSql) {
    for (const [name, sql] of Object.entries(QUERIES)) {
      console.log(`-- ${name}`);
      console.log(`${dedent(sql)};\n`);
    }
    return;
  }

  const pgUrl = args.pgUrl ?? (args.sqlitePath ? null : process.env.DATABASE_URL ?? null);
  const runner = pgUrl
    ? await openPg(pgUrl)
    : await openSqlite(args.sqlitePath ?? "./.data/backlex.sqlite");

  const log = (line = "") => {
    if (!args.json) console.log(line);
  };

  // `process.exit()` skips `finally`, so the exit code is computed here and
  // acted on only after the connection is closed. Leaving a postgres client
  // open is harmless at process death, but a script that never closes it also
  // never surfaces a connection error, and this one is run under pressure.
  let exitCode = 0;
  const audit = async (): Promise<number> => {
    try {
      const tables = await runner.listTables();
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      if (missing.length > 0) {
        // Exit 2, distinct from the "findings" exit 1: nothing was audited, and
        // a gate must not read that as a clean bill of health.
        console.error(
          `FAIL    ${runner.label} is missing ${missing.join(", ")} — ` +
            `this is not a migrated backlex database, so nothing was audited.`,
        );
        return 2;
      }

      const results = {} as Record<QueryName, Row[]>;
      for (const [name, sql] of Object.entries(QUERIES) as [QueryName, string][]) {
        results[name] = await runner.run(sql);
      }

      const inventory = results.tenantInventory;
      const ownerless = inventory.filter((t) => num(t.owner_count) === 0);
      const contamination =
        results.contaminatedApiKeys.length +
        results.contaminatedTenantMembers.length +
        results.contaminatedUserRoles.length;
      const orphans = results.orphanTenants.length + results.orphanTenantMembers.length;
      const failing = contamination + orphans + ownerless.length;

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              target: { dialect: runner.dialect, label: runner.label },
              readOnlyWarning: runner.readOnlyWarning ?? null,
              crossPlaneContamination: {
                apiKeys: results.contaminatedApiKeys,
                tenantMembers: results.contaminatedTenantMembers,
                userRoles: results.contaminatedUserRoles,
                total: contamination,
              },
              orphans: {
                tenants: results.orphanTenants,
                tenantMembers: results.orphanTenantMembers,
                total: orphans,
              },
              workspaces: {
                count: inventory.length,
                rows: inventory.map((t) => ({
                  ...t,
                  created_at: when(t.created_at),
                  member_count: num(t.member_count),
                  owner_count: num(t.owner_count),
                  app_user_count: num(t.app_user_count),
                })),
              },
              ownerlessWorkspaces: ownerless.map((t) => str(t.slug)),
              verdict: failing === 0 ? "clean" : "findings",
              findingCount: failing,
            },
            null,
            2,
          ),
        );
        return failing === 0 ? 0 : 1;
      }

      log(`target  ${runner.dialect} — ${runner.label}`);
      if (runner.readOnlyWarning) log(`warn    ${runner.readOnlyWarning}`);
      log();

      log("1. CROSS-PLANE CONTAMINATION (app-plane identity in a control-plane row)");
      if (contamination === 0) {
        log("   ✓ none — no api_keys / tenant_members / user_roles row resolves into app_users");
      } else {
        for (const r of results.contaminatedApiKeys) {
          log(
            `   ✗ api_keys ${str(r.key_id)} "${str(r.key_name)}" (${str(r.key_prefix)}…) ` +
              `owner=${str(r.user_id)} is app_user ${str(r.app_user_email)} of tenant ${str(r.app_user_tenant_id)}` +
              `${num(r.also_platform_user) === 1 ? " [id ALSO matches a platform user — ambiguous]" : ""}` +
              `${r.revoked_at ? " (revoked)" : ""}`,
          );
        }
        for (const r of results.contaminatedTenantMembers) {
          log(
            `   ✗ tenant_members ${str(r.member_id)} role=${str(r.role)} status=${str(r.status)} ` +
              `in tenant ${str(r.tenant_id)} — user_id ${str(r.user_id)} is app_user ${str(r.app_user_email)}` +
              `${num(r.also_platform_user) === 1 ? " [id ALSO matches a platform user — ambiguous]" : ""}`,
          );
        }
        for (const r of results.contaminatedUserRoles) {
          log(
            `   ✗ user_roles ${str(r.user_id)} → role ${str(r.role_name)} (${str(r.role_id)}, ` +
              `tenant ${str(r.role_tenant_id)}${num(r.role_admin) === 1 || r.role_admin === true ? ", ADMIN" : ""}) ` +
              `— user_id is app_user ${str(r.app_user_email)}` +
              `${num(r.also_platform_user) === 1 ? " [id ALSO matches a platform user — ambiguous]" : ""}`,
          );
        }
      }
      log();

      log("2. ORPHANED IDENTITY ROWS (reference neither users nor app_users)");
      if (orphans === 0) {
        log("   ✓ none — every created_by / user_id resolves to a real identity");
      } else {
        for (const r of results.orphanTenants) {
          log(
            `   ✗ tenants ${str(r.slug)} (${str(r.tenant_id)}) created_by=${str(r.created_by)} ` +
              `at ${when(r.created_at)} — that identity does not exist`,
          );
        }
        for (const r of results.orphanTenantMembers) {
          log(
            `   ✗ tenant_members ${str(r.member_id)} in tenant ${str(r.tenant_id)} ` +
              `user_id=${str(r.user_id)} email=${str(r.member_email)} role=${str(r.role)} ` +
              `— that identity does not exist`,
          );
        }
      }
      log();

      log(`3. WORKSPACE INVENTORY — ${inventory.length} tenant(s) [informational]`);
      if (inventory.length === 0) {
        log("   (none)");
      }
      for (const t of inventory) {
        log(
          `   · ${str(t.slug)} (${str(t.tenant_id)}) members=${num(t.member_count)} ` +
            `owners=${num(t.owner_count)} app_users=${num(t.app_user_count)} created=${when(t.created_at)}`,
        );
      }
      if (inventory.length > 1) {
        log(
          `   ! managed cloud expects ONE workspace per deployment; this database holds ${inventory.length}.`,
        );
        log("     Confirm which deployment this is before sizing the disclosure.");
      }
      log();

      log("4. OWNERLESS WORKSPACES (no tenant_members row at role 'owner')");
      if (ownerless.length === 0) {
        log("   ✓ none — every workspace has at least one owner");
      } else {
        for (const t of ownerless) {
          log(`   ✗ ${str(t.slug)} (${str(t.tenant_id)}) has ${num(t.member_count)} member(s), 0 owners`);
        }
      }
      log();

      // The paste-into-the-incident-note block. Kept deliberately terse and
      // fully self-describing — it has to make sense to someone who did not run
      // the command and cannot see the scrollback above it.
      log("── VERDICT ─────────────────────────────────────────────────");
      log(`  target                      ${runner.dialect} ${runner.label}`);
      log(`  cross-plane contamination   ${contamination}`);
      log(`    · api_keys                ${results.contaminatedApiKeys.length}`);
      log(`    · tenant_members          ${results.contaminatedTenantMembers.length}`);
      log(`    · user_roles              ${results.contaminatedUserRoles.length}`);
      log(`  orphaned identity rows      ${orphans}`);
      log(`    · tenants.created_by      ${results.orphanTenants.length}`);
      log(`    · tenant_members.user_id  ${results.orphanTenantMembers.length}`);
      log(`  workspaces in this database ${inventory.length}`);
      log(`  ownerless workspaces        ${ownerless.length}`);
      log(
        `  VERDICT                     ${
          failing === 0
            ? "CLEAN — no app-plane identity holds a control-plane row here"
            : `${failing} FINDING(S) — see above; disclosure scope is NOT yet settled`
        }`,
      );
      log("────────────────────────────────────────────────────────────");

      return failing === 0 ? 0 : 1;
    } finally {
      await runner.close();
    }
  };

  exitCode = await audit();
  process.exit(exitCode);
};

// A bad target (a mistyped path, an unreachable host) must read as an operator
// error, not as a crash: an audit that dies with a stack trace during an
// incident invites the reader to skim past it and assume nothing was wrong.
await main().catch((err: unknown) => {
  console.error(`FAIL    ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
