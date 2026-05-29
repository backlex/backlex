import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import { resolvePermission } from "../permissions";
import { loadCollection, type CollectionRow } from "./collection-loader";
import { deserialize } from "./serialize";

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
  alias: string,
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
      alias = `rel_${head}`;
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
    // Build the column list for the JSON object. System columns are
    // unconditional; user fields are filtered by the target role's
    // `fields` allow-list. Adopted targets may have aliased created_at /
    // updated_at — emit the physical column under the logical key so the
    // wire shape stays consistent across managed and adopted targets.
    const aliasId = sql.identifier(alias);
    const cols: Array<{ key: string; ref: SQL }> = [
      { key: "id", ref: sql`${aliasId}.${sql.identifier(target.pkColumn)}` },
    ];
    if (target.hasCreatedAt) {
      const phys = target.createdAtColumn ?? "created_at";
      cols.push({ key: "created_at", ref: sql`${aliasId}.${sql.identifier(phys)}` });
    }
    if (target.hasUpdatedAt) {
      const phys = target.updatedAtColumn ?? "updated_at";
      cols.push({ key: "updated_at", ref: sql`${aliasId}.${sql.identifier(phys)}` });
    }
    // owner_id only when the target stores it on-row (managed default or
    // adopted-with-alias). The side-table path (`item_ownership`) isn't
    // joined here — leaving it off is the right call for v1; expanding it
    // would need a second LEFT JOIN per expand and isn't worth the cost.
    if (target.ownerScoped && (!target.adopted || target.ownerIdColumn)) {
      const phys = target.ownerIdColumn ?? "owner_id";
      cols.push({ key: "owner_id", ref: sql`${aliasId}.${sql.identifier(phys)}` });
    }
    for (const f of target.fields) {
      if (targetPerm.fields && !targetPerm.fields.has(f.name)) continue;
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
      expanded[f.name] = deserialize(obj[f.name], f.type, dialect);
    }
    out[plan.head] = expanded;
  }
};
