import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import { resolvePermission } from "../permissions";
import { loadCollection, type CollectionRow } from "./collection-loader";
import { deserialize, deserializeField } from "./serialize";
import { canSeeDraftsFor, readableIds } from "./row-access";
import { draftFilter, queryAll } from "./sql-helpers";

/**
 * Postgres truncates any identifier past 63 bytes — silently, with only a
 * NOTICE — so two relation chains whose aliases agree for 63 characters
 * become the SAME alias in the emitted SQL. The JOIN ladder then reads
 * columns off whichever table won, which is wrong answers rather than an
 * error.
 *
 * The comment on the alias builder claimed the 2-hop depth cap kept this
 * impossible. It did not: field names carry no length limit of their own
 * (`USER_FIELD_NAME` is `/^[a-z][a-z0-9_]*$/`), so `rel_` plus two
 * thirty-character names is already 66. The cap was never the guard; this is.
 */
export const MAX_ALIAS_CHARS = 63;

/**
 * The JOIN alias for a relation chain prefix, refusing one Postgres would
 * truncate. Shared by the filter/sort chain walker and the expand resolver so
 * the two cannot disagree about what an alias is called.
 *
 * **Postgres only.** SQLite has no identifier-length limit, so the failure
 * this prevents cannot happen there — and refusing anyway would break queries
 * that work today on the D1 deployments this ships to most. A dialect
 * difference is the honest answer when the underlying limit is a dialect
 * difference; the alternative is breaking working callers to protect them
 * from nothing.
 */
export const relationAlias = (
  segments: readonly string[],
  dialect: "pg" | "sqlite",
): string => {
  const alias = `rel_${segments.join("__")}`;
  if (dialect === "pg" && alias.length > MAX_ALIAS_CHARS) {
    throw new AppError(
      "VALIDATION",
      `Relation path "${segments.join(".")}" is too deeply nested to query: it needs a ${alias.length}-character SQL alias and the limit is ${MAX_ALIAS_CHARS}. Shorten the field names, or filter in fewer hops.`,
    );
  }
  return alias;
};

/**
 * Build the SELECT expression for one `?expand=<head>` entry:
 *
 *   CASE WHEN base.<head> IS NULL
 *        THEN NULL
 *        ELSE jsonb_build_object('id', rel.id, …)
 *   END AS "__expand_<head>"
 *
 * The CASE wrapper exists because `jsonb_build_object` (PG) and
 * `json_object` (SQLite) happily build a non-NULL row of NULL fields when
 * the JOIN didn't match — and a NULL relation FK shouldn't surface as
 * `{id: null, name: null}` to the caller. With the wrapper, a null FK
 * stays null in the response, matching the unexpanded behavior.
 *
 * `cols` is the per-target list of (jsonKey → physical column reference)
 * pairs. System columns (id / created_at / updated_at / owner_id) are
 * always included; user fields are filtered by the target role's
 * permission `fields` allow-list (passed in already-filtered).
 */
export const buildExpandObject = (
  dialect: "pg" | "sqlite",
  baseFkRef: SQL,
  cols: Array<{ key: string; ref: SQL }>,
): SQL => {
  const builder = dialect === "pg" ? sql`jsonb_build_object` : sql`json_object`;
  const args = cols.flatMap((c) => [sql`${c.key}`, c.ref]);
  const objectExpr = sql`${builder}(${sql.join(args, sql`, `)})`;
  return sql`CASE WHEN ${baseFkRef} IS NULL THEN NULL ELSE ${objectExpr} END`;
};

export const buildExpandSelect = (
  dialect: "pg" | "sqlite",
  baseFkRef: SQL,
  _alias: string,
  outputCol: string,
  cols: Array<{ key: string; ref: SQL }>,
): SQL =>
  sql`${buildExpandObject(dialect, baseFkRef, cols)} AS ${sql.identifier(outputCol)}`;

/**
 * The caller's read permission on ONE expand target.
 *
 * `fields` was carried from the start (it trims the SELECT). `whereSql` and
 * `isAdmin` are here because they were not, and that is the whole of the
 * defect: an expand resolved the target's permission, used the field
 * allow-list, and threw the row condition away. A `customer-rep` whose grant
 * on `customers` reads `{owner_id: {_eq: "$user.id"}}` got every field of
 * every customer any order referenced — including other reps' — while
 * `GET /api/items/customers` returned only their own.
 */
export interface ExpandPerm {
  whereSql: SQL | null;
  isAdmin: boolean;
  /** Allowed fields on the target after permission projection (null = all). */
  fields: Set<string> | null;
}

/** The three fields of a `ResolvedPermission` an expand plan has to carry. */
const permOf = (p: {
  whereSql: SQL | null;
  isAdmin: boolean;
  fields: Set<string> | null;
}): ExpandPerm => ({ whereSql: p.whereSql, isAdmin: p.isAdmin, fields: p.fields });

/**
 * One expanded relation, and anything expanded THROUGH it.
 *
 * `?expand=order_id.customer_id` inlines the customer inside the order, so the
 * plan is a tree rather than a list: `children` carries the same shape one hop
 * further in, keyed by the field it was reached through. A plain
 * `?expand=order_id` has no children and is exactly what it always was.
 */
export interface ExpandNode {
  /** Field on the PARENT collection this node was reached through. */
  key: string;
  /** Target collection, for deserializing nested values back to JS types. */
  target: CollectionRow;
  /** The caller's read permission on `target`. */
  perm: ExpandPerm;
  children: ExpandNode[];
}

export interface ExpandPlan {
  /** Source-collection relation field name (the column being expanded). */
  head: string;
  /** Output column the SELECT aliases to — `__expand_<head>`. */
  outputCol: string;
  /** Target collection, for deserializing nested values back to JS types. */
  target: CollectionRow;
  /** The caller's read permission on `target`. */
  perm: ExpandPerm;
  /** Relations expanded THROUGH this one (`?expand=a.b`). Empty for a plain
   *  single-hop expand, which is what every caller sent before chaining. */
  children: ExpandNode[];
}

/**
 * Resolve every `?expand=<head>` entry into a JOIN (or alias reuse) plus
 * a SELECT expression. Returns:
 *   - extraJoins: LEFT JOINs to append after the existing nested-filter
 *     joins. Empty when every expand head already has a join alias from
 *     the filter/sort chain walker.
 *   - selects: per-head SELECT expressions (`__expand_<head>`).
 *   - plans: per-head metadata for post-query row substitution.
 *
 * Permission gate: each target's `resolvePermission("read")` must be
 * allowed → 403 otherwise. Same gate the nested-filter resolver applies,
 * so a caller who can already filter on `customer_id.name` can also
 * expand `customer_id` (and vice versa).
 *
 * Tenant scope: cross-tenant guard added to the JOIN's ON clause when the
 * target is tenant-scoped — mirrors the nested-filter JOIN.
 */
export const resolveExpands = async (
  ctx: Ctx,
  auth: AuthSubject,
  collection: CollectionRow,
  expand: string[],
  joinMap: Map<string, { alias: string; target: CollectionRow }>,
  /**
   * Optional per-head sub-field allow-list (from `fields=customer.name`). When
   * a head has an entry, the inlined object is trimmed to `id` + those columns;
   * absent ⇒ whole readable row (the `expand=` param default).
   */
  subFields: Map<string, Set<string>> = new Map(),
): Promise<{ extraJoins: SQL[]; selects: SQL[]; plans: ExpandPlan[] }> => {
  if (expand.length === 0) {
    return { extraJoins: [], selects: [], plans: [] };
  }
  const extraJoins: SQL[] = [];
  const selects: SQL[] = [];
  const plans: ExpandPlan[] = [];
  const baseTbl = sql.identifier(collection.physicalTable);
  // Entries may be dotted (`order_id.customer_id`). Group them by head so one
  // head asked for twice (`a.b` and `a.c`) builds ONE join and one object with
  // two nested keys, rather than two conflicting selects for the same column.
  const chains = new Map<string, string[][]>();
  for (const entry of expand) {
    const segs = entry.split(".");
    const head = segs[0]!;
    const tails = chains.get(head) ?? [];
    if (segs.length > 1) tails.push(segs.slice(1));
    chains.set(head, tails);
  }
  for (const head of chains.keys()) {
    const def = collection.fields.find((f) => f.name === head);
    // parseQuery already enforced shape + type + source perm, so a missing
    // / wrong-type def shouldn't happen — be defensive anyway.
    if (!def || def.type !== "relation" || !def.to) {
      throw new AppError(
        "VALIDATION",
        `Cannot expand "${head}" — not a single-FK relation`,
      );
    }
    const target = await loadCollection(ctx, auth.tenantId, def.to).catch(() => {
      throw new AppError(
        "VALIDATION",
        `Relation target not active: ${def.to}`,
      );
    });
    const targetPerm = await resolvePermission(
      { db: ctx.db, dialect: ctx.dialect },
      auth,
      def.to,
      "read",
    );
    if (!targetPerm.allowed) {
      throw new AppError(
        "FORBIDDEN",
        `No read permission on relation target: ${def.to}`,
      );
    }
    // Reuse the JOIN alias from the nested-filter/sort walker when it's
    // already there (e.g. `?filter={"customer_id.name":…}&expand=customer_id`
    // shares one join). Otherwise emit a fresh LEFT JOIN.
    let alias = joinMap.get(head)?.alias;
    if (!alias) {
      alias = relationAlias([head], ctx.dialect);
      const aliasId = sql.identifier(alias);
      const targetTbl = sql.identifier(target.physicalTable);
      const onParts: SQL[] = [
        sql`${aliasId}.${sql.identifier(target.pkColumn)} = ${baseTbl}.${sql.identifier(head)}`,
      ];
      if (target.tenantScoped && auth.tenantId) {
        onParts.push(
          sql`${aliasId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`,
        );
      }
      extraJoins.push(
        sql`LEFT JOIN ${targetTbl} AS ${aliasId} ON ${sql.join(onParts, sql` AND `)}`,
      );
      joinMap.set(head, { alias, target });
    }
    // Sub-field trim (from `fields=customer.name`): restrict the inlined
    // object to `id` + the requested leaves. Validate each requested leaf
    // exists on the target and is readable, so `fields=customer.bogus`
    // surfaces a precise 422 instead of silently dropping.
    const subs = subFields.get(head);
    if (subs) {
      const targetSys = new Set<string>(["id"]);
      if (target.hasCreatedAt) targetSys.add("created_at");
      if (target.hasUpdatedAt) targetSys.add("updated_at");
      if (target.ownerScoped) targetSys.add("owner_id");
      const targetFieldNames = new Set(target.fields.map((f) => f.name));
      for (const s of subs) {
        if (!targetSys.has(s) && !targetFieldNames.has(s)) {
          throw new AppError("VALIDATION", `Unknown field: ${head}.${s}`);
        }
        if (!targetSys.has(s) && targetPerm.fields && !targetPerm.fields.has(s)) {
          throw new AppError("FORBIDDEN", `No permission to read "${head}.${s}"`);
        }
      }
    }
    const wants = (key: string): boolean => !subs || key === "id" || subs.has(key);
    // Build the column list for the JSON object. System columns are
    // unconditional (unless sub-trimmed); user fields are filtered by the
    // target role's `fields` allow-list. Adopted targets may have aliased
    // created_at / updated_at — emit the physical column under the logical
    // key so the wire shape stays consistent across managed and adopted
    // targets.
    const aliasId = sql.identifier(alias);
    const cols: Array<{ key: string; ref: SQL }> = [
      { key: "id", ref: sql`${aliasId}.${sql.identifier(target.pkColumn)}` },
    ];
    if (target.hasCreatedAt && wants("created_at")) {
      const phys = target.createdAtColumn ?? "created_at";
      cols.push({ key: "created_at", ref: sql`${aliasId}.${sql.identifier(phys)}` });
    }
    if (target.hasUpdatedAt && wants("updated_at")) {
      const phys = target.updatedAtColumn ?? "updated_at";
      cols.push({ key: "updated_at", ref: sql`${aliasId}.${sql.identifier(phys)}` });
    }
    // owner_id only when the target stores it on-row (managed default or
    // adopted-with-alias). The side-table path (`item_ownership`) isn't
    // joined here — leaving it off is the right call for v1; expanding it
    // would need a second LEFT JOIN per expand and isn't worth the cost.
    if (target.ownerScoped && (!target.adopted || target.ownerIdColumn) && wants("owner_id")) {
      const phys = target.ownerIdColumn ?? "owner_id";
      cols.push({ key: "owner_id", ref: sql`${aliasId}.${sql.identifier(phys)}` });
    }
    for (const f of target.fields) {
      if (targetPerm.fields && !targetPerm.fields.has(f.name)) continue;
      if (!wants(f.name)) continue;
      cols.push({ key: f.name, ref: sql`${aliasId}.${sql.identifier(f.name)}` });
    }
    // Chained expansion: `?expand=order_id.customer_id` inlines the customer
    // INSIDE the order. Each further hop is another LEFT JOIN sharing the
    // chain-prefix alias with the filter/sort walker, and another
    // `jsonb_build_object` nested as one more key on the object above it.
    // The gate walks with it — every hop loads its target and resolves
    // `read`, so a chained expand can never reach a collection a plain expand
    // of that collection would refuse.
    const children = await resolveExpandChildren(
      ctx,
      auth,
      target,
      alias,
      [head],
      chains.get(head) ?? [],
      joinMap,
      extraJoins,
      cols,
    );

    const outputCol = `__expand_${head}`;
    const baseFkRef = sql`${baseTbl}.${sql.identifier(head)}`;
    selects.push(
      buildExpandSelect(ctx.dialect, baseFkRef, alias, outputCol, cols),
    );
    plans.push({ head, outputCol, target, perm: permOf(targetPerm), children });
  }
  return { extraJoins, selects, plans };
};

/**
 * Wire one level of chained expansion and recurse.
 *
 * `tails` are the remaining segment lists under this node (`["customer_id"]`
 * for `order_id.customer_id`). Each distinct next segment becomes one LEFT
 * JOIN — aliased by the full chain prefix, so it is the SAME join the nested
 * filter walker would emit and the two share it — plus one nested object
 * appended to the parent's column list.
 *
 * Mutates `cols` and `extraJoins` because it is building the parent's SELECT
 * in place; returns the plan nodes the row applier needs to deserialize what
 * comes back.
 */
const resolveExpandChildren = async (
  ctx: Ctx,
  auth: AuthSubject,
  source: CollectionRow,
  parentAlias: string,
  prefix: string[],
  tails: string[][],
  joinMap: Map<string, { alias: string; target: CollectionRow }>,
  extraJoins: SQL[],
  cols: Array<{ key: string; ref: SQL }>,
): Promise<ExpandNode[]> => {
  const bySegment = new Map<string, string[][]>();
  for (const tail of tails) {
    const seg = tail[0];
    if (!seg) continue;
    const rest = tail.slice(1);
    const list = bySegment.get(seg) ?? [];
    if (rest.length > 0) list.push(rest);
    bySegment.set(seg, list);
  }

  const nodes: ExpandNode[] = [];
  for (const [seg, deeper] of bySegment) {
    const def = source.fields.find((f) => f.name === seg);
    if (!def || def.type !== "relation" || !def.to) {
      // `relation_many` lands here too: expanding one INSIDE another expand
      // would need the batch fetch to run per parent row, which the to-many
      // path does not do. Named rather than silently dropped.
      throw new AppError(
        "VALIDATION",
        `Cannot expand "${[...prefix, seg].join(".")}" — "${seg}" on "${source.slug}" is not a single-FK relation`,
      );
    }
    const target = await loadCollection(ctx, auth.tenantId, def.to).catch(() => {
      throw new AppError("VALIDATION", `Relation target not active: ${def.to}`);
    });
    const perm = await resolvePermission(
      { db: ctx.db, dialect: ctx.dialect },
      auth,
      def.to,
      "read",
    );
    if (!perm.allowed) {
      throw new AppError("FORBIDDEN", `No read permission on relation target: ${def.to}`);
    }

    const chain = [...prefix, seg];
    const key = chain.join(".");
    let alias = joinMap.get(key)?.alias;
    if (!alias) {
      alias = relationAlias(chain, ctx.dialect);
      const aliasId = sql.identifier(alias);
      const onParts: SQL[] = [
        sql`${aliasId}.${sql.identifier(target.pkColumn)} = ${sql.identifier(parentAlias)}.${sql.identifier(seg)}`,
      ];
      if (target.tenantScoped && auth.tenantId) {
        onParts.push(sql`${aliasId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`);
      }
      extraJoins.push(
        sql`LEFT JOIN ${sql.identifier(target.physicalTable)} AS ${aliasId} ON ${sql.join(onParts, sql` AND `)}`,
      );
      joinMap.set(key, { alias, target });
    }

    const aliasId = sql.identifier(alias);
    const childCols: Array<{ key: string; ref: SQL }> = [
      { key: "id", ref: sql`${aliasId}.${sql.identifier(target.pkColumn)}` },
    ];
    if (target.hasCreatedAt) {
      childCols.push({
        key: "created_at",
        ref: sql`${aliasId}.${sql.identifier(target.createdAtColumn ?? "created_at")}`,
      });
    }
    if (target.hasUpdatedAt) {
      childCols.push({
        key: "updated_at",
        ref: sql`${aliasId}.${sql.identifier(target.updatedAtColumn ?? "updated_at")}`,
      });
    }
    if (target.ownerScoped && (!target.adopted || target.ownerIdColumn)) {
      childCols.push({
        key: "owner_id",
        ref: sql`${aliasId}.${sql.identifier(target.ownerIdColumn ?? "owner_id")}`,
      });
    }
    for (const f of target.fields) {
      if (perm.fields && !perm.fields.has(f.name)) continue;
      childCols.push({ key: f.name, ref: sql`${aliasId}.${sql.identifier(f.name)}` });
    }

    const grandchildren = await resolveExpandChildren(
      ctx,
      auth,
      target,
      alias,
      chain,
      deeper,
      joinMap,
      extraJoins,
      childCols,
    );

    // Nested under the parent's own FK column, so a null FK on the PARENT row
    // still yields null here rather than an object of nulls — the same
    // `CASE WHEN … IS NULL` the top level uses.
    // The bare expression, not a `(SELECT … AS v)` wrapper: an aliased select
    // cannot nest as a value, and wrapping it in a scalar subquery would work
    // on SQLite while costing a per-row subquery on Postgres for no reason.
    // `buildExpandObject` is the un-aliased half, and the top level aliases it.
    cols.push({
      key: seg,
      ref: buildExpandObject(
        ctx.dialect,
        sql`${sql.identifier(parentAlias)}.${sql.identifier(seg)}`,
        childCols,
      ),
    });
    nodes.push({ key: seg, target, perm: permOf(perm), children: grandchildren });
  }
  return nodes;
};

/**
 * Post-process a deserialized row: for every expand plan, parse the raw
 * `__expand_<head>` column (a JSON string on SQLite, an object on PG) and
 * substitute it under the `head` key. System keys inside the nested
 * object are converted to the API's camelCase shape and timestamps go
 * through `deserialize("timestamp", …)` so the inlined row's shape
 * matches what `GET /api/items/<target>/<id>` would return.
 *
 * If the raw column is null (LEFT JOIN miss OR FK was null), the nested
 * value stays null — the CASE wrapper in the SELECT already guarantees
 * we never emit `{id: null, …}`.
 *
 * **Not sufficient on its own.** Follow it with {@link clampExpandedRows}
 * over the whole page: the JOIN this parses carries the target's tenant scope
 * and nothing else, so what it inlines still has to be checked against the
 * caller's row condition. Both REST call sites do; `applyManyExpandsToRows`
 * is its to-many counterpart and carries the clamp inside itself, because a
 * batch fetch can put the condition in its own WHERE.
 */
export const applyExpandToRow = (
  out: Record<string, unknown>,
  raw: Record<string, unknown>,
  plans: ExpandPlan[],
  dialect: "pg" | "sqlite",
): void => {
  for (const plan of plans) {
    const v = raw[plan.outputCol];
    if (v === null || v === undefined) {
      out[plan.head] = null;
      continue;
    }
    let obj: Record<string, unknown>;
    if (typeof v === "string") {
      // SQLite always returns json_object output as a TEXT string. PG can
      // too in some driver configurations (e.g. when jsonb is cast to
      // text), so parse defensively on both.
      try {
        obj = JSON.parse(v) as Record<string, unknown>;
      } catch {
        out[plan.head] = null;
        continue;
      }
    } else if (typeof v === "object") {
      obj = v as Record<string, unknown>;
    } else {
      out[plan.head] = null;
      continue;
    }
    out[plan.head] = shapeExpanded(obj, plan.target, plan.children, dialect);
  }
};

/**
 * Drop every inlined to-one object whose row the caller may not read.
 *
 * The LEFT JOIN that produced these objects carries the target's tenant id in
 * its ON clause and nothing else — no row condition, no soft-delete, no draft
 * visibility. So `GET /api/items/orders?expand=customer_id` handed back the
 * whole customer row for every customer any order referenced, including the
 * ones `GET /api/items/customers` correctly hides. Every hop of a chain
 * (`expand=order_id.customer_id`) had the same gap, at every level.
 *
 * This runs AFTER the page is materialized, one query per distinct target
 * across the whole page, and nulls out what does not survive — the same value
 * a JOIN miss produces, which every consumer already handles. Post-hoc rather
 * than in the ON clause on purpose: `perm.whereSql` is compiled with bare
 * column names, and a bare `owner_id` inside a JOIN's ON is ambiguous the
 * moment the base table has one too. Re-compiling the target's conditions
 * against the join alias is possible (`combineConditions` takes a col-ref
 * resolver) but drags the localized-sidecar and dotted-relation lowerings
 * along with it, each of which reference the target's own primary key
 * unqualified. One extra indexed `IN (…)` is the cheaper correct answer, and
 * it is the same shape `applyManyExpandsToRows` and the GraphQL relation
 * loader already use.
 *
 * Callers whose permission on a target is unconditional pay nothing: the node
 * is skipped when there is no clamp to apply.
 */
export const clampExpandedRows = async (
  ctx: Ctx,
  auth: AuthSubject,
  rows: Record<string, unknown>[],
  plans: ExpandPlan[],
): Promise<void> => {
  if (plans.length === 0 || rows.length === 0) return;
  /** Every place one target's object is inlined, across the whole page. */
  type Site = { holder: Record<string, unknown>; key: string; id: string };
  const byTarget = new Map<
    string,
    { target: CollectionRow; perm: ExpandPerm; sites: Site[] }
  >();

  const visit = (
    holder: Record<string, unknown>,
    key: string,
    target: CollectionRow,
    perm: ExpandPerm,
    children: ExpandNode[],
  ): void => {
    const obj = holder[key];
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    // Nothing to clamp is not the same as nothing to walk: an unconditional
    // grant on THIS target can still sit above a conditional one below it.
    if (needsClamp(target, perm)) {
      const id = rec.id;
      if (id == null) {
        // No id means no way to check it — refuse rather than pass it on.
        holder[key] = null;
        return;
      }
      const entry = byTarget.get(target.slug) ?? { target, perm, sites: [] };
      entry.sites.push({ holder, key, id: String(id) });
      byTarget.set(target.slug, entry);
    }
    for (const child of children) {
      visit(rec, child.key, child.target, child.perm, child.children);
    }
  };

  for (const row of rows) {
    for (const plan of plans) {
      visit(row, plan.head, plan.target, plan.perm, plan.children);
    }
  }

  for (const { target, perm, sites } of byTarget.values()) {
    const readable = await readableIds(
      ctx,
      auth,
      target,
      perm,
      sites.map((s) => s.id),
    );
    for (const s of sites) {
      if (!readable.has(s.id)) s.holder[s.key] = null;
    }
  }
};

/**
 * Whether an inlined target needs the second query at all.
 *
 * `whereSql` is the row condition. The other two are filters a direct read
 * applies and the JOIN does not: a soft-deleted row is still joinable, and a
 * versioned collection's drafts are visible to a caller who could not fetch
 * one by id. An admin on the target skips the draft half but not the others.
 */
const needsClamp = (target: CollectionRow, perm: ExpandPerm): boolean =>
  perm.whereSql !== null ||
  target.softDelete ||
  (Boolean(target.versioned) && !perm.isAdmin);

/**
 * Turn one raw JSON object from the database into the row shape the API emits,
 * recursing into anything expanded through it.
 *
 * Split out of `applyExpandToRow` when expansion became chained: the top level
 * and every nested level need the identical treatment (system keys to
 * camelCase, timestamps through `deserialize`, user fields through
 * `deserializeField`), and having two copies is how the inlined shape would
 * drift from the top-level one.
 */
const shapeExpanded = (
  obj: Record<string, unknown>,
  target: CollectionRow,
  children: ExpandNode[],
  dialect: "pg" | "sqlite",
): Record<string, unknown> => {
  const expanded: Record<string, unknown> = {};
  // System keys → camelCase, matching the top-level row shape that
  // deserializeRow emits.
  if ("id" in obj) expanded.id = obj.id;
  if ("created_at" in obj && obj.created_at != null) {
    expanded.createdAt = deserialize(obj.created_at, "timestamp", dialect);
  }
  if ("updated_at" in obj && obj.updated_at != null) {
    expanded.updatedAt = deserialize(obj.updated_at, "timestamp", dialect);
  }
  if ("owner_id" in obj) expanded.ownerId = obj.owner_id ?? null;
  for (const f of target.fields) {
    if (!(f.name in obj)) continue;
    // Permission `fields` allow-list was already enforced at SELECT
    // emission time, so anything present here is allowed.
    expanded[f.name] = deserializeField(obj[f.name], f, dialect, obj, target.fields);
  }
  // Nested expands replace the FK value under the same key, exactly as the top
  // level replaces `order_id` with the order.
  for (const child of children) {
    const raw = obj[child.key];
    let nested: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        nested = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        nested = null;
      }
    } else if (raw && typeof raw === "object") {
      nested = raw as Record<string, unknown>;
    }
    expanded[child.key] = nested
      ? shapeExpanded(nested, child.target, child.children, dialect)
      : null;
  }
  return expanded;
};

// ---------------------------------------------------------------------------
// relation_many (to-many) expand
//
// A to-many head holds a JSON array of foreign ids, so a LEFT JOIN would
// multiply the base rows. Instead we batch: after the page (or single row) is
// materialized, collect every referenced id across the page, fetch the target
// rows in ONE `IN (...)` query, then substitute each row's id array with the
// ordered array of inlined target rows. Missing ids (deleted / cross-tenant /
// no longer present) are dropped, so the array only carries live, readable
// rows. Permission gate matches the to-one path: action-level read on the
// target collection, the target role's `fields` allow-list, AND the target's
// row condition + draft visibility — the same five filters a direct read of
// that collection applies, and the same five the GraphQL relation loader has
// always applied. The parenthetical that used to close this paragraph said
// row-level conditions were "not applied to expanded targets, same as the
// JOIN path"; that was the defect, written down as if it were a design.
// ---------------------------------------------------------------------------

export interface ManyExpandPlan {
  /** Source-collection relation_many field name. */
  head: string;
  /** Target collection, for the fetch + value deserialization. */
  target: CollectionRow;
  /** The caller's read permission on `target`. */
  perm: ExpandPerm;
  /** Sub-field trim (from `fields=tags.name`); null ⇒ whole readable row. */
  subs: Set<string> | null;
}

/**
 * Validate + gate every `relation_many` expand head: load its target
 * collection, require action-level read permission (403 otherwise), and
 * validate any requested sub-fields against the target schema + the target
 * role's `fields` allow-list. Returns one plan per head for the batch fetch.
 */
export const resolveManyExpands = async (
  ctx: Ctx,
  auth: AuthSubject,
  collection: CollectionRow,
  expandMany: string[],
  subFields: Map<string, Set<string>> = new Map(),
): Promise<ManyExpandPlan[]> => {
  const plans: ManyExpandPlan[] = [];
  for (const head of expandMany) {
    const def = collection.fields.find((f) => f.name === head);
    if (!def || def.type !== "relation_many" || !def.to) {
      throw new AppError(
        "VALIDATION",
        `Cannot expand "${head}" — not a relation_many field`,
      );
    }
    const target = await loadCollection(ctx, auth.tenantId, def.to).catch(() => {
      throw new AppError("VALIDATION", `Relation target not active: ${def.to}`);
    });
    const targetPerm = await resolvePermission(
      { db: ctx.db, dialect: ctx.dialect },
      auth,
      def.to,
      "read",
    );
    if (!targetPerm.allowed) {
      throw new AppError(
        "FORBIDDEN",
        `No read permission on relation target: ${def.to}`,
      );
    }
    const subs = subFields.get(head) ?? null;
    if (subs) {
      const targetSys = new Set<string>(["id"]);
      if (target.hasCreatedAt) targetSys.add("created_at");
      if (target.hasUpdatedAt) targetSys.add("updated_at");
      if (target.ownerScoped) targetSys.add("owner_id");
      const targetFieldNames = new Set(target.fields.map((f) => f.name));
      for (const s of subs) {
        if (!targetSys.has(s) && !targetFieldNames.has(s)) {
          throw new AppError("VALIDATION", `Unknown field: ${head}.${s}`);
        }
        if (!targetSys.has(s) && targetPerm.fields && !targetPerm.fields.has(s)) {
          throw new AppError("FORBIDDEN", `No permission to read "${head}.${s}"`);
        }
      }
    }
    plans.push({ head, target, perm: permOf(targetPerm), subs });
  }
  return plans;
};

/**
 * Substitute each row's `relation_many` id array with the array of inlined
 * target rows. Runs one `IN (...)` fetch per head over the whole page (not
 * per row), so a 50-row page with a `tags` expand is two queries total. The
 * head value is normalized to `[]` when it has no (readable) matches.
 */
export const applyManyExpandsToRows = async (
  ctx: Ctx,
  auth: AuthSubject,
  rows: Record<string, unknown>[],
  plans: ManyExpandPlan[],
): Promise<void> => {
  for (const plan of plans) {
    const { head, target, perm, subs } = plan;
    // Collect every referenced id across the page (deduped).
    const idSet = new Set<string>();
    for (const row of rows) {
      const v = row[head];
      if (Array.isArray(v)) {
        for (const id of v) if (id != null) idSet.add(String(id));
      }
    }
    if (idSet.size === 0) {
      for (const row of rows) row[head] = [];
      continue;
    }

    // Which columns to fetch: id + system + permitted user fields, trimmed by
    // any `fields=head.sub` projection (id always included).
    const wants = (key: string): boolean => !subs || key === "id" || subs.has(key);
    const cols: Array<{ key: string; phys: string }> = [
      { key: "id", phys: target.pkColumn },
    ];
    if (target.hasCreatedAt && wants("created_at")) {
      cols.push({ key: "created_at", phys: target.createdAtColumn ?? "created_at" });
    }
    if (target.hasUpdatedAt && wants("updated_at")) {
      cols.push({ key: "updated_at", phys: target.updatedAtColumn ?? "updated_at" });
    }
    if (
      target.ownerScoped &&
      (!target.adopted || target.ownerIdColumn) &&
      wants("owner_id")
    ) {
      cols.push({ key: "owner_id", phys: target.ownerIdColumn ?? "owner_id" });
    }
    for (const f of target.fields) {
      if (perm.fields && !perm.fields.has(f.name)) continue;
      if (!wants(f.name)) continue;
      cols.push({ key: f.name, phys: f.name });
    }

    const selectParts = cols.map((col) =>
      col.phys === col.key
        ? sql`${sql.identifier(col.phys)}`
        : sql`${sql.identifier(col.phys)} AS ${sql.identifier(col.key)}`,
    );
    const idList = [...idSet];
    const whereParts: SQL[] = [
      sql`${sql.identifier(target.pkColumn)} IN (${sql.join(
        idList.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    ];
    if (target.tenantScoped && auth.tenantId) {
      whereParts.push(sql`${sql.identifier("tenant_id")} = ${auth.tenantId}`);
    }
    if (target.softDelete) {
      whereParts.push(sql`${sql.identifier("deleted_at")} IS NULL`);
    }
    // The row-level clamp. This is a single-table fetch, so the compiled
    // condition's bare column references bind exactly as they do on a direct
    // read of the target — no alias to qualify against, which is why the
    // to-many path can carry it here while the to-one path (a JOIN) has to
    // clamp after the fact.
    if (perm.whereSql) whereParts.push(perm.whereSql);
    const draftWhere = draftFilter(
      target,
      await canSeeDraftsFor(ctx, auth, target, perm),
    );
    if (draftWhere) whereParts.push(draftWhere);
    const fetched = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${sql.join(selectParts, sql`, `)} FROM ${sql.identifier(
        target.physicalTable,
      )} WHERE ${sql.join(whereParts, sql` AND `)}`,
    );

    // id → inlined object (same camelCase + deserialize shape as the to-one path).
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of fetched) {
      const obj: Record<string, unknown> = { id: r.id };
      if ("created_at" in r && r.created_at != null) {
        obj.createdAt = deserialize(r.created_at, "timestamp", ctx.dialect);
      }
      if ("updated_at" in r && r.updated_at != null) {
        obj.updatedAt = deserialize(r.updated_at, "timestamp", ctx.dialect);
      }
      if ("owner_id" in r) obj.ownerId = r.owner_id ?? null;
      for (const f of target.fields) {
        if (!(f.name in r)) continue;
        obj[f.name] = deserialize(r[f.name], f.type, ctx.dialect);
      }
      byId.set(String(r.id), obj);
    }

    // Substitute, preserving the stored id order; drop ids with no live match.
    for (const row of rows) {
      const v = row[head];
      if (!Array.isArray(v)) {
        row[head] = [];
        continue;
      }
      const list: Record<string, unknown>[] = [];
      for (const id of v) {
        if (id == null) continue;
        const obj = byId.get(String(id));
        if (obj) list.push(obj);
      }
      row[head] = list;
    }
  }
};
