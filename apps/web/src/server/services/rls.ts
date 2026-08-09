/**
 * Row-level security — the workspace's permission rules, pushed into Postgres.
 *
 * The compiler lives in `@backlex/db/rls`; this is the part that reads the
 * workspace, plans the statements, and runs them. See the compiler's header for
 * why `ENABLE` and not `FORCE`, why policies are `TO PUBLIC`, and what is
 * deliberately not represented.
 *
 * Three things this file is responsible for and the compiler is not:
 *
 *   1. **Refusing to run when it would filter US.** RLS exempts a table's
 *      owner. If backlex is not the owner, the same `ALTER TABLE` that protects
 *      a reporting tool starts filtering every query the product makes — with
 *      the workspace's own settings unset, which means it would return nothing.
 *      That is checked per table, before anything is applied.
 *   2. **Drift.** Policies are a SNAPSHOT of the permission rules at the moment
 *      they were applied. Editing a role afterwards changes the API instantly
 *      and the database not at all, so `rlsStatus` compares what is installed
 *      against what the current rules would produce and says so. Re-applying
 *      automatically on every permission edit was rejected: a DDL statement
 *      against every physical table is not something a checkbox toggle should
 *      trigger, and a failure there would surface as a failed permission save.
 *   3. **Admin roles.** A role with `admin` gets no policy at all. Its API
 *      access is unconditional, and a policy saying `TRUE` for it would be a
 *      standing bypass sitting in the database for anyone who can set
 *      `backlex.roles`.
 */
import { eq, sql as pgSql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { Condition } from "@backlex/core";
import {
  RLS_HELPER_DDL,
  disableRlsStatement,
  dropPolicyStatement,
  enableRlsStatement,
  policyName,
  policyStatements,
  rlsBlockers,
  rlsUnmappedVariables,
  type RlsAction,
} from "@backlex/db";
import * as pg from "@backlex/db/pg";
import type { Ctx } from "../context";

type AnyDb = any;

const ACTIONS: RlsAction[] = ["read", "create", "update", "delete"];

/** Actions a permission row may name that RLS has no command for. A stored
 *  `publish` grant is real and enforced by the API; there is no `PUBLISH`
 *  statement for a policy to attach to, so it is reported, not dropped. */
const isRlsAction = (a: string): a is RlsAction => (ACTIONS as string[]).includes(a);

export interface RlsPolicyPlan {
  collection: string;
  table: string;
  role: string;
  action: RlsAction;
  name: string;
  statements: string[];
}

export interface RlsPlan {
  /** Statements that create the helper schema. Idempotent. */
  helpers: string[];
  /** `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, one per covered table. */
  enables: string[];
  policies: RlsPolicyPlan[];
  /** Parts of the permission model this plan does NOT represent, each with the
   *  reason. An operator reading a plan has to learn that the direct-connection
   *  view is coarser than the API's, not assume they match. */
  omissions: Array<{ collection: string; role: string; action: string; reason: string }>;
  /** Tables backlex does not own — applying would filter the product itself. */
  notOwned: string[];
}

interface CollectionRowLite {
  slug: string;
  physicalTable: string;
  tenantScoped: boolean;
  softDelete: boolean;
}

export const rlsSupported = (ctx: Ctx): boolean => ctx.dialect === "pg";

const requirePg = (ctx: Ctx): void => {
  if (!rlsSupported(ctx)) {
    throw new AppError(
      "UNAVAILABLE",
      "Row-level security is a Postgres feature. On SQLite/D1 the API remains the only enforcement point — " +
        "there is nothing to compile policies into, and pretending otherwise would be worse than saying so.",
    );
  }
};

/** Database role the policies apply to. `PUBLIC` unless the deployment names
 *  one — see the compiler header for why that default is the strict one. */
export const rlsAppRole = (env: { RLS_APP_ROLE?: string }): string =>
  env.RLS_APP_ROLE && env.RLS_APP_ROLE.trim() ? env.RLS_APP_ROLE.trim() : "PUBLIC";

const loadCollections = async (
  ctx: Ctx,
  tenantId: string,
): Promise<CollectionRowLite[]> => {
  const t = pg.schema.collections;
  const rows = (await (ctx.db as AnyDb)
    .select({
      slug: t.slug,
      physicalTable: t.physicalTable,
      tenantScoped: t.tenantScoped,
      softDelete: t.softDelete,
      status: t.status,
    })
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Array<CollectionRowLite & { status: string | null }>;
  return rows.filter((r) => r.status !== "archived");
};

interface GrantRow {
  role: string;
  admin: boolean;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

const loadGrants = async (ctx: Ctx, tenantId: string): Promise<GrantRow[]> => {
  const p = pg.schema.permissions;
  const r = pg.schema.roles;
  return (await (ctx.db as AnyDb)
    .select({
      role: r.name,
      admin: r.admin,
      collection: p.collection,
      action: p.action,
      fields: p.fields,
      condition: p.condition,
    })
    .from(p)
    .innerJoin(r, eq(p.roleId, r.id))
    .where(eq(r.tenantId, tenantId))) as GrantRow[];
};

/**
 * Which of these tables backlex owns.
 *
 * The load-bearing query of the whole feature: `ENABLE ROW LEVEL SECURITY` is
 * harmless to the owner and catastrophic to anyone else, and "anyone else" is
 * what a managed Postgres with a restricted application role looks like.
 */
/** A bound list for an `IN (…)`. An array parameter would be the obvious
 *  spelling, but a JS array bound as one value does not arrive as a Postgres
 *  array through every driver this runs on — it arrived as the string
 *  `c_…_notes` on pglite and the cast failed. One parameter per element cannot
 *  be misread by any of them. */
const nameList = (names: string[]) =>
  pgSql.join(
    names.map((n) => pgSql`${n}`),
    pgSql`, `,
  );

const notOwnedTables = async (ctx: Ctx, tables: string[]): Promise<string[]> => {
  if (tables.length === 0) return [];
  const rows = (await (ctx.db as AnyDb).execute(
    // `to_regclass` returns NULL for a table that does not exist yet, which is
    // not an ownership problem — an absent table simply has no plan entry.
    pgSql`SELECT c.relname AS name,
            pg_catalog.pg_get_userbyid(c.relowner) = current_user AS owned
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r'
            AND n.nspname = ANY(current_schemas(false))
            AND c.relname IN (${nameList(tables)})`,
  )) as unknown as { rows?: Array<{ name: string; owned: boolean }> } | Array<{ name: string; owned: boolean }>;
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return list.filter((r) => !r.owned).map((r) => r.name);
};


/**
 * Plan the policies for a workspace. Pure read — nothing is applied.
 */
export const planRls = async (ctx: Ctx, tenantId: string): Promise<RlsPlan> => {
  requirePg(ctx);
  const collections = await loadCollections(ctx, tenantId);
  const byslug = new Map(collections.map((c) => [c.slug, c]));
  const grants = await loadGrants(ctx, tenantId);

  const policies: RlsPolicyPlan[] = [];
  const omissions: RlsPlan["omissions"] = [];
  const coveredTables = new Set<string>();
  const appliesTo = rlsAppRole(ctx.env);

  for (const g of grants) {
    const col = byslug.get(g.collection);
    if (!col) continue; // a grant on a collection this workspace no longer has
    if (g.admin) continue; // see the header: an admin policy would be a stored bypass
    if (!isRlsAction(g.action)) {
      omissions.push({
        collection: g.collection,
        role: g.role,
        action: g.action,
        reason:
          `\`${g.action}\` is a backlex action with no SQL command behind it, so no policy can carry it. ` +
          "The API still enforces it.",
      });
      continue;
    }
    if (g.fields && g.fields.length > 0) {
      omissions.push({
        collection: g.collection,
        role: g.role,
        action: g.action,
        reason:
          "the grant carries a field allow-list. Column privileges are per database role, and the union " +
          "across the backlex roles one session holds cannot be expressed as one — a direct reader sees " +
          "every column of the rows it may read.",
      });
      // The ROW scope is still worth installing; only the column half is lost.
    }
    const condition = (g.condition ?? null) as Condition | null;
    if (condition) {
      const blockers = rlsBlockers(condition);
      if (blockers.length) {
        for (const reason of blockers) {
          omissions.push({ collection: g.collection, role: g.role, action: g.action, reason });
        }
        // A condition that cannot be compiled is NOT downgraded to "no
        // condition" — that would install a policy strictly wider than the
        // rule it came from. The grant simply gets no policy, so a direct
        // reader sees nothing through it.
        continue;
      }
      const unmapped = rlsUnmappedVariables(condition);
      if (unmapped.length) {
        omissions.push({
          collection: g.collection,
          role: g.role,
          action: g.action,
          reason: `the condition uses ${unmapped.join(", ")}, which has no SQL expression — the policy would deny every row.`,
        });
        continue;
      }
    }
    const plan: RlsPolicyPlan = {
      collection: g.collection,
      table: col.physicalTable,
      role: g.role,
      action: g.action,
      name: policyName(g.collection, g.role, g.action),
      statements: policyStatements({
        collection: g.collection,
        table: col.physicalTable,
        role: g.role,
        action: g.action,
        condition,
        tenantScoped: col.tenantScoped,
        softDelete: col.softDelete,
        appliesTo,
      }),
    };
    policies.push(plan);
    coveredTables.add(col.physicalTable);
  }

  const tables = [...coveredTables].sort();
  const notOwned = await notOwnedTables(ctx, tables);
  return {
    helpers: RLS_HELPER_DDL,
    enables: tables.map(enableRlsStatement),
    policies: policies.sort((a, b) => a.name.localeCompare(b.name)),
    omissions,
    notOwned,
  };
};

const assertStandardStrings = async (ctx: Ctx): Promise<void> => {
  const res = (await (ctx.db as AnyDb).execute(
    pgSql`SELECT current_setting('standard_conforming_strings') AS v`,
  )) as unknown as { rows?: Array<{ v: string }> } | Array<{ v: string }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  if (rows[0]?.v !== "on") {
    // The literal encoder escapes by doubling `'`, which is complete only when
    // a backslash is an ordinary character. Refusing here is cheap; the
    // alternative is emitting policy text whose meaning depends on a session
    // setting nobody looked at.
    throw new AppError(
      "UNAVAILABLE",
      "`standard_conforming_strings` is off on this connection — policy literals cannot be encoded safely.",
    );
  }
};

export interface RlsApplyResult {
  applied: number;
  tables: string[];
  omissions: RlsPlan["omissions"];
  statements: number;
}

/**
 * Install the plan. Idempotent: every policy is dropped and recreated, so
 * re-running after a rule change replaces rather than accumulates.
 */
export const applyRls = async (ctx: Ctx, tenantId: string): Promise<RlsApplyResult> => {
  requirePg(ctx);
  await assertStandardStrings(ctx);
  const plan = await planRls(ctx, tenantId);
  if (plan.notOwned.length) {
    throw new AppError(
      "VALIDATION",
      `backlex does not own ${plan.notOwned.join(", ")}. Enabling row security on a table this ` +
        "connection does not own would filter backlex's own queries — with none of the session " +
        "settings a policy reads set, which means every read would return nothing. Grant ownership " +
        "or exclude those tables first.",
    );
  }
  let statements = 0;
  const run = async (text: string) => {
    await (ctx.db as AnyDb).execute(pgSql.raw(text));
    statements += 1;
  };
  for (const s of plan.helpers) await run(s);
  for (const s of plan.enables) await run(s);
  for (const p of plan.policies) {
    for (const s of p.statements) await run(s);
  }
  return {
    applied: plan.policies.length,
    tables: [...new Set(plan.policies.map((p) => p.table))].sort(),
    omissions: plan.omissions,
    statements,
  };
};

export interface InstalledPolicy {
  table: string;
  name: string;
  command: string;
}

const listInstalled = async (ctx: Ctx, tables: string[]): Promise<InstalledPolicy[]> => {
  if (tables.length === 0) return [];
  const res = (await (ctx.db as AnyDb).execute(
    pgSql`SELECT tablename AS table, policyname AS name, cmd AS command
          FROM pg_catalog.pg_policies
          WHERE tablename IN (${nameList(tables)}) AND policyname LIKE 'backlex\\_%'`,
  )) as unknown as { rows?: InstalledPolicy[] } | InstalledPolicy[];
  return Array.isArray(res) ? res : (res.rows ?? []);
};

export interface RlsStatus {
  supported: boolean;
  appliesTo: string;
  /** Policies currently installed by backlex. */
  installed: InstalledPolicy[];
  /** Policies the CURRENT rules would produce. */
  expected: Array<{ table: string; name: string }>;
  /** Installed but no longer expected — a rule was edited or removed since. */
  stale: InstalledPolicy[];
  /** Expected but not installed — a rule was added since. */
  missing: Array<{ table: string; name: string }>;
  omissions: RlsPlan["omissions"];
  notOwned: string[];
}

export const rlsStatus = async (ctx: Ctx, tenantId: string): Promise<RlsStatus> => {
  if (!rlsSupported(ctx)) {
    return {
      supported: false,
      appliesTo: rlsAppRole(ctx.env),
      installed: [],
      expected: [],
      stale: [],
      missing: [],
      omissions: [],
      notOwned: [],
    };
  }
  const plan = await planRls(ctx, tenantId);
  const expected = plan.policies.map((p) => ({ table: p.table, name: p.name }));
  // Look for installed policies on every table this workspace has, not only
  // the ones still expected — a policy left behind by a deleted rule lives on
  // a table the new plan no longer mentions, and that is exactly the one worth
  // reporting.
  const collections = await loadCollections(ctx, tenantId);
  const installed = await listInstalled(
    ctx,
    [...new Set(collections.map((c) => c.physicalTable))].sort(),
  );
  const expectedKeys = new Set(expected.map((e) => `${e.table}.${e.name}`));
  const installedKeys = new Set(installed.map((i) => `${i.table}.${i.name}`));
  return {
    supported: true,
    appliesTo: rlsAppRole(ctx.env),
    installed,
    expected,
    stale: installed.filter((i) => !expectedKeys.has(`${i.table}.${i.name}`)),
    missing: expected.filter((e) => !installedKeys.has(`${e.table}.${e.name}`)),
    omissions: plan.omissions,
    notOwned: plan.notOwned,
  };
};

/**
 * Remove everything this feature installed: backlex's own policies, then row
 * security itself on the tables that now carry none.
 *
 * Row security is only disabled on a table with no policies left after the
 * drop, so a hand-written policy somebody added stays in force. Disabling it
 * regardless would silently unprotect a table its author believed was covered.
 */
export const disableRls = async (
  ctx: Ctx,
  tenantId: string,
): Promise<{ dropped: number; disabled: string[] }> => {
  requirePg(ctx);
  const collections = await loadCollections(ctx, tenantId);
  const tables = [...new Set(collections.map((c) => c.physicalTable))].sort();
  const installed = await listInstalled(ctx, tables);
  for (const p of installed) {
    await (ctx.db as AnyDb).execute(pgSql.raw(dropPolicyStatement(p.table, p.name)));
  }
  const disabled: string[] = [];
  for (const table of tables) {
    const res = (await (ctx.db as AnyDb).execute(
      pgSql`SELECT count(*)::int AS n FROM pg_catalog.pg_policies WHERE tablename = ${table}`,
    )) as unknown as { rows?: Array<{ n: number }> } | Array<{ n: number }>;
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    if ((rows[0]?.n ?? 0) === 0) {
      await (ctx.db as AnyDb).execute(pgSql.raw(disableRlsStatement(table)));
      disabled.push(table);
    }
  }
  return { dropped: installed.length, disabled };
};
