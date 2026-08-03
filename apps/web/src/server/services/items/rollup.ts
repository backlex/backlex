import { eq, sql, type SQL } from "drizzle-orm";
import {
  collectConditionFields,
  compileCondition,
  currencyExponent,
  normalizeCurrency,
  rollupRefreshSql,
  type FieldDef,
  type RollupSpec,
} from "@backlex/db";
import type { AuthSubject, Condition } from "@backlex/core";
import { AppError } from "@backlex/core";
import type { Ctx } from "../../context";
import { getCachedRollupDeps, setCachedRollupDeps } from "../collections-cache";
import { collectionsTable, loadCollection, type CollectionRow } from "./collection-loader";
import { execute } from "./sql-helpers";

/**
 * Rollup fields at runtime — keeping a parent's aggregate column in step with
 * the child rows it summarises.
 *
 * The write path calls {@link rollupRefreshStatements} after every child
 * create / update / delete; it returns statements the caller pushes through the
 * SAME `emit` chokepoint as the row write itself, so a refresh joins an atomic
 * batch's transaction and rolls back with it. Nothing here reads the total
 * first — see the module note on `@backlex/db`'s `rollupRefreshSql` for why a
 * read-modify-write would be unsound under concurrency.
 *
 * Direction of the dependency is worth holding onto: a rollup is declared on
 * the PARENT (`invoices.subtotal` says "sum invoice_lines.line_total"), but it
 * is refreshed by writes to the CHILD. So the write path needs the reverse
 * index — "who rolls up FROM this collection?" — which is what
 * {@link rollupDependentsOf} builds.
 *
 * @module
 */

/**
 * The parts of a collection a refresh statement actually reads. Deliberately
 * structural rather than the full `CollectionRow`: the GraphQL layer carries
 * its own narrower twin of that type, and both write paths have to be able to
 * call in here — which is the entire point of putting the refresh in one place.
 */
export interface RollupCollection {
  slug: string;
  physicalTable: string;
  tenantScoped: boolean;
  softDelete: boolean;
}

/** One rollup column that aggregates over a given child collection. */
export interface RollupDependent {
  /** Slug of the collection owning the rollup column (the parent). */
  parentSlug: string;
  parentTable: string;
  parentPk: string;
  parentTenantScoped: boolean;
  /** The rollup column on the parent. */
  column: string;
  spec: RollupSpec;
  /**
   * Child fields whose value can change this aggregate: the FK itself, the
   * aggregated field, and everything the filter reads. An update touching none
   * of them cannot move the total, so it skips the refresh.
   */
  watched: Set<string>;
}

const watchedFieldsOf = (spec: RollupSpec): Set<string> => {
  const out = new Set<string>([spec.via]);
  if (spec.field) out.add(spec.field);
  if (spec.filter) collectConditionFields(spec.filter, out);
  return out;
};

/**
 * A stable digest of a collection's rollup definitions. Two field lists with
 * the same signature produce identical totals, so a schema PATCH only needs to
 * backfill when this moves — the same test the FTS backfill applies to its own
 * index inputs.
 */
export const rollupSignature = (fields: FieldDef[]): string =>
  JSON.stringify(
    fields
      .filter((f) => f.rollup)
      .map((f) => [f.name, f.rollup?.from, f.rollup?.via, f.rollup?.fn, f.rollup?.field, f.rollup?.filter ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

/**
 * Every rollup column, across the tenant's active collections, that aggregates
 * over `childSlug`. Empty for the overwhelming majority of collections, which
 * is the case worth being fast: one cached empty array and the write path adds
 * nothing.
 *
 * Cached in `collections-cache` so it is dropped by the same
 * `invalidateTenantCollections` every schema mutation already calls. The TTL
 * bounds how long a SIBLING isolate can keep a stale index after a schema
 * change it didn't perform; drift from that window is recoverable, and
 * recovering it is what the refresh endpoint is for.
 */
export const rollupDependentsOf = async (
  ctx: Ctx,
  tenantId: string,
  childSlug: string,
): Promise<RollupDependent[]> => {
  const hit = getCachedRollupDeps(tenantId, childSlug);
  if (hit) return hit;

  const t = collectionsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Record<string, unknown>[];
  const out: RollupDependent[] = [];
  for (const r of rows) {
    if (((r.status ?? "active") as string) !== "active") continue;
    const fields = (r.fields ?? []) as FieldDef[];
    for (const f of fields) {
      const spec = f.rollup;
      if (!spec || spec.from !== childSlug) continue;
      out.push({
        parentSlug: r.slug as string,
        parentTable: (r.physicalTable ?? r.physical_table) as string,
        parentPk: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
        parentTenantScoped: (r.tenantScoped ?? r.tenant_scoped ?? true) ? true : false,
        column: f.name,
        spec,
        watched: watchedFieldsOf(spec),
      });
    }
  }
  setCachedRollupDeps(tenantId, childSlug, out);
  return out;
};

// --- Statement building -----------------------------------------------------

/**
 * The child-side predicate: the declared `rollup.filter` plus the child's own
 * tenant and soft-delete scoping, every column qualified with the child table
 * (the parent table is in scope too inside the correlated subquery, and an
 * unqualified `deleted_at` would be ambiguous the moment both carry one).
 *
 * A soft-deleted child never counts. That's the one membership rule the filter
 * cannot express and the one every caller expects: deleting a line has to take
 * its money off the invoice, whether the delete was hard or soft.
 */
const childPredicate = (
  child: RollupCollection,
  spec: RollupSpec,
  tenantId: string | null | undefined,
  dialect: "pg" | "sqlite",
): SQL | null => {
  const parts: SQL[] = [];
  if (child.tenantScoped && tenantId) {
    parts.push(
      sql`${sql.identifier(child.physicalTable)}.${sql.identifier("tenant_id")} = ${tenantId}`,
    );
  }
  if (child.softDelete) {
    parts.push(
      sql`${sql.identifier(child.physicalTable)}.${sql.identifier("deleted_at")} IS NULL`,
    );
  }
  if (spec.filter) {
    // The filter is validated at save time to carry no `$user`/`$tenant`/
    // `$org`/`$now` reference, so the subject below is never consulted — a
    // rollup is one stored number for every reader and must not vary by who
    // triggered the refresh.
    const neutral: AuthSubject = { userId: null, email: null, roles: [], tenantId: null };
    parts.push(
      compileCondition(
        spec.filter as Condition,
        neutral,
        (field) =>
          sql`${sql.identifier(child.physicalTable)}.${sql.identifier(field)}`,
        undefined,
        { dialect },
      ),
    );
  }
  if (parts.length === 0) return null;
  return sql.join(parts, sql` AND `);
};

/** Statements restating `dep` for the given parent ids (deduped, nulls dropped). */
const statementsFor = (
  dep: RollupDependent,
  child: RollupCollection,
  parentIds: string[],
  tenantId: string | null | undefined,
  dialect: "pg" | "sqlite",
): SQL[] => {
  const ids = [...new Set(parentIds.filter((v) => v !== ""))];
  if (ids.length === 0) return [];
  const childWhere = childPredicate(child, dep.spec, tenantId, dialect);
  const pkRef = sql`${sql.identifier(dep.parentTable)}.${sql.identifier(dep.parentPk)}`;
  const target =
    ids.length === 1
      ? sql`${pkRef} = ${ids[0]}`
      : sql`${pkRef} IN (${sql.join(ids.map((v) => sql`${v}`), sql`, `)})`;
  // Scope the UPDATE to the tenant as well — the id came off a row this caller
  // could write, but the parent table is shared across tenants and a bare
  // `WHERE id = ?` would be one mis-set id away from writing someone else's row.
  const scoped =
    dep.parentTenantScoped && tenantId
      ? sql`${target} AND ${sql.identifier(dep.parentTable)}.${sql.identifier("tenant_id")} = ${tenantId}`
      : target;
  return [
    rollupRefreshSql({
      parentTable: dep.parentTable,
      parentPk: dep.parentPk,
      column: dep.column,
      childTable: child.physicalTable,
      childFk: dep.spec.via,
      fn: dep.spec.fn,
      ...(dep.spec.field !== undefined ? { field: dep.spec.field } : {}),
      childWhere,
      parentWhere: scoped,
    }),
  ];
};

/** Read a child row's FK value as the parent id string, or "" when absent. */
const fkValue = (row: Record<string, unknown> | undefined, via: string): string => {
  const v = row?.[via];
  return v === undefined || v === null ? "" : String(v);
};

export interface RollupChange {
  /** The child row as it was before the write (update / delete). */
  before?: Record<string, unknown>;
  /** The child row's incoming values (create) or patch (update). */
  after?: Record<string, unknown>;
  /** Skip the "did this write touch a watched field?" shortcut. Set for create
   *  and delete, where the row's arrival / departure moves the total whatever
   *  its columns say. */
  always?: boolean;
}

/**
 * Refresh statements for one child write. Returns `[]` — with no DB round-trip
 * beyond the cached reverse index — when nothing rolls up over this collection.
 *
 * Both sides of a re-parenting are covered: moving a line from invoice A to
 * invoice B has to take the money off A as well as put it on B, so the before
 * and after FK values are each refreshed.
 */
export const rollupRefreshStatements = async (
  ctx: Ctx,
  child: RollupCollection,
  tenantId: string | null | undefined,
  change: RollupChange,
): Promise<SQL[]> => {
  if (!tenantId) return [];
  const deps = await rollupDependentsOf(ctx, tenantId, child.slug);
  if (deps.length === 0) return [];
  const stmts: SQL[] = [];
  for (const dep of deps) {
    if (!change.always) {
      const touched = Object.keys(change.after ?? {}).some((k) => dep.watched.has(k));
      if (!touched) continue;
    }
    const ids: string[] = [];
    // On an update the patch may omit the FK entirely (only the amount
    // changed), in which case the parent is whatever it already was.
    const beforeId = fkValue(change.before, dep.spec.via);
    const afterId =
      change.after && Object.hasOwn(change.after, dep.spec.via)
        ? fkValue(change.after, dep.spec.via)
        : beforeId;
    if (beforeId) ids.push(beforeId);
    if (afterId) ids.push(afterId);
    stmts.push(...statementsFor(dep, child, ids, tenantId, ctx.dialect));
  }
  return stmts;
};

/**
 * Tenant-wide refresh statements for every rollup that aggregates over
 * `childSlug` — every parent row restated, not just one.
 *
 * The blunt instrument, for the one caller that cannot name the parents it
 * affected: the app-layer ON DELETE triggers. Those remove or detach child rows
 * with raw set-based SQL (`DELETE … WHERE fk = ?`), so there is no per-row
 * write to hang a targeted refresh off, and reading back the victims' FKs just
 * to narrow the statement would cost more than restating the column. One
 * statement per rollup field, and only when a trigger actually fired.
 */
export const rollupRefreshAllStatements = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  childSlug: string,
): Promise<SQL[]> => {
  if (!tenantId) return [];
  const deps = await rollupDependentsOf(ctx, tenantId, childSlug);
  if (deps.length === 0) return [];
  const child = await loadCollection(ctx, tenantId, childSlug).catch(() => null);
  if (!child) return [];
  return deps.map((dep) =>
    rollupRefreshSql({
      parentTable: dep.parentTable,
      parentPk: dep.parentPk,
      column: dep.column,
      childTable: child.physicalTable,
      childFk: dep.spec.via,
      fn: dep.spec.fn,
      ...(dep.spec.field !== undefined ? { field: dep.spec.field } : {}),
      childWhere: childPredicate(child, dep.spec, tenantId, ctx.dialect),
      parentWhere: dep.parentTenantScoped
        ? sql`${sql.identifier(dep.parentTable)}.${sql.identifier("tenant_id")} = ${tenantId}`
        : sql`1=1`,
    }),
  );
};

// --- Backfill / repair ------------------------------------------------------

/**
 * Restate every parent row's rollup column across the whole tenant, in one
 * statement per rollup field.
 *
 * Two callers, one job. The schema applier runs it when a rollup field is
 * ADDED, because the parents already exist and their new column would otherwise
 * read its DDL default forever. And the repair endpoint runs it on demand,
 * because a few paths deliberately bypass the per-write refresh: a restore or a
 * template seed writes rows wholesale, the cascade half of `onDelete` removes
 * children with raw SQL, and a sibling isolate can hold a stale reverse index
 * for up to the cache TTL. None of those corrupt anything a single pass can't
 * put right — which is exactly why the pass is worth having rather than trying
 * to make every bulk path re-derive totals row by row.
 *
 * Returns the rollup columns it refreshed.
 */
export const refreshCollectionRollups = async (
  ctx: Ctx,
  tenantId: string,
  parent: RollupCollection & { fields: FieldDef[]; pkColumn: string },
): Promise<string[]> => {
  const done: string[] = [];
  for (const f of parent.fields) {
    const spec = f.rollup;
    if (!spec) continue;
    const child = await loadCollection(ctx, tenantId, spec.from);
    const childWhere = childPredicate(child, spec, tenantId, ctx.dialect);
    const parentWhere =
      parent.tenantScoped
        ? sql`${sql.identifier(parent.physicalTable)}.${sql.identifier("tenant_id")} = ${tenantId}`
        : sql`1=1`;
    await execute(
      ctx,
      rollupRefreshSql({
        parentTable: parent.physicalTable,
        parentPk: parent.pkColumn,
        column: f.name,
        childTable: child.physicalTable,
        childFk: spec.via,
        fn: spec.fn,
        ...(spec.field !== undefined ? { field: spec.field } : {}),
        childWhere,
        parentWhere,
      }),
    );
    done.push(f.name);
  }
  return done;
};

// --- Save-time cross-collection validation ----------------------------------

/**
 * The half of rollup validation that needs to read another collection:
 * `@backlex/db`'s `validateRollupSpec` checks the spec's own shape, this checks
 * it against the collection it names.
 *
 * Lives in a service, not on the collections route, for the reason #37 already
 * paid for once: a guard that ships on one surface is a guard the other surface
 * doesn't have. Every path that stores a collection's fields calls this.
 */
/**
 * Refuse a rollup whose two ends are not denominated the same way.
 *
 * `rollupRefreshSql` moves integers: `SET total = (SELECT SUM(amount) FROM …)`.
 * Nothing in that statement knows what a minor unit is, so the parent column
 * ends up holding whatever the children's integers add up to. That is exactly
 * right when both sides are the same currency with the same exponent, and
 * silently wrong in every other case:
 *
 *  - **A money child into a plain number parent** — the parent stores `199900`
 *    and prints it as a number, so an invoice for `1999.00` shows as nearly two
 *    hundred thousand.
 *  - **Different currencies** — summing a column of dollars into a lira total
 *    is the mixed-currency addition this type exists to prevent, just spread
 *    across two collections so no single row looks wrong.
 *  - **Different exponents** — `JPY` into a `USD` column is out by a hundred
 *    even though both are "money".
 *  - **A per-row-currency child** — the SUM adds every denomination in the
 *    table together before the parent ever sees it.
 *
 * All four are rejected at save time, where an admin can still change their
 * mind, rather than at refresh time where the only evidence is a wrong total.
 */
const assertRollupCurrenciesAgree = (
  where: string,
  parentField: FieldDef,
  childField: FieldDef,
  childSlug: string,
  childName: string,
): void => {
  const ref = `"${childSlug}.${childName}"`;
  if (parentField.type !== "money") {
    throw new AppError(
      "VALIDATION",
      `${where}: ${ref} is money, so the field that totals it must be money too — a plain number column would store minor units and print them as an amount`,
    );
  }
  if (childField.type !== "money") {
    throw new AppError(
      "VALIDATION",
      `${where}: this field is money but ${ref} is ${childField.type} — a total in a currency cannot be built from values that are not in one`,
    );
  }
  const childPer = childField.money?.currencyField;
  if (childPer) {
    throw new AppError(
      "VALIDATION",
      `${where}: ${ref} holds a different currency per row ("${childPer}"), so summing it would add denominations together. Split the children per currency, or fix ${ref} to one.`,
    );
  }
  const parentPer = parentField.money?.currencyField;
  if (parentPer) {
    throw new AppError(
      "VALIDATION",
      `${where}: a rollup total cannot take its currency from another column ("${parentPer}") — the total is written by the server, and nothing would keep that column in step with it`,
    );
  }
  const childCurrency = normalizeCurrency(childField.money?.currency);
  const parentCurrency = normalizeCurrency(parentField.money?.currency);
  if (childCurrency !== parentCurrency) {
    throw new AppError(
      "VALIDATION",
      `${where}: this field is in ${parentCurrency} but ${ref} is in ${childCurrency} — there is no exchange rate in a SUM`,
    );
  }
  if (
    currencyExponent(parentCurrency, parentField.money) !==
    currencyExponent(childCurrency, childField.money)
  ) {
    throw new AppError(
      "VALIDATION",
      `${where}: this field and ${ref} are both ${parentCurrency} but count minor units differently`,
    );
  }
  if (Boolean(parentField.money?.storage === "decimal") !== Boolean(childField.money?.storage === "decimal")) {
    throw new AppError(
      "VALIDATION",
      `${where}: this field and ${ref} store amounts differently (one in minor units, one as a decimal) — the sum would be out by a factor of ${10 ** currencyExponent(parentCurrency, parentField.money)}`,
    );
  }
};

export const validateRollupTargets = async (
  ctx: Ctx,
  tenantId: string,
  parent: { slug: string; pkType?: string },
  fields: FieldDef[],
): Promise<void> => {
  for (const f of fields) {
    const spec = f.rollup;
    if (!spec) continue;
    const where = `Field "${f.name}"`;
    if (spec.from === parent.slug) {
      throw new AppError(
        "VALIDATION",
        `${where}: a rollup cannot aggregate over its own collection`,
      );
    }
    // The child's FK holds the parent's id as TEXT. An integer-keyed parent
    // (external-DB migration is what creates those) would compare TEXT to
    // INTEGER — an error on Postgres, and worse on SQLite, where affinity makes
    // it simply match nothing and every total reads 0.
    if (parent.pkType === "integer") {
      throw new AppError(
        "VALIDATION",
        `${where}: rollups are not supported on integer-keyed collections — the relation column stores ids as text`,
      );
    }
    let child: CollectionRow;
    try {
      child = await loadCollection(ctx, tenantId, spec.from);
    } catch {
      throw new AppError(
        "VALIDATION",
        `${where}: rollup.from references collection "${spec.from}", which does not exist`,
      );
    }
    const via = child.fields.find((c) => c.name === spec.via);
    if (!via) {
      throw new AppError(
        "VALIDATION",
        `${where}: "${spec.from}" has no field "${spec.via}" to relate back through`,
      );
    }
    if (via.type !== "relation") {
      throw new AppError(
        "VALIDATION",
        `${where}: "${spec.from}.${spec.via}" is a ${via.type} field — rollup.via must be a relation (relation_many holds a list, which is not a single parent)`,
      );
    }
    if (via.to !== parent.slug) {
      throw new AppError(
        "VALIDATION",
        `${where}: "${spec.from}.${spec.via}" points at "${via.to}", not "${parent.slug}"`,
      );
    }
    if (spec.field) {
      const target = child.fields.find((c) => c.name === spec.field);
      if (!target) {
        throw new AppError(
          "VALIDATION",
          `${where}: "${spec.from}" has no field "${spec.field}" to ${spec.fn}`,
        );
      }
      if (target.type !== "integer" && target.type !== "number" && target.type !== "money") {
        throw new AppError(
          "VALIDATION",
          `${where}: "${spec.from}.${spec.field}" is a ${target.type} field — ${spec.fn} needs a number`,
        );
      }
      // Money must agree at both ends, and the check is the whole reason the
      // type exists. The refresh is `SET total = (SELECT SUM(amount) …)`: raw
      // integers moving from one column to another, with no scaling and no
      // interpretation. So the two columns have to mean the same thing.
      if (target.type === "money" || f.type === "money") {
        assertRollupCurrenciesAgree(where, f, target, spec.from, spec.field);
      }
    }
    // A rollup over a rollup would need the inner one to have settled before
    // the outer one reads it, and the refresh statements are emitted in write
    // order with no such guarantee — the outer total would lag by one write and
    // there'd be nothing to make it catch up.
    if (spec.field) {
      const target = child.fields.find((c) => c.name === spec.field);
      if (target?.rollup) {
        throw new AppError(
          "VALIDATION",
          `${where}: "${spec.from}.${spec.field}" is itself a rollup — chaining them would leave the outer total one write behind`,
        );
      }
    }
    for (const name of watchedFieldsOf(spec)) {
      if (name === spec.via || name === spec.field) continue;
      if (!child.fields.some((c) => c.name === name)) {
        throw new AppError(
          "VALIDATION",
          `${where}: rollup.filter references "${name}", which "${spec.from}" does not have`,
        );
      }
    }
  }
};
