/**
 * The permission DSL, compiled to Postgres row-level security.
 *
 * ## Why this exists
 *
 * Our permission model is app-layer: `compileCondition` turns a stored rule
 * into a `WHERE` fragment on the way through the API. That is complete for
 * anything that comes through the API — and it is nothing at all for anything
 * that does not. A BI tool, `psql`, a warehouse connector, a Metabase
 * dashboard, an analytics job: each of those opens a connection and reads the
 * physical table, and every row condition an operator wrote is simply absent.
 *
 * That is the one argument a database-native permission model genuinely wins,
 * and it is winnable here without a second rule language: `compileCondition`
 * already emits parameterized SQL from the same stored condition, so the only
 * thing that has to change is what a VARIABLE becomes. Per request `$user.id`
 * is the caller's id; in a policy it is `backlex.uid()`, resolved by Postgres
 * for whoever is connected. That is the `varSql` seam in `permission.ts`.
 *
 * ## The decisions that make it safe to turn on
 *
 * **`ENABLE`, never `FORCE`.** A table's owner is exempt from its own row
 * security unless `FORCE ROW LEVEL SECURITY` is set. backlex connects as the
 * owner, so enabling RLS cannot change one thing the API does — the policies
 * only ever apply to somebody ELSE's connection. `FORCE` would put the entire
 * product behind rules meant for a reporting tool. The apply path REFUSES when
 * the connection is not the table owner, because there the same statement
 * would silently start filtering us.
 *
 * **Policies are `TO PUBLIC` by default.** Not because it is permissive — the
 * opposite. A policy bound to a named role leaves every OTHER role unfiltered,
 * so the next connection somebody creates is a hole. `PUBLIC` plus owner-bypass
 * means: backlex is unaffected, and everyone else is filtered from the moment
 * they connect.
 *
 * **Literals are inlined, and that is the risky part, so it is one function.**
 * `CREATE POLICY` takes no parameters, so a compiled fragment's bound values
 * have to become literals. {@link pgLiteral} is the only place that happens; it
 * accepts five shapes and throws on anything else rather than guessing.
 *
 * **What cannot be represented is REFUSED and reported, never approximated.**
 * A field allow-list is column-level and does not survive the union across the
 * roles a session holds; a nested relation path lowers to a correlated subquery
 * that would need the joined table's own policy to agree; `_near` is a filter
 * over a query origin, which a policy has no caller to take one from. Each of
 * those comes back in the plan as a stated omission, so an operator reading the
 * plan learns that the direct-connection view is COARSER than the API's rather
 * than believing they match.
 */
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AuthSubject, Condition } from "@backlex/core";
import { compileCondition } from "./permission";

/** Schema the helper functions live in. */
export const RLS_SCHEMA = "backlex";

/**
 * DSL variable → SQL expression. This mapping IS the contract a direct
 * connection has to satisfy: whatever sets these settings decides who the
 * connection is, exactly as a session cookie does for the API.
 */
const VAR_SQL: Record<string, string> = {
  "$user.id": "backlex.uid()",
  "$user.email": "backlex.email()",
  "$user.roles": "backlex.roles()",
  "$tenant.id": "backlex.tenant_id()",
  "$user.tenant_id": "backlex.tenant_id()",
  "$org.id": "backlex.org_id()",
  "$org.role": "backlex.org_role()",
  "$user.orgs": "backlex.orgs()",
  $now: "now()",
};

export const rlsVarSql = (v: string): SQL | null => {
  const expr = VAR_SQL[v];
  return expr ? sql.raw(expr) : null;
};

/**
 * The helper schema.
 *
 * `backlex.claim` is the whole identity surface, and it answers THREE ways, not
 * two: the setting is absent, the setting is readable, or a `request.jwt.claims`
 * blob is present and cannot be parsed. The third returns NULL — an unreadable
 * claim is NO claim. Returning something more forgiving would make a corrupt
 * session string read as a valid identity, which is the failure mode every
 * "resolve the rule, then apply it" helper in this codebase has shipped at
 * least once.
 *
 * Two spellings are accepted because two kinds of client exist: a BI tool that
 * can run `SET`, and a PostgREST-shaped one that already puts a JWT's claims in
 * `request.jwt.claims`. Neither is preferred; the explicit setting wins simply
 * because it is the more specific statement.
 */
export const RLS_HELPER_DDL: string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${RLS_SCHEMA}`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.claim(k text) RETURNS text
   LANGUAGE plpgsql STABLE AS $fn$
   DECLARE v text;
   BEGIN
     v := NULLIF(current_setting('${RLS_SCHEMA}.' || k, true), '');
     IF v IS NOT NULL THEN RETURN v; END IF;
     BEGIN
       v := NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> k, '');
     EXCEPTION WHEN others THEN
       -- Unreadable claims are NO claims. Never everyone's claims.
       v := NULL;
     END;
     RETURN v;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.uid() RETURNS text
   LANGUAGE sql STABLE AS $fn$ SELECT ${RLS_SCHEMA}.claim('user_id') $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.email() RETURNS text
   LANGUAGE sql STABLE AS $fn$ SELECT ${RLS_SCHEMA}.claim('email') $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.tenant_id() RETURNS text
   LANGUAGE sql STABLE AS $fn$ SELECT ${RLS_SCHEMA}.claim('tenant_id') $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.org_id() RETURNS text
   LANGUAGE sql STABLE AS $fn$ SELECT ${RLS_SCHEMA}.claim('org_id') $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.org_role() RETURNS text
   LANGUAGE sql STABLE AS $fn$ SELECT ${RLS_SCHEMA}.claim('org_role') $fn$`,
  // A list setting is comma-separated (`SET backlex.roles = 'editor,viewer'`)
  // or a JSON array in the claims blob. An absent list is the EMPTY array, not
  // NULL: `x = ANY(NULL)` is NULL, which a policy reads as "no", but so is
  // `NOT (x = ANY(NULL))` — a NULL list would make a `_nin` rule deny too, and
  // "you are in no roles" has to mean the negative rule PASSES.
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.roles() RETURNS text[]
   LANGUAGE plpgsql STABLE AS $fn$
   DECLARE raw text; out text[];
   BEGIN
     raw := NULLIF(current_setting('${RLS_SCHEMA}.roles', true), '');
     IF raw IS NOT NULL THEN
       RETURN ARRAY(SELECT btrim(x) FROM unnest(string_to_array(raw, ',')) AS x WHERE btrim(x) <> '');
     END IF;
     BEGIN
       SELECT ARRAY(SELECT jsonb_array_elements_text(
         current_setting('request.jwt.claims', true)::jsonb -> 'roles')) INTO out;
     EXCEPTION WHEN others THEN
       out := NULL;
     END;
     RETURN COALESCE(out, ARRAY[]::text[]);
   END $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.orgs() RETURNS text[]
   LANGUAGE plpgsql STABLE AS $fn$
   DECLARE raw text; out text[];
   BEGIN
     raw := NULLIF(current_setting('${RLS_SCHEMA}.orgs', true), '');
     IF raw IS NOT NULL THEN
       RETURN ARRAY(SELECT btrim(x) FROM unnest(string_to_array(raw, ',')) AS x WHERE btrim(x) <> '');
     END IF;
     BEGIN
       SELECT ARRAY(SELECT jsonb_array_elements_text(
         current_setting('request.jwt.claims', true)::jsonb -> 'orgs')) INTO out;
     EXCEPTION WHEN others THEN
       out := NULL;
     END;
     RETURN COALESCE(out, ARRAY[]::text[]);
   END $fn$`,
  `CREATE OR REPLACE FUNCTION ${RLS_SCHEMA}.has_role(r text) RETURNS boolean
   LANGUAGE sql STABLE AS $fn$ SELECT r = ANY(${RLS_SCHEMA}.roles()) $fn$`,
  // Every policy CALLS these, so a connection without USAGE on the schema does
  // not get filtered — it gets `permission denied for schema backlex` and the
  // query fails outright. Found by running the policies as a second role
  // rather than by reading them: a reporting tool would have hit an error
  // where the operator expected a narrower result set. Granting execute is
  // safe on its own terms — the functions only READ session settings the
  // caller already controls.
  `GRANT USAGE ON SCHEMA ${RLS_SCHEMA} TO PUBLIC`,
  `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${RLS_SCHEMA} TO PUBLIC`,
];

/**
 * Encode one value as a Postgres literal.
 *
 * The ONLY place a value is spliced into DDL, because `CREATE POLICY` accepts
 * no parameters. Five shapes are accepted and everything else throws: a
 * compiler that guessed at an unfamiliar value is a compiler that can emit a
 * policy meaning something other than the rule it came from.
 *
 * Strings are quoted by doubling `'`. That is sufficient and complete when
 * `standard_conforming_strings` is on, where a backslash is an ordinary
 * character — which is the default since 9.1 and which the apply path VERIFIES
 * rather than assumes.
 */
export const pgLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`Cannot express ${String(v)} as a SQL literal`);
    }
    return String(v);
  }
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === "string") {
    if (v.includes("\u0000")) {
      throw new Error("A NUL byte cannot appear in a SQL literal");
    }
    return `'${v.replaceAll("'", "''")}'`;
  }
  throw new Error(`Cannot express a ${typeof v} as a SQL literal`);
};

const PG = new PgDialect();

/** Render a compiled fragment to standalone SQL text, inlining its bound
 *  values as literals. */
export const renderInline = (fragment: SQL): string => {
  const { sql: text, params } = PG.sqlToQuery(fragment);
  // drizzle emits positional `$1`, `$2`, … — each is replaced by its literal.
  //
  // NOT a regex over the whole string. drizzle never inlines a VALUE (every
  // one is a parameter), but it does inline IDENTIFIERS, quoted with `"`, and
  // a column may legally be called `a$1` — an adopted table can carry any
  // name. A blind `/\$(\d+)/g` would rewrite the inside of that identifier
  // with a caller-influenced literal. So the scan skips quoted identifiers,
  // which is the only place a `$` can appear that is not a placeholder.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // A quoted identifier, `""` being an escaped quote inside it.
      out += ch;
      i += 1;
      while (i < text.length) {
        out += text[i];
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            out += text[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < text.length && text[j]! >= "0" && text[j]! <= "9") j += 1;
      if (j > i + 1) {
        const idx = Number(text.slice(i + 1, j)) - 1;
        if (idx < 0 || idx >= params.length) {
          throw new Error(`Placeholder $${idx + 1} has no bound value`);
        }
        out += pgLiteral(params[idx]);
        i = j;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
};

// --- What can and cannot be expressed ---------------------------------------

/** A part of a permission this compiler will not pretend to represent. */
export interface RlsOmission {
  collection: string;
  role: string;
  action: string;
  reason: string;
}

const OMISSION_REASONS = {
  nested:
    "the condition walks a relation (a dotted path). That lowers to a correlated subquery, which would need the joined table's own policy to agree — approximating it would let a direct reader see rows the API hides.",
  near: "`_near` filters against a query origin, and a policy has no caller to take one from.",
  fields:
    "the grant carries a field allow-list. Column privileges are per database role, and the union across the backlex roles one session holds cannot be expressed as one — so a direct reader sees every column of the rows it may read.",
} as const;

/** Does this condition contain anything the policy compiler must refuse? */
export const rlsBlockers = (cond: Condition): string[] => {
  const out: string[] = [];
  const walk = (c: Condition): void => {
    const o = c as Record<string, unknown>;
    if (Array.isArray(o.$and)) {
      for (const x of o.$and) walk(x as Condition);
      return;
    }
    if (Array.isArray(o.$or)) {
      for (const x of o.$or) walk(x as Condition);
      return;
    }
    if (o.$not !== undefined) {
      walk(o.$not as Condition);
      return;
    }
    for (const [key, cmp] of Object.entries(o)) {
      if (key.includes(".")) out.push(OMISSION_REASONS.nested);
      if (cmp && typeof cmp === "object" && "_near" in (cmp as object)) {
        out.push(OMISSION_REASONS.near);
      }
    }
  };
  walk(cond);
  return [...new Set(out)];
};

/**
 * The empty subject a policy is compiled against.
 *
 * Every variable is mapped to a SQL expression by `rlsVarSql`, so no field of
 * this is ever read — it exists because `compileCondition` takes one. If a
 * variable is ever added to the DSL without a mapping here, it resolves
 * against THIS, i.e. to null, and a comparison against null compiles to FALSE.
 * The policy denies rather than admits. That is the right way round for the
 * failure, and `rlsUnmappedVariables` reports it so it does not stay silent.
 */
const POLICY_SUBJECT: AuthSubject = { userId: null, email: null, roles: [] };

/** DSL variables this compiler has no SQL expression for. Reported by the plan
 *  so a rule that would silently deny is visible before it is applied. */
export const rlsUnmappedVariables = (cond: Condition): string[] => {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string" && v.startsWith("$") && !(v in VAR_SQL)) out.add(v);
    else if (Array.isArray(v)) for (const x of v) visit(x);
  };
  const walk = (c: Condition): void => {
    const o = c as Record<string, unknown>;
    if (Array.isArray(o.$and)) {
      for (const x of o.$and) walk(x as Condition);
      return;
    }
    if (Array.isArray(o.$or)) {
      for (const x of o.$or) walk(x as Condition);
      return;
    }
    if (o.$not !== undefined) {
      walk(o.$not as Condition);
      return;
    }
    for (const cmp of Object.values(o)) {
      if (cmp && typeof cmp === "object") for (const v of Object.values(cmp)) visit(v);
    }
  };
  walk(cond);
  return [...out];
};

/** Compile a stored condition to a standalone policy expression. */
export const compileConditionToPolicy = (cond: Condition): string =>
  renderInline(
    compileCondition(cond, POLICY_SUBJECT, undefined, undefined, { dialect: "pg", varSql: rlsVarSql }),
  );

// --- Policy statements ------------------------------------------------------

export type RlsAction = "read" | "create" | "update" | "delete";

const COMMAND: Record<RlsAction, "SELECT" | "INSERT" | "UPDATE" | "DELETE"> = {
  read: "SELECT",
  create: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

/** Quote an identifier for DDL. */
export const pgIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * A policy name has to be stable (so re-applying replaces rather than
 * accumulates), unique per (table, role, action), and under Postgres's 63-byte
 * identifier limit. A long collection slug plus a long role name exceeds that
 * easily, so anything over the budget is truncated and disambiguated by a hash
 * of the full triple — truncation alone would collide two policies into one.
 */
export const policyName = (collection: string, role: string, action: RlsAction): string => {
  const full = `backlex_${collection}_${role}_${action}`;
  if (full.length <= 63) return full;
  let h = 2166136261;
  for (let i = 0; i < full.length; i += 1) {
    h ^= full.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const suffix = `_${(h >>> 0).toString(36)}`;
  return full.slice(0, 63 - suffix.length) + suffix;
};

export interface PolicyInput {
  collection: string;
  table: string;
  role: string;
  action: RlsAction;
  /** null = the grant carries no row condition. */
  condition: Condition | null;
  /** ANDed in when the collection is workspace-scoped. */
  tenantScoped: boolean;
  /** ANDed into read/update/delete so a direct reader sees what the API would. */
  softDelete: boolean;
  /** Role the policy applies to; `PUBLIC` unless the deployment names one. */
  appliesTo: string;
}

/**
 * The full set of statements for one (collection, role, action).
 *
 * `USING` and `WITH CHECK` are not the same question: `USING` decides which
 * existing rows this session can SEE, `WITH CHECK` decides which rows it may
 * PRODUCE. An INSERT has only the second (there is no existing row); an UPDATE
 * has both, and giving it only `USING` would let a session move a row out of
 * its own scope in one statement.
 */
export const policyStatements = (input: PolicyInput): string[] => {
  const name = pgIdent(policyName(input.collection, input.role, input.action));
  const table = pgIdent(input.table);
  const clauses: string[] = [`${RLS_SCHEMA}.has_role(${pgLiteral(input.role)})`];
  if (input.tenantScoped) {
    clauses.push(`${pgIdent("tenant_id")} = ${RLS_SCHEMA}.tenant_id()`);
  }
  // Soft-deleted rows are not part of what the API returns, so a direct reader
  // must not find them either. INSERT is exempt: a new row has no prior state
  // to have been deleted, and a WITH CHECK on it would only restate the column
  // default.
  if (input.softDelete && input.action !== "create") {
    clauses.push(`${pgIdent("deleted_at")} IS NULL`);
  }
  if (input.condition) clauses.push(compileConditionToPolicy(input.condition));
  const expr = clauses.join(" AND ");
  const command = COMMAND[input.action];
  const to = input.appliesTo.toUpperCase() === "PUBLIC" ? "PUBLIC" : pgIdent(input.appliesTo);

  const body =
    command === "INSERT"
      ? `WITH CHECK (${expr})`
      : command === "UPDATE"
        ? `USING (${expr}) WITH CHECK (${expr})`
        : `USING (${expr})`;

  return [
    // Dropped first so re-applying is idempotent: `CREATE POLICY` has no
    // `OR REPLACE`, and an `IF NOT EXISTS` would leave a stale policy in place
    // after a rule changed — which is worse than either, because the operator
    // would believe the new rule was live.
    `DROP POLICY IF EXISTS ${name} ON ${table}`,
    `CREATE POLICY ${name} ON ${table} AS PERMISSIVE FOR ${command} TO ${to} ${body}`,
  ];
};

export const enableRlsStatement = (table: string): string =>
  `ALTER TABLE ${pgIdent(table)} ENABLE ROW LEVEL SECURITY`;

export const disableRlsStatement = (table: string): string =>
  `ALTER TABLE ${pgIdent(table)} DISABLE ROW LEVEL SECURITY`;

export const dropPolicyStatement = (table: string, name: string): string =>
  `DROP POLICY IF EXISTS ${pgIdent(name)} ON ${pgIdent(table)}`;
