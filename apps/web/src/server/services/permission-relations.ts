import { sql, type SQL } from "drizzle-orm";
import type { Condition } from "@backlex/core";
import {
  compileCondition,
  type ColRefResolver,
  type LeafCompiler,
} from "@backlex/db";
import type { DbCtx } from "./seed";
import { loadCollection, type CollectionRow } from "./items/collection-loader";
import { collectNestedRelationChains } from "./items/permission-rewrite";

/**
 * Dotted relation paths in PERMISSION conditions (`employee.app_user_id`)
 * lower to correlated EXISTS subqueries. Unlike user-supplied filters — which
 * get LEFT JOINs wired by the list handler — a permission's `whereSql` must
 * work verbatim inside every consumer's WHERE (list, single GET, UPDATE,
 * DELETE, CSV, changefeed, …) where no join machinery exists. A correlated
 * EXISTS needs nothing from the outer query except the base table's name, so
 * it composes everywhere:
 *
 *   EXISTS (SELECT 1 FROM <hopTable> AS perm_h1
 *           WHERE perm_h1.<pk> = <baseTable>.<relColumn>
 *             [AND perm_h1.tenant_id = $tenantId]     -- tenant-scoped target
 *             [AND perm_h1.deleted_at IS NULL]        -- soft-delete target
 *             AND <leaf comparison on perm_h1.<leafColumn>>)
 *
 * Multi-hop chains nest one EXISTS per hop (`perm_h2`, …), capped at
 * {@link MAX_PERMISSION_RELATION_HOPS} to match the filter grammar. The base
 * relation column is qualified with the base collection's physical table so a
 * self-referential relation (target = own collection) can't be shadowed by
 * the subquery alias.
 *
 * FAIL CLOSED: any chain that can't be resolved — unknown collection, a hop
 * that isn't a `relation` field, a missing leaf column, too many hops —
 * compiles to `(1=0)` instead of throwing. A misauthored permission rule must
 * deny rows, never leak them or 500 the request.
 */

const FALSE: SQL = sql`(1=0)`;

/** Same ceiling as the REST filter grammar: 2 relation hops (3 segments). */
const MAX_PERMISSION_RELATION_HOPS = 2;

/** Cheap pre-scan so the hot path (no dotted keys — the overwhelmingly common
 *  case) never pays for collection-metadata loads or closure allocation. */
export const conditionHasDottedKey = (cond: unknown): boolean => {
  if (cond === null || typeof cond !== "object") return false;
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) return c.$and.some(conditionHasDottedKey);
  if (Array.isArray(c.$or)) return c.$or.some(conditionHasDottedKey);
  if (c.$not !== undefined) return conditionHasDottedKey(c.$not);
  return Object.keys(c).some((k) => k.includes("."));
};

interface PermHop {
  /** FK column on the PARENT table (= the relation field's name). */
  relColumn: string;
  target: CollectionRow;
}

/** Resolve the physical column a leaf key reads on the final hop target.
 *  Mirrors the logical→physical mapping the items routes use; returns null
 *  (⇒ fail closed) for anything the target doesn't actually have. */
const physicalLeafColumn = (
  target: CollectionRow,
  leaf: string,
): string | null => {
  if (target.fields.some((f) => f.name === leaf)) return leaf;
  if (leaf === "id" || leaf === target.pkColumn) return target.pkColumn;
  if (leaf === "created_at") {
    return target.hasCreatedAt ? (target.createdAtColumn ?? "created_at") : null;
  }
  if (leaf === "updated_at") {
    return target.hasUpdatedAt ? (target.updatedAtColumn ?? "updated_at") : null;
  }
  if (leaf === "owner_id" && target.ownerScoped) {
    // Side-table ownership (adopted, no alias column) isn't reachable from a
    // bare EXISTS over the target table — fail closed rather than mis-scope.
    if (!target.adopted) return "owner_id";
    return target.ownerIdColumn ?? null;
  }
  return null;
};

/**
 * Build the {@link LeafCompiler} that lowers every dotted key found in
 * `conditions` to its EXISTS subquery. Hop metadata (target table, pk,
 * tenant/soft-delete flags) is resolved once, up front, via the same cached
 * collection loader the items routes use; the returned closure is sync, as
 * `combineConditions` requires.
 *
 * Auth-independent: `$user.id`-style values resolve at compile time from the
 * `ctx` argument the compiler passes per call, so the same closure is safe to
 * reuse for the list handler's join-aware recompile of the same conditions.
 */
export const buildPermissionRelationLeaf = async (
  ctx: DbCtx,
  tenantId: string,
  baseSlug: string,
  conditions: (Condition | null | undefined)[],
): Promise<LeafCompiler> => {
  // Distinct relation chains across every permission row's condition.
  const chains = new Map<string, string[]>();
  for (const cond of conditions) {
    if (!cond) continue;
    for (const [key, chain] of collectNestedRelationChains(cond)) {
      if (!chains.has(key)) chains.set(key, chain);
    }
  }

  let base: CollectionRow | null = null;
  try {
    base = await loadCollection(ctx, tenantId, baseSlug);
  } catch {
    base = null; // system/pseudo collection → every dotted leaf fails closed
  }

  // chainKey → resolved hop ladder, or null ⇒ fail closed.
  const resolved = new Map<string, PermHop[] | null>();
  for (const [key, chain] of chains) {
    if (!base || chain.length > MAX_PERMISSION_RELATION_HOPS) {
      resolved.set(key, null);
      continue;
    }
    const hops: PermHop[] = [];
    let source: CollectionRow = base;
    let ok = true;
    for (const segment of chain) {
      const def = source.fields.find((f) => f.name === segment);
      // Only to-one `relation` hops are traversable; `relation_many` heads
      // (JSON id arrays) would need a different lowering — fail closed.
      if (!def || def.type !== "relation" || !def.to) {
        ok = false;
        break;
      }
      let target: CollectionRow;
      try {
        target = await loadCollection(ctx, tenantId, def.to);
      } catch {
        ok = false;
        break;
      }
      hops.push({ relColumn: segment, target });
      source = target;
    }
    resolved.set(key, ok ? hops : null);
  }

  const dialect = ctx.dialect;
  const basePhysical = base?.physicalTable ?? null;

  return (field, cmp, authCtx) => {
    if (!field.includes(".")) return null; // plain key → default compiler
    const segs = field.split(".");
    const leafName = segs[segs.length - 1]!;
    const hops = resolved.get(segs.slice(0, -1).join("."));
    if (!hops || !basePhysical) return FALSE;
    const leafCol = physicalLeafColumn(hops[hops.length - 1]!.target, leafName);
    if (!leafCol) return FALSE;

    const build = (idx: number, parentRef: SQL): SQL => {
      const hop = hops[idx]!;
      const aliasId = sql.identifier(`perm_h${idx + 1}`);
      const parts: SQL[] = [
        sql`${aliasId}.${sql.identifier(hop.target.pkColumn)} = ${parentRef}.${sql.identifier(hop.relColumn)}`,
      ];
      // Cross-tenant guard on every hop: a stale FK pointing across
      // workspaces must never satisfy the permission.
      if (hop.target.tenantScoped && authCtx.tenantId) {
        parts.push(
          sql`${aliasId}.${sql.identifier("tenant_id")} = ${authCtx.tenantId}`,
        );
      }
      // A soft-deleted hop row must not grant access — the permission sees
      // the same live rows the target's own list endpoint would.
      if (hop.target.softDelete) {
        parts.push(sql`${aliasId}.${sql.identifier("deleted_at")} IS NULL`);
      }
      if (idx === hops.length - 1) {
        // Reuse the default operator semantics (`_eq`, `_in`, `$user.id`
        // resolution, …) by recursing into compileCondition with a synthetic
        // single-key condition and a colRef pinned to the hop alias.
        const colRef: ColRefResolver = () =>
          sql`${aliasId}.${sql.identifier(leafCol)}`;
        parts.push(
          compileCondition({ [leafName]: cmp } as Condition, authCtx, colRef, undefined, {
            dialect,
          }),
        );
      } else {
        parts.push(build(idx + 1, sql`${aliasId}`));
      }
      return sql`EXISTS (SELECT 1 FROM ${sql.identifier(hop.target.physicalTable)} AS ${aliasId} WHERE ${sql.join(parts, sql` AND `)})`;
    };
    return build(0, sql`${sql.identifier(basePhysical)}`);
  };
};
