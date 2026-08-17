import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import { resolvePermission } from "../permissions";
import { loadCollection, type CollectionRow } from "./collection-loader";
import { deserialize, deserializeField } from "./serialize";
import { queryAll } from "./sql-helpers";

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
export const buildExpandSelect = (
  dialect: "pg" | "sqlite",
  baseFkRef: SQL,
  _alias: string,
  outputCol: string,
  cols: Array<{ key: string; ref: SQL }>,
): SQL => {
  const builder = dialect === "pg" ? sql`jsonb_build_object` : sql`json_object`;
  const args = cols.flatMap((c) => [sql`${c.key}`, c.ref]);
  const objectExpr = sql`${builder}(${sql.join(args, sql`, `)})`;
  return sql`CASE WHEN ${baseFkRef} IS NULL THEN NULL ELSE ${objectExpr} END AS ${sql.identifier(outputCol)}`;
};

export interface ExpandPlan {
  /** Source-collection relation field name (the column being expanded). */
  head: string;
  /** Output column the SELECT aliases to — `__expand_<head>`. */
  outputCol: string;
  /** Target collection, for deserializing nested values back to JS types. */
  target: CollectionRow;
  /** Allowed fields on the target after permission projection (null = all). */
  allowedFields: Set<string> | null;
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
  for (const head of expand) {
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
    const outputCol = `__expand_${head}`;
    const baseFkRef = sql`${baseTbl}.${sql.identifier(head)}`;
    selects.push(
      buildExpandSelect(ctx.dialect, baseFkRef, alias, outputCol, cols),
    );
    plans.push({ head, outputCol, target, allowedFields: targetPerm.fields });
  }
  return { extraJoins, selects, plans };
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
    for (const f of plan.target.fields) {
      if (!(f.name in obj)) continue;
      // Permission `fields` allow-list was already enforced at SELECT
      // emission time, so anything present here is allowed.
      expanded[f.name] = deserializeField(obj[f.name], f, dialect, obj, plan.target.fields);
    }
    out[plan.head] = expanded;
  }
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
// target collection + the target role's `fields` allow-list (row-level
// conditions are not applied to expanded targets, same as the JOIN path).
// ---------------------------------------------------------------------------

export interface ManyExpandPlan {
  /** Source-collection relation_many field name. */
  head: string;
  /** Target collection, for the fetch + value deserialization. */
  target: CollectionRow;
  /** Allowed fields on the target after permission projection (null = all). */
  allowedFields: Set<string> | null;
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
    plans.push({ head, target, allowedFields: targetPerm.fields, subs });
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
    const { head, target, allowedFields, subs } = plan;
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
      if (allowedFields && !allowedFields.has(f.name)) continue;
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
