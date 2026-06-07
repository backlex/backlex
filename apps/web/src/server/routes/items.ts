import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import {
  compileCondition,
  combineConditions,
  type FieldDef,
  type ColRefResolver,
  type LeafCompiler,
} from "@backlex/db";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { parseQuery, resolveProjection } from "../lib/query";
import { resolvePermission } from "../services/permissions";
import { publishEvent } from "../services/events";
import { elapsedMs, recordActivity, requestMeta } from "../services/activity";
import { recordRevision } from "../services/revisions";
import { embedAndUpsert, deleteVector } from "../services/vectorize";
import { loadAppSettings } from "../services/settings";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  collectionFromParam,
  hasI18nField,
  loadCollection,
  type CollectionRow,
} from "../services/items/collection-loader";
import {
  serialize,
  deserialize,
  deserializeRow,
  projectFields,
} from "../services/items/serialize";
import { resolveExpands, applyExpandToRow } from "../services/items/expand";
import { validateBody, validateRelations } from "../services/items/validate";
import { localizeRow, mergeI18nPatch } from "../services/items/i18n";
import {
  deletedFilter,
  execute,
  fromOf,
  nowFor,
  pkEq,
  queryAll,
  selectColRef,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "../services/items/sql-helpers";
import {
  collectNestedRelationChains,
  rewriteSortField,
  rewriteSystemFieldsInCondition,
} from "../services/items/permission-rewrite";
import {
  ItemBody,
  ItemRow,
  ListMeta,
  ListQuery,
  TAGS,
} from "../services/items/schemas";

export const itemsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}",
      tags: TAGS,
      summary: "List items",
      description:
        "Generic list endpoint for any collection. Supports Directus-shaped `filter`, `sort`, `fields`, `limit`, `offset`, `meta`. Item shape comes from the collection's field definitions; see the dynamic per-collection paths for typed schemas.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: ListQuery,
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(ItemRow),
                limit: z.number().int().nonnegative(),
                offset: z.number().int().nonnegative(),
                meta: ListMeta.optional(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const params = new URL(c.req.url).searchParams;
      const q = parseQuery(
        params,
        collection.fields,
        collection.ownerScoped,
        perm.fields,
        collection.defaultSort,
      );

      // User-supplied filters and permission whereSql both reference system
      // fields by their logical names (`created_at`, `owner_id`). Rewrite
      // those keys to the actual physical column before compiling so the
      // generated SQL doesn't refer to columns the source table doesn't have.
      // perm.whereSql is already compiled (we can't re-rewrite it here);
      // permissions only reference `owner_id`, and the side-table join
      // surfaces an unqualified `owner_id` so the existing perm SQL still
      // works in that case. For the alias path the workspace admin is
      // responsible for crafting permission conditions against the aliased
      // column name directly.
      const userFilter = q.filter ? rewriteSystemFieldsInCondition(q.filter, collection) : null;

      // Nested-relation joins: for every `<a>.<b>[…].<leaf>` key in the
      // filter or sort, walk the relation chain `[a, b, …]` and LEFT JOIN
      // each hop's target table. Joins are keyed by the full prefix chain
      // so two filter clauses sharing the same join path collapse to one
      // JOIN (e.g. `customer_id.address_id.city` and
      // `customer_id.address_id.zip` produce one join on customers and
      // one on addresses, not two of each).
      //
      // parseQuery already validated the HEAD is a `relation` /
      // `relation_many` field the caller may read, and that every other
      // segment has safe identifier shape. The per-hop target collection
      // lookup + per-hop read permission + leaf field-existence /
      // permission check happen here, since parseQuery doesn't have
      // access to target collections.
      const nestedChains = userFilter
        ? collectNestedRelationChains(userFilter)
        : new Map<string, string[]>();
      // Sort can also reach into a relation — multi-hop allowed too
      // (`-customer_id.address_id.city`). Mix those chains into the
      // single JOIN pass so we don't materialize two ladders for the
      // same prefix.
      for (const s of q.sort) {
        if (s.field.includes(".")) {
          const segs = s.field.split(".");
          const chain = segs.slice(0, -1);
          if (chain.length === 0) continue;
          const key = chain.join(".");
          if (!nestedChains.has(key)) nestedChains.set(key, chain);
        }
      }
      // Snapshot every (chain, leaf) pair used by the filter so we can
      // verify the leaf exists on the FINAL target collection — otherwise
      // compileCondition emits a bare `rel_x.bogus = ?` which fails at
      // the SQL layer with a 500 instead of the 422 the caller deserves.
      const collectNestedLeaves = (
        cond: any,
        out: Map<string, Set<string>>,
      ): void => {
        if (cond === null || cond === undefined) return;
        if (Array.isArray(cond.$and)) {
          for (const sub of cond.$and) collectNestedLeaves(sub, out);
          return;
        }
        if (Array.isArray(cond.$or)) {
          for (const sub of cond.$or) collectNestedLeaves(sub, out);
          return;
        }
        if (cond.$not !== undefined) {
          collectNestedLeaves(cond.$not, out);
          return;
        }
        for (const k of Object.keys(cond)) {
          if (k.includes(".")) {
            const segs = k.split(".");
            const leaf = segs[segs.length - 1]!;
            const chainKey = segs.slice(0, -1).join(".");
            if (!out.has(chainKey)) out.set(chainKey, new Set());
            out.get(chainKey)!.add(leaf);
          }
        }
      };
      const nestedLeaves = new Map<string, Set<string>>();
      if (userFilter) collectNestedLeaves(userFilter, nestedLeaves);
      // Sort leaves also need to exist on the target collection — fold
      // them into the same map.
      for (const s of q.sort) {
        if (s.field.includes(".")) {
          const segs = s.field.split(".");
          const leaf = segs[segs.length - 1]!;
          const chainKey = segs.slice(0, -1).join(".");
          if (!nestedLeaves.has(chainKey)) nestedLeaves.set(chainKey, new Set());
          nestedLeaves.get(chainKey)!.add(leaf);
        }
      }
      // joinMap: key = full chain (dot-joined), value = { alias, target }.
      // For 1-hop the key is the bare head — preserves the old shape so
      // single-hop call sites keep working. For 2/3-hop the key is the
      // multi-segment chain (`customer_id.address_id`).
      const joinMap = new Map<
        string,
        { alias: string; target: CollectionRow }
      >();
      // Heads on `relation_many` fields don't get a JOIN — instead the
      // leaf compiler below lowers `<head>.<sub>` into an EXISTS subquery
      // against the target table, keyed by JSON-array membership. Only
      // SINGLE-HOP relation_many chains are supported; a relation_many
      // anywhere in a multi-hop chain is rejected (joining through a
      // JSON-array would need a different lowering — left for a follow-up).
      const manyHeadMap = new Map<
        string,
        { target: CollectionRow }
      >();
      const extraJoins: SQL[] = [];
      // Per-target field-existence + per-target permission check, used by
      // both JOIN and EXISTS paths.
      const enforceTargetSubs = (
        toSlug: string,
        target: CollectionRow,
        targetPerm: { fields: Set<string> | null },
        subs: Iterable<string>,
      ): void => {
        const targetSys = new Set<string>(["id"]);
        if (target.hasCreatedAt) targetSys.add("created_at");
        if (target.hasUpdatedAt) targetSys.add("updated_at");
        if (target.ownerScoped) targetSys.add("owner_id");
        const targetFieldNames = new Set(target.fields.map((f) => f.name));
        for (const s of subs) {
          const isSystem = targetSys.has(s);
          const isField = targetFieldNames.has(s);
          if (!isSystem && !isField) {
            throw new AppError(
              "VALIDATION",
              `Unknown field on relation target "${toSlug}": ${s}`,
            );
          }
          if (
            !isSystem &&
            targetPerm.fields &&
            !targetPerm.fields.has(s)
          ) {
            throw new AppError(
              "FORBIDDEN",
              `No permission to read "${toSlug}.${s}"`,
            );
          }
        }
      };
      // Resolve a relation hop from a source collection: find the FK
      // field, load the target, gate read permission, return the target.
      // Throws AppError on any failure so the caller surfaces a clean 4xx.
      const resolveHop = async (
        source: CollectionRow,
        segment: string,
        position: "head" | "middle" | "leaf-relation",
      ): Promise<{ def: FieldDef; target: CollectionRow; perm: { fields: Set<string> | null } }> => {
        const def = source.fields.find((f) => f.name === segment);
        if (!def || (def.type !== "relation" && def.type !== "relation_many")) {
          throw new AppError(
            "VALIDATION",
            `Nested filter hop "${segment}" on "${source.slug}" is not a relation field`,
          );
        }
        if (!def.to) {
          throw new AppError(
            "VALIDATION",
            `Relation "${source.slug}.${segment}" has no target collection`,
          );
        }
        // Multi-hop chains can't traverse `relation_many` at non-leaf
        // positions — joining through a JSON-array of foreign ids would
        // need a separate lowering (LATERAL unnest on PG, sub-SELECT on
        // SQLite) and per-row semantics that don't compose with LEFT
        // JOIN. Rejected here so the caller gets a precise 422.
        if (def.type === "relation_many" && position === "middle") {
          throw new AppError(
            "VALIDATION",
            `Multi-hop nested filter through relation_many is not supported: "${source.slug}.${segment}"`,
          );
        }
        let target: CollectionRow;
        try {
          target = await loadCollection(ctx, auth.tenantId, def.to);
        } catch {
          throw new AppError(
            "VALIDATION",
            `Relation target not active: ${def.to}`,
          );
        }
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
        return { def, target, perm: { fields: targetPerm.fields } };
      };
      // Walk each chain hop-by-hop, materializing one LEFT JOIN per hop
      // and recording aliases in joinMap under every prefix so the leaf
      // colRef resolver can look up the alias by its full chain prefix.
      // Per-hop join cache: if two chains share a prefix (`a.b.c1` and
      // `a.b.c2`), the `a` and `a.b` joins are emitted only once.
      const joinedPrefixes = new Set<string>();
      const baseTbl = sql.identifier(collection.physicalTable);
      // Deterministic order: longest chains last keeps the LEFT JOIN
      // ladder bottom-up. Sorting by chain length is enough — JS Map
      // preserves insertion order but later mutation (sort folding from
      // q.sort above) may have jumbled it.
      const chainList = [...nestedChains.values()].sort(
        (a, b) => a.length - b.length,
      );
      for (const chain of chainList) {
        let source: CollectionRow = collection;
        // `parentAliasId` is the SQL fragment that qualifies the FK
        // column on the parent hop's table — base table at hop 0, the
        // previous alias for hops 1+. Held as a SQL fragment (not a raw
        // identifier) so `sql.join` works downstream.
        let parentAliasId: SQL = sql`${baseTbl}`;
        for (let i = 0; i < chain.length; i++) {
          const segment = chain[i]!;
          const isLastHop = i === chain.length - 1;
          const isFirstHop = i === 0;
          const position: "head" | "middle" | "leaf-relation" = isLastHop
            ? "leaf-relation"
            : isFirstHop
              ? "head"
              : "middle";
          const prefix = chain.slice(0, i + 1).join(".");
          if (joinedPrefixes.has(prefix)) {
            // Already wired up by a sibling chain — just advance.
            const cached = joinMap.get(prefix);
            if (cached) {
              source = cached.target;
              parentAliasId = sql`${sql.identifier(cached.alias)}`;
            }
            continue;
          }
          const hop = await resolveHop(source, segment, position);
          const def = hop.def;
          const target = hop.target;
          // Single-hop relation_many: side-band to the EXISTS lowering
          // (no JOIN). Only valid at the head of a SINGLE-hop chain;
          // resolveHop already rejected it at middle positions, and a
          // chain whose last hop is relation_many implies the leaf
          // filter is `head.leaf` (chain length 1) — fine. A multi-hop
          // chain whose LAST hop is relation_many means an intermediate
          // hop landed on a collection that exposes a relation_many
          // field; that case still wants the EXISTS lowering but we
          // don't support it here — reject.
          if (def.type === "relation_many") {
            if (chain.length > 1) {
              throw new AppError(
                "VALIDATION",
                `Multi-hop nested filter through relation_many is not supported: "${chain.join(".")}"`,
              );
            }
            // Single-hop: the leaves of this chain were collected under
            // the prefix `head`; validate them against the target now.
            enforceTargetSubs(
              def.to!,
              target,
              hop.perm,
              nestedLeaves.get(prefix) ?? [],
            );
            manyHeadMap.set(segment, { target });
            joinedPrefixes.add(prefix);
            // No JOIN; stop walking — relation_many is terminal in this
            // branch.
            break;
          }
          // Plain `relation`: emit a LEFT JOIN.
          // Alias = `rel_<seg1>__<seg2>__…__<segN>` (full prefix). The
          // `__` separator keeps it unique against shorter prefixes
          // (`rel_a` vs `rel_a__b`) and PG-identifier-safe up to 63
          // chars (3-hop alias is ≤ ~45 chars in practice).
          const alias = `rel_${chain.slice(0, i + 1).join("__")}`;
          const targetTbl = sql.identifier(target.physicalTable);
          const aliasId = sql.identifier(alias);
          const onParts: SQL[] = [
            sql`${aliasId}.${sql.identifier(target.pkColumn)} = ${parentAliasId}.${sql.identifier(segment)}`,
          ];
          // Cross-tenant guard on every hop: a stale FK pointing across
          // workspaces should never surface the related row.
          if (target.tenantScoped && auth.tenantId) {
            onParts.push(sql`${aliasId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`);
          }
          extraJoins.push(
            sql`LEFT JOIN ${targetTbl} AS ${aliasId} ON ${sql.join(onParts, sql` AND `)}`,
          );
          joinMap.set(prefix, { alias, target });
          joinedPrefixes.add(prefix);
          // At the leaf hop, validate the requested sub-columns exist on
          // the final target — both the leaves that came from filter
          // keys (collected into nestedLeaves) and any sort leaves.
          if (isLastHop) {
            enforceTargetSubs(
              def.to!,
              target,
              hop.perm,
              nestedLeaves.get(prefix) ?? [],
            );
          }
          source = target;
          parentAliasId = sql`${aliasId}`;
        }
      }
      // `?expand=<head>` wires LEFT JOINs that share aliases with the
      // nested-filter chain walker above (`rel_<head>` is the same alias
      // whether it came from a filter, a sort, or an expand). Resolver
      // gates per-target read permission + tenant scope on every entry.
      const {
        extraJoins: expandJoins,
        selects: expandSelects,
        plans: expandPlans,
      } = await resolveExpands(ctx, auth, collection, q.expand, joinMap, q.expandSubs);
      for (const j of expandJoins) extraJoins.push(j);
      const hasJoins = extraJoins.length > 0;

      // Custom colRef: nested keys route to the join alias; plain fields
      // get qualified to the base table when joins are present (otherwise
      // unqualified `id` / `tenant_id` would be ambiguous against the
      // joined relation target). When there are no joins, default behavior
      // (`sql.identifier(field)`) is preserved.
      const baseTblId = sql.identifier(collection.physicalTable);
      const usesSideTable = usesOwnershipSideTable(collection);
      const nestedColRef: ColRefResolver = (field) => {
        if (field.includes(".")) {
          const segs = field.split(".");
          const leaf = segs[segs.length - 1]!;
          const chainKey = segs.slice(0, -1).join(".");
          const j = joinMap.get(chainKey);
          if (!j) return sql`${sql.identifier(field)}`; // unreachable
          return sql`${sql.identifier(j.alias)}.${sql.identifier(leaf)}`;
        }
        if (hasJoins) {
          // `owner_id` is special when ownership lives in the side table —
          // it comes from `item_ownership.owner_id`, not the base table.
          if (field === "owner_id" && usesSideTable) {
            return sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")}`;
          }
          // Qualify to the base table to disambiguate columns the joined
          // target also exposes (`id`, `tenant_id`, `created_at`, etc.).
          return sql`${baseTblId}.${sql.identifier(field)}`;
        }
        return sql`${sql.identifier(field)}`;
      };

      // Leaf compiler for `relation_many` heads: lower `<head>.<sub>` to
      // an EXISTS subquery against the target table, joining on JSON-array
      // membership. The array storage is dialect-specific (PG: `jsonb`,
      // SQLite: text-JSON), so the membership unpack uses
      // `jsonb_array_elements_text` / `json_each`. The actual `<sub>` vs
      // operator semantics are reused by recursing into `compileCondition`
      // with a synthetic `{ [sub]: cmp }` condition and a per-subquery
      // colRef that points at `sub.<sub_col>` — that way every operator
      // (`_eq`, `_in`, `_contains`, …) keeps its existing implementation.
      const relationManyLeaf: LeafCompiler | undefined = manyHeadMap.size > 0
        ? (field, cmp, leafCtx) => {
            if (!field.includes(".")) return null;
            // Only single-hop relation_many is supported here
            // (`tags.name`). Multi-hop chains were rejected upstream when
            // building joins, but be defensive: ignore any 2+ hop field
            // here so we never emit malformed SQL.
            const segs = field.split(".");
            if (segs.length !== 2) return null;
            const [head, sub] = segs as [string, string];
            const entry = manyHeadMap.get(head);
            if (!entry) return null;
            const target = entry.target;
            const targetTbl = sql.identifier(target.physicalTable);
            const subAlias = sql.identifier("sub");
            const subColRef: ColRefResolver = () =>
              sql`${subAlias}.${sql.identifier(sub)}`;
            const innerWhere = compileCondition(
              { [sub]: cmp },
              leafCtx,
              subColRef,
              undefined,
              { dialect: ctx.dialect },
            );
            const baseCol = hasJoins
              ? sql`${baseTblId}.${sql.identifier(head)}`
              : sql`${sql.identifier(head)}`;
            // Pin tenant on the subquery for tenant-scoped targets so a
            // stray id leaking across workspaces can't satisfy the EXISTS.
            const tenantClause =
              target.tenantScoped && auth.tenantId
                ? sql` AND ${subAlias}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
                : sql``;
            // Don't let a soft-deleted target row satisfy the EXISTS — the
            // relation filter must see the same live rows the target's own
            // list endpoint would.
            const deletedClause = target.softDelete
              ? sql` AND ${subAlias}.${sql.identifier("deleted_at")} IS NULL`
              : sql``;
            const pkRef = sql`${subAlias}.${sql.identifier(target.pkColumn)}`;
            const arrayUnpack =
              ctx.dialect === "pg"
                ? sql`SELECT value FROM jsonb_array_elements_text(${baseCol})`
                : sql`SELECT value FROM json_each(${baseCol})`;
            return sql`EXISTS (SELECT 1 FROM ${targetTbl} AS ${subAlias} WHERE ${pkRef} IN (${arrayUnpack})${tenantClause}${deletedClause} AND ${innerWhere})`;
          }
        : undefined;

      const userWhere = userFilter
        ? compileCondition(userFilter, auth, nestedColRef, relationManyLeaf, {
            dialect: ctx.dialect,
          })
        : null;
      // When joins are present, recompile permission conditions so their
      // unqualified column references (`owner_id` etc.) also get pinned to
      // the base table. `perm.conditions === null` means at least one
      // matching permission row was unconditional → stays null. Otherwise
      // recompile through the join-aware colRef. Permission conditions
      // never reference dotted relation_many keys (they're defined per-
      // collection by admins), so we don't need to thread the leaf
      // compiler through this path.
      const permWhere =
        hasJoins && perm.conditions
          ? combineConditions(perm.conditions, auth, nestedColRef, undefined, {
              dialect: ctx.dialect,
            })
          : perm.whereSql;
      const tenantWhereRaw = tenantFilter(collection, auth);
      const tenantWhere =
        hasJoins && tenantWhereRaw && collection.tenantScoped && auth.tenantId
          ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
          : tenantWhereRaw;
      // Hide soft-deleted rows. When joins are present the column must be
      // qualified to the base table (same reason the tenant clause is).
      const deletedWhere = deletedFilter(
        collection,
        hasJoins ? collection.physicalTable : undefined,
      );
      const wheres = [userWhere, permWhere, tenantWhere, deletedWhere].filter(
        (x): x is SQL => x != null,
      );
      const whereClause = wheres.length
        ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
        : sql``;

      const projection = resolveProjection(
        q,
        collection.fields,
        collection.ownerScoped,
        perm.fields,
        { hasCreatedAt: collection.hasCreatedAt, hasUpdatedAt: collection.hasUpdatedAt },
      );
      // When relation joins are present the SELECT must qualify every base-
      // table column — bare `*` / bare identifiers would surface the joined
      // target's `id`/`created_at`/etc. and the wire shape would silently
      // swap to the related row.
      const buildStarWithJoins = (): SQL => {
        const parts: SQL[] = [sql`${baseTblId}.*`];
        if (usesSideTable) {
          parts.push(
            sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`,
          );
        }
        if (
          collection.hasCreatedAt &&
          collection.createdAtColumn &&
          collection.createdAtColumn !== "created_at"
        ) {
          parts.push(
            sql`${baseTblId}.${sql.identifier(collection.createdAtColumn)} AS ${sql.identifier("created_at")}`,
          );
        }
        if (
          collection.hasUpdatedAt &&
          collection.updatedAtColumn &&
          collection.updatedAtColumn !== "updated_at"
        ) {
          parts.push(
            sql`${baseTblId}.${sql.identifier(collection.updatedAtColumn)} AS ${sql.identifier("updated_at")}`,
          );
        }
        if (
          collection.ownerScoped &&
          collection.adopted &&
          collection.ownerIdColumn
        ) {
          parts.push(
            sql`${baseTblId}.${sql.identifier(collection.ownerIdColumn)} AS ${sql.identifier("owner_id")}`,
          );
        }
        return sql.join(parts, sql`, `);
      };
      const buildProjectedWithJoins = (cols: string[]): SQL =>
        sql.join(
          cols.map((col) => {
            const ref = selectColRef(collection, col);
            // selectColRef already qualifies three special cases (owner
            // side-table, aliased created_at, aliased updated_at); every
            // other branch returns a bare identifier — needs the base-
            // table prefix when joins are present.
            const aliased =
              (col === "owner_id" &&
                (usesSideTable ||
                  !!(collection.ownerIdColumn &&
                    collection.ownerIdColumn !== "owner_id"))) ||
              (col === "created_at" &&
                !!(collection.createdAtColumn &&
                  collection.createdAtColumn !== "created_at")) ||
              (col === "updated_at" &&
                !!(collection.updatedAtColumn &&
                  collection.updatedAtColumn !== "updated_at"));
            if (aliased) return ref;
            return sql`${baseTblId}.${sql.identifier(col)}`;
          }),
          sql`, `,
        );
      const baseSelectCols: SQL = projection
        ? hasJoins
          ? buildProjectedWithJoins(projection)
          : sql.join(
              projection.map((col) => selectColRef(collection, col)),
              sql`, `,
            )
        : hasJoins
          ? buildStarWithJoins()
          : selectStar(collection);
      // Append `__expand_<head>` columns when expansions are requested.
      // They live alongside the base SELECT and never collide because the
      // double-underscore prefix is reserved for system-emitted aliases.
      const selectCols: SQL = expandSelects.length
        ? sql`${baseSelectCols}, ${sql.join(expandSelects, sql`, `)}`
        : baseSelectCols;

      const orderClause = sql.join(
        q.sort.map((s) => {
          // Nested sort routes through the same `rel_<chain>` alias the
          // filter JOINs added. parseQuery already validated the head is
          // a relation field; items.ts above walked the chain, resolved
          // each target, and recorded an entry in joinMap under the full
          // chain prefix. Multi-hop sort sees the deepest join alias
          // (`rel_customer_id__address_id`) and references its leaf
          // column directly.
          if (s.field.includes(".")) {
            const segs = s.field.split(".");
            const leaf = segs[segs.length - 1]!;
            const chainKey = segs.slice(0, -1).join(".");
            const j = joinMap.get(chainKey);
            const ref = j
              ? sql`${sql.identifier(j.alias)}.${sql.identifier(leaf)}`
              : sql`${sql.identifier(s.field)}`;
            return sql`${ref} ${sql.raw(s.dir.toUpperCase())}`;
          }
          const physical = rewriteSortField(s.field, collection);
          const ref = hasJoins
            ? sql`${baseTblId}.${sql.identifier(physical)}`
            : sql`${sql.identifier(physical)}`;
          return sql`${ref} ${sql.raw(s.dir.toUpperCase())}`;
        }),
        sql`, `,
      );

      const fromClause: SQL = hasJoins
        ? sql`${fromOf(collection)} ${sql.join(extraJoins, sql` `)}`
        : fromOf(collection);

      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectCols} FROM ${fromClause} ${whereClause} ORDER BY ${orderClause} LIMIT ${q.limit} OFFSET ${q.offset}`,
      );

      let metaOut: { filter_count?: number; total_count?: number } | undefined;
      if (q.meta.filterCount || q.meta.totalCount) {
        metaOut = {};
        if (q.meta.filterCount) {
          const r = await queryAll<{ count: number | string | bigint }>(
            ctx,
            sql`SELECT COUNT(*) AS count FROM ${fromClause} ${whereClause}`,
          );
          metaOut.filter_count = Number(r[0]?.count ?? 0);
        }
        if (q.meta.totalCount) {
          // total_count still respects tenant scoping — never leak rows from
          // sibling workspaces to the API consumer. No nested joins here:
          // the total is meant to count *everything visible to this tenant*
          // regardless of the filter.
          // Soft-deleted rows must be excluded here too, or total_count
          // overcounts everything that was logically removed.
          const totalFilters = [tenantWhereRaw, deletedFilter(collection)].filter(
            (x): x is SQL => x != null,
          );
          const totalWhere = totalFilters.length
            ? sql`WHERE ${sql.join(totalFilters, sql` AND `)}`
            : sql``;
          const r = await queryAll<{ count: number | string | bigint }>(
            ctx,
            sql`SELECT COUNT(*) AS count FROM ${fromOf(collection)} ${totalWhere}`,
          );
          metaOut.total_count = Number(r[0]?.count ?? 0);
        }
      }

      const locale = c.req.query("locale") ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasI18nField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
      return c.json({
        data: rows.map((r) => {
          const out = localizeRow(
            deserializeRow(
              r,
              collection.fields,
              ctx.dialect,
              collection.ownerScoped,
              projection,
            ),
            collection.fields,
            locale,
            defaultLocale,
          );
          // Substitute the raw FK id with the inlined target row. The
          // `__expand_<head>` JSON object was emitted by the SELECT; we
          // parse + camelCase + timestamp-deserialize it here so the
          // wire shape matches `GET /api/items/<target>/<id>`. Done
          // AFTER localizeRow so localized i18n_text fields on the
          // target keep their own behavior (no double-projection).
          if (expandPlans.length > 0) {
            applyExpandToRow(out, r, expandPlans, ctx.dialect);
          }
          return out;
        }),
        limit: q.limit,
        offset: q.offset,
        ...(metaOut ? { meta: metaOut } : {}),
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Get item",
      description: "Fetches one row by primary key. Respects per-role read field projection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({
          locale: z.string().optional(),
          expand: z.string().optional().openapi({
            description:
              "Comma-separated relation fields to inline-expand. Single-hop only.",
          }),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      // `?expand=` works the same shape as on the list endpoint, but
      // single-GET doesn't go through parseQuery — so we inline the
      // source-side validation here (chain reject, type check, source
      // perm-fields gate). resolveExpands enforces the per-target read
      // permission + tenant scope, same as the list path.
      const expand: string[] = [];
      const expandRaw = c.req.query("expand");
      if (expandRaw) {
        const fieldsByName = new Map(collection.fields.map((f) => [f.name, f] as const));
        const seen = new Set<string>();
        for (const raw of expandRaw.split(",")) {
          const name = raw.trim();
          if (!name) continue;
          if (name.includes(".")) {
            throw new AppError(
              "VALIDATION",
              `expand chain not yet supported: ${name}`,
            );
          }
          const def = fieldsByName.get(name);
          if (!def) {
            throw new AppError("VALIDATION", `Unknown expand field: ${name}`);
          }
          if (def.type === "relation_many") {
            throw new AppError(
              "VALIDATION",
              `expand on relation_many not yet supported: ${name}`,
            );
          }
          if (def.type !== "relation") {
            throw new AppError(
              "VALIDATION",
              `expand only works on relation fields — "${name}" is ${def.type}`,
            );
          }
          if (perm.fields && !perm.fields.has(name)) {
            throw new AppError(
              "FORBIDDEN",
              `No permission to read field: ${name}`,
            );
          }
          if (!seen.has(name)) {
            seen.add(name);
            expand.push(name);
          }
        }
      }

      const joinMap = new Map<string, { alias: string; target: CollectionRow }>();
      const {
        extraJoins: expandJoins,
        selects: expandSelects,
        plans: expandPlans,
      } = await resolveExpands(ctx, auth, collection, expand, joinMap);
      const hasJoins = expandJoins.length > 0;
      // When joins are added, `*` would surface the target's columns too —
      // qualify everything to the base table the same way the list handler
      // does. selectStar still handles the aliased-system-column cases.
      const baseTblId = sql.identifier(collection.physicalTable);
      const baseSelect: SQL = hasJoins
        ? (() => {
            const parts: SQL[] = [sql`${baseTblId}.*`];
            if (usesOwnershipSideTable(collection)) {
              parts.push(
                sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`,
              );
            }
            if (
              collection.hasCreatedAt &&
              collection.createdAtColumn &&
              collection.createdAtColumn !== "created_at"
            ) {
              parts.push(
                sql`${baseTblId}.${sql.identifier(collection.createdAtColumn)} AS ${sql.identifier("created_at")}`,
              );
            }
            if (
              collection.hasUpdatedAt &&
              collection.updatedAtColumn &&
              collection.updatedAtColumn !== "updated_at"
            ) {
              parts.push(
                sql`${baseTblId}.${sql.identifier(collection.updatedAtColumn)} AS ${sql.identifier("updated_at")}`,
              );
            }
            if (
              collection.ownerScoped &&
              collection.adopted &&
              collection.ownerIdColumn
            ) {
              parts.push(
                sql`${baseTblId}.${sql.identifier(collection.ownerIdColumn)} AS ${sql.identifier("owner_id")}`,
              );
            }
            return sql.join(parts, sql`, `);
          })()
        : selectStar(collection);
      const selectCols: SQL = expandSelects.length
        ? sql`${baseSelect}, ${sql.join(expandSelects, sql`, `)}`
        : baseSelect;
      // PK and tenant filter both need to qualify to the base table when
      // there's a join — same reason `nestedColRef` qualifies in the list
      // handler. Permission's whereSql is left untouched: in this path
      // permissions only reference `owner_id`, which (a) is provided
      // unqualified in our base SELECT (managed `owner_id` column or
      // side-table-join surfaced alias) and (b) is unambiguous because
      // the joined targets only expose `owner_id` if they're owner-scoped
      // — even then, the column is on the alias, not unqualified.
      const pkWhere = hasJoins
        ? sql`${baseTblId}.${sql.identifier(collection.pkColumn)} = ${c.req.param("id")}`
        : pkEq(collection.pkColumn, c.req.param("id"));
      const tenantWhereRaw = tenantFilter(collection, auth);
      const tenantWhere =
        hasJoins && tenantWhereRaw && collection.tenantScoped && auth.tenantId
          ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
          : tenantWhereRaw;
      const fromClause: SQL = hasJoins
        ? sql`${fromOf(collection)} ${sql.join(expandJoins, sql` `)}`
        : fromOf(collection);
      const deletedWhere = deletedFilter(
        collection,
        hasJoins ? collection.physicalTable : undefined,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectCols} FROM ${fromClause} ${whereOf(pkWhere, perm.whereSql, tenantWhere, deletedWhere)} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      const locale = c.req.query("locale") ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasI18nField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
      const projected = projectFields(
        localizeRow(
          deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped),
          collection.fields,
          locale,
          defaultLocale,
        ),
        perm.fields,
      );
      // Expand AFTER projectFields so the inlined object survives the
      // perm.fields trim even when the source FK key (e.g. `customer_id`)
      // would have been kept by virtue of being in perm.fields, but a
      // user who has source perm but no `customer_id` in their fields
      // allow-list still can't expand it — parseQuery's source-perm gate
      // above rejects that case first.
      if (expandPlans.length > 0) {
        applyExpandToRow(projected, rows[0], expandPlans, ctx.dialect);
      }
      return c.json({ data: projected });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}",
      tags: TAGS,
      summary: "Create item",
      description:
        "Creates a row in the collection. Body shape is the collection's field map; adopted collections must include the primary key value.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "create")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: ItemBody } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const data = (await c.req.json()) as Record<string, unknown>;
      // PK extraction MUST happen before validateBody — adopted collections
      // accept the PK in the body, but the PK isn't in `collection.fields`,
      // so validateBody would reject it as an unknown field otherwise.
      const table = collection.physicalTable;
      let id: string;
      if (collection.adopted) {
        const pkVal = data[collection.pkColumn];
        if (pkVal === undefined || pkVal === null || pkVal === "") {
          throw new AppError(
            "VALIDATION",
            `Primary key "${collection.pkColumn}" is required in the body for adopted collections`,
          );
        }
        id = String(pkVal);
        delete data[collection.pkColumn];
      } else {
        id = crypto.randomUUID();
      }
      validateBody(data, collection.fields, false, perm.fields);
      await validateRelations(data, collection.fields, ctx, auth.tenantId);
      // Singleton: reject the insert when a live row already exists (scoped to
      // the tenant, ignoring soft-deleted rows). Not a DB constraint, so this
      // is a best-effort check — two truly-concurrent inserts could both pass.
      if (collection.singleton) {
        const existingOne = await queryAll<{ one: number }>(
          ctx,
          sql`SELECT 1 AS one FROM ${fromOf(collection)} ${whereOf(tenantFilter(collection, auth), deletedFilter(collection))} LIMIT 1`,
        );
        if (existingOne[0]) {
          throw new AppError(
            "VALIDATION",
            "This collection is a singleton and already has a row",
          );
        }
      }
      if (hasI18nField(collection.fields)) {
        const writeLocale = c.req.query("locale") ?? null;
        mergeI18nPatch(data, {}, collection.fields, writeLocale);
      }
      const now = nowFor(ctx.dialect);

      const cols: string[] = [collection.pkColumn];
      const vals: unknown[] = [id];
      if (collection.hasCreatedAt) {
        cols.push(collection.createdAtColumn ?? "created_at");
        vals.push(now);
      }
      if (collection.hasUpdatedAt) {
        cols.push(collection.updatedAtColumn ?? "updated_at");
        vals.push(now);
      }
      // Managed owner_id column lives on the physical row; adopted collections
      // use the side-table `item_ownership` instead (written below, after the
      // row insert succeeds — see the adopted ownership branch).
      if (collection.ownerScoped && !collection.adopted) {
        cols.push("owner_id");
        vals.push(auth.userId);
      }
      if (collection.tenantScoped) {
        if (!auth.tenantId) {
          throw new AppError(
            "VALIDATION",
            "Active tenant could not be resolved; cannot insert into tenant-scoped collection",
          );
        }
        cols.push("tenant_id");
        vals.push(auth.tenantId);
      }
      for (const f of collection.fields) {
        if (data[f.name] === undefined) continue;
        cols.push(f.name);
        vals.push(serialize(data[f.name], f.type, ctx.dialect));
      }

      const colSql = sql.join(
        cols.map((n) => sql.identifier(n)),
        sql`, `,
      );
      const valSql = sql.join(
        vals.map((v) => sql`${v}`),
        sql`, `,
      );
      await execute(
        ctx,
        sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`,
      );
      // Adopted owner-scoped collections carry ownership in the side table.
      // We INSERT here, post-row-insert, so a FK violation on a missing
      // collection row would fail before we wrote to the user's table.
      if (usesOwnershipSideTable(collection) && auth.userId) {
        await execute(
          ctx,
          sql`INSERT INTO ${sql.identifier("item_ownership")} (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}, ${sql.identifier("owner_id")}, ${sql.identifier("created_at")})
              VALUES (${collection.id}, ${id}, ${auth.userId}, ${now})`,
        );
      }

      const out: Record<string, unknown> = { id, ...data };
      if (collection.hasCreatedAt) out.createdAt = deserialize(now, "timestamp", ctx.dialect);
      if (collection.hasUpdatedAt) out.updatedAt = deserialize(now, "timestamp", ctx.dialect);
      if (collection.ownerScoped) out.ownerId = auth.userId;
      await embedAndUpsert(
        ctx,
        collection,
        auth.tenantId ?? null,
        id,
        data,
      );
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "created", data: out },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      const projected = projectFields(out, perm.fields);
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "create",
          collection: collection.slug,
          itemId: id,
          ...meta,
          payload: data,
          response: { data: projected },
          durationMs: elapsedMs(c),
        },
      );
      return c.json({ data: projected }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Update item",
      description:
        "Partial update. `i18n_text` fields merge into the existing locale map; pass `?locale=xx` with a string value to upsert one locale.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: ItemBody } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const id = c.req.param("id");
      const patch = (await c.req.json()) as Record<string, unknown>;
      validateBody(patch, collection.fields, true, perm.fields);
      await validateRelations(patch, collection.fields, ctx, auth.tenantId);

      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);
      // Soft-deleted rows are invisible to updates too — a PATCH on one is a
      // 404, same as a read.
      const existing = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))} LIMIT 1`,
      );
      if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
      const beforeRow = deserializeRow(
        existing[0],
        collection.fields,
        ctx.dialect,
        collection.ownerScoped,
      );

      if (hasI18nField(collection.fields)) {
        const writeLocale = c.req.query("locale") ?? null;
        mergeI18nPatch(patch, beforeRow, collection.fields, writeLocale);
      }

      const now = nowFor(ctx.dialect);
      const sets: SQL[] = [];
      if (collection.hasUpdatedAt) {
        sets.push(sql`${sql.identifier(collection.updatedAtColumn ?? "updated_at")} = ${now}`);
      }
      for (const f of collection.fields) {
        if (patch[f.name] === undefined) continue;
        sets.push(
          sql`${sql.identifier(f.name)} = ${serialize(patch[f.name], f.type, ctx.dialect)}`,
        );
      }

      // If nothing to update (no updated_at + no field patches), skip the UPDATE
      // entirely — emitting `SET ` with no clauses is a syntax error.
      if (sets.length > 0) {
        await execute(
          ctx,
          sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
        );
      }

      const refreshed = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), tenantWhere)} LIMIT 1`,
      );
      const refreshedRow = deserializeRow(
        refreshed[0]!,
        collection.fields,
        ctx.dialect,
        collection.ownerScoped,
      );
      await embedAndUpsert(
        ctx,
        collection,
        auth.tenantId ?? null,
        id,
        refreshedRow,
      );
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "updated", data: refreshedRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      const projected = projectFields(refreshedRow, perm.fields);
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: id,
          ...meta,
          payload: patch,
          response: { data: projected },
          durationMs: elapsedMs(c),
        },
      );
      await recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: beforeRow,
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
        },
      );
      return c.json({ data: projected });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Delete item",
      description: "Hard-deletes the row. Cascades to ownership side table + vector store.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "delete")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
      },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const id = c.req.param("id");
      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);

      // Filter out already-soft-deleted rows so a repeat delete is a clean
      // 404 (idempotent) rather than re-stamping deleted_at and re-firing the
      // "deleted" event.
      const deletedWhere = deletedFilter(collection);
      const existing = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedWhere)} LIMIT 1`,
      );
      if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
      const oldRow = deserializeRow(
        existing[0],
        collection.fields,
        ctx.dialect,
        collection.ownerScoped,
      );

      if (collection.softDelete) {
        // Soft delete: stamp deleted_at instead of removing the row. Every
        // read path filters `deleted_at IS NULL`, so the row vanishes from
        // the API while staying recoverable in the physical table.
        await execute(
          ctx,
          sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("deleted_at")} = ${nowFor(ctx.dialect)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
        );
      } else {
        await execute(
          ctx,
          sql`DELETE FROM ${sql.identifier(table)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
        );
        // Cascade-clean the ownership side table for adopted owner-scoped rows.
        // No-op for everyone else (the row simply doesn't exist there). For
        // soft-delete we keep the ownership row — the item still logically
        // exists.
        if (usesOwnershipSideTable(collection)) {
          await execute(
            ctx,
            sql`DELETE FROM ${sql.identifier("item_ownership")}
                WHERE ${sql.identifier("collection_id")} = ${collection.id}
                AND ${sql.identifier("item_id")} = ${id}`,
          );
        }
      }
      await deleteVector(ctx, collection, id);
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "deleted", data: oldRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
          action: "delete",
          collection: collection.slug,
          itemId: id,
          ...meta,
          payload: oldRow,
          response: { ok: true },
          durationMs: elapsedMs(c),
        },
      );
      await recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: oldRow,
          userId: auth.userId,
          tenantId: auth.tenantId ?? null,
        },
      );
      return c.json({ ok: true });
    },
  )
  /**
   * Flip a versioned-collection row from `_status='draft'` to `'published'`
   * (or vice versa with `?unpublish=1`). Requires the caller to have
   * `update` permission on the collection.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/{id}/publish",
      tags: TAGS,
      summary: "Publish or unpublish a versioned item",
      description:
        "Versioned-collection only. Flips `_status` between `draft` and `published`; pass `?unpublish=1` to revert.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ unpublish: z.enum(["1"]).optional() }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      if (!collection.versioned) {
        throw new AppError(
          "VALIDATION",
          "Collection is not versioned — set `versioned: true` on the collection first",
        );
      }
      const id = c.req.param("id");
      const table = collection.physicalTable;
      const tenantWhere = tenantFilter(collection, auth);
      const unpublish = c.req.query("unpublish") === "1";
      const now = nowFor(ctx.dialect);
      const setSql = unpublish
        ? sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`
        : sql`${sql.identifier("_status")} = 'published', ${sql.identifier("_published_at")} = ${now}, ${sql.identifier("updated_at")} = ${now}`;
      await execute(
        ctx,
        sql`UPDATE ${sql.identifier(table)} SET ${setSql} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      const after = deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped);
      await publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: unpublish ? "unpublished" : "published", data: after },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      return c.json({ data: after });
    },
  );
