import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import {
  compileCondition,
  combineConditions,
  type FieldDef,
  type ColRefResolver,
  type GeoNearPlan,
  geoDistanceSql,
  type LeafCompiler,
  planNearOrThrow,
  sidecarFields,
} from "@backlex/db";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { parseQuery, queryShapeOf, resolveProjection, withMoneyCurrencyColumns } from "../../lib/query";
import { resolvePermission } from "../../services/permissions";
import { ftsMembershipWhere, isSearchable } from "../../services/fts";
import { loadAppSettings } from "../../services/settings";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  hasLocalizedField,
  loadCollection,
  type CollectionRow,
} from "../../services/items/collection-loader";
import {
  I18N_DEF_ALIAS,
  I18N_REQ_ALIAS,
  applySidecarLocalization,
  buildLocalizedSelects,
  buildSidecarJoins,
} from "../../services/items/i18n-sidecar";
import {
  deserializeRow,
} from "../../services/items/serialize";
import {
  resolveExpands,
  applyExpandToRow,
  relationAlias,
  resolveManyExpands,
  applyManyExpandsToRows,
} from "../../services/items/expand";
import {
  deletedFilter,
  draftFilter,
  fromOf,
  queryAll,
  retiredFilter,
  selectColRef,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
} from "../../services/items/sql-helpers";
import { parseRetiredScope } from "@backlex/db/retirement";
import {
  collectNestedRelationChains,
  rewriteSortField,
  rewriteSystemFieldsInCondition,
} from "../../services/items/permission-rewrite";
import {
  type KeysetPart,
  decodeCursor,
  encodeCursor,
  keysetWhere,
} from "../../services/items/keyset";
import {
  ItemRow,
  ListMeta,
  ListQuery,
  TAGS,
} from "../../services/items/schemas";
import { auditRead, canSeeDraftsFor } from "./shared";
import { stagedIdsFor } from "../../services/items/staged";
import { defaultHook } from "../../lib/openapi-router";

/** Distinct relation paths one query may reach through. Each is a JOIN ladder
 *  whose every hop costs a collection load and a permission resolution before
 *  any SQL runs; twenty is far past any real filter. */
const MAX_NESTED_CHAINS = 20;

export const itemsListRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}",
      tags: TAGS,
      summary: "List items",
      description:
        "Generic list endpoint for any collection. Supports operator-style `filter`, `sort`, `fields`, `limit`, `offset`, `meta`. Item shape comes from the collection's field definitions; see the dynamic per-collection paths for typed schemas.",
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
                // Present in classic offset mode; omitted in keyset mode.
                offset: z.number().int().nonnegative().optional(),
                // `true` when a further page exists (derived from a +1
                // over-fetch, so no extra COUNT round-trip).
                has_more: z.boolean().optional(),
                // Opaque keyset cursor for the next page; only in cursor mode,
                // null when this is the last page.
                next_cursor: z.string().nullable().optional(),
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
        isSearchable(collection),
        collection.versioned,
        ctx.dialect,
      );

      // Telemetry only: hand the span writer the columns this list actually
      // filters / sorts on so the advisor's runtime rules can suggest indexes
      // from real traffic instead of guessing from the schema. Names only —
      // no filter values — and it never affects the query below.
      c.set("queryShape", {
        collection: collection.slug,
        ...queryShapeOf(q),
      });

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

      // Localization: a concrete `?locale=xx` projects sidecar (`localized`) fields to that locale (with a fallback to
      // the workspace default); `?locale=*` / omitted returns full per-locale
      // maps. Resolve the default once here so the sidecar JOINs (added below)
      // and the row-shaping (further down) share it.
      const locale = c.req.query("locale") ?? null;
      const localeSingle = Boolean(locale) && locale !== "*";
      const localizedDefs = sidecarFields(collection.fields);
      const localizedNameSet = new Set(localizedDefs.map((f) => f.name));
      const geoFieldNames = new Set(
        collection.fields.filter((f: FieldDef) => f.type === "geo").map((f: FieldDef) => f.name),
      );
      const defaultLocale =
        locale && locale !== "*" && hasLocalizedField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;

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
      // Each distinct chain is its own JOIN ladder, and each hop in it costs a
      // collection load and a permission resolution before any SQL runs. That
      // was unbounded, and lifting the depth cap to three hops raised the
      // worst case per chain by half again — so bound the count. Twenty is far
      // past any real filter (a busy admin screen uses two or three) and turns
      // a query that would grind into a 422 that says what to do.
      if (nestedChains.size > MAX_NESTED_CHAINS) {
        throw new AppError(
          "VALIDATION",
          `Filter and sort reach through ${nestedChains.size} different relation paths; the limit is ${MAX_NESTED_CHAINS}. Narrow the query, or fetch in two calls.`,
        );
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
          // (`rel_a` vs `rel_a__b`).
          //
          // Built through `relationAlias`, which refuses one Postgres would
          // truncate. This comment used to claim the depth cap kept aliases
          // "PG-identifier-safe up to 63 chars" — it did not, because field
          // names have no length limit of their own, so two thirty-character
          // names already overflow at TWO hops and PG silently collapses the
          // two aliases into one.
          const alias = relationAlias(chain.slice(0, i + 1), ctx.dialect);
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
      // Split expand heads: to-one (`relation`) ride the JOIN resolver; to-many
      // (`relation_many`) are batch-fetched after the page is materialized.
      // An expand entry may be a CHAIN (`order_id.customer_id`), so the
      // to-one / to-many split reads the HEAD segment. Matching the whole
      // entry would classify every chain as to-one by accident, which happens
      // to be right today (a to-many head cannot be chained) but only by
      // coincidence.
      const isManyHead = (h: string) =>
        collection.fields.find((f) => f.name === h.split(".")[0])?.type === "relation_many";
      const expandOne = q.expand.filter((h) => !isManyHead(h));
      const expandManyHeads = q.expand.filter(isManyHead);
      const {
        extraJoins: expandJoins,
        selects: expandSelects,
        plans: expandPlans,
      } = await resolveExpands(ctx, auth, collection, expandOne, joinMap, q.expandSubs);
      const manyPlans = await resolveManyExpands(
        ctx,
        auth,
        collection,
        expandManyHeads,
        q.expandSubs,
      );
      for (const j of expandJoins) extraJoins.push(j);
      // Sidecar (single-locale) JOINs: surface each localized field for the
      // requested locale + the default-locale fallback. No-op in full-map mode.
      // Pushed into `extraJoins` so `hasJoins` qualifies the base `*` (a bare
      // `SELECT *` alongside the sidecar join would otherwise pull its columns
      // into the row). The `(row_id, locale)` PK keeps the joins 1:1.
      for (const j of buildSidecarJoins(localizedDefs, {
        physicalTable: collection.physicalTable,
        pkColumn: collection.pkColumn,
        locale,
        defaultLocale,
      })) {
        extraJoins.push(j);
      }
      const hasJoins = extraJoins.length > 0;

      // Custom colRef: nested keys route to the join alias; plain fields
      // get qualified to the base table when joins are present (otherwise
      // unqualified `id` / `tenant_id` would be ambiguous against the
      // joined relation target). When there are no joins, default behavior
      // (`sql.identifier(field)`) is preserved.
      const baseTblId = sql.identifier(collection.physicalTable);
      const usesSideTable = usesOwnershipSideTable(collection);
      // Filter/sort on a `localized` field resolves to the already-joined sidecar
      // column for the active locale (with the default-locale COALESCE fallback).
      // Only valid in single-locale mode — that's when the joins exist; otherwise
      // there is no per-locale column to compare, so reject with a 422.
      const localizedColRef = (field: string): SQL => {
        if (!localeSingle) {
          throw new AppError(
            "VALIDATION",
            `Field "${field}" is localized — add ?locale=xx to filter or sort by it`,
          );
        }
        const req = sql`${sql.identifier(I18N_REQ_ALIAS)}.${sql.identifier(field)}`;
        return defaultLocale && defaultLocale !== locale
          ? sql`COALESCE(${req}, ${sql.identifier(I18N_DEF_ALIAS)}.${sql.identifier(field)})`
          : req;
      };
      const nestedColRef: ColRefResolver = (field) => {
        if (!field.includes(".") && localizedNameSet.has(field)) {
          return localizedColRef(field);
        }
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
      // recompile through the join-aware colRef. Dotted relation paths in
      // permission conditions must keep their EXISTS lowering here too —
      // `perm.relationLeaf` (built by resolvePermission) takes precedence
      // over nestedColRef for dotted keys, so a user filter that LEFT JOINs
      // the same relation can't reroute a permission condition through the
      // join alias (whose NULL-extending semantics differ from EXISTS).
      // A localized key keeps the resolver `resolvePermission` built for it —
      // the workspace-default subquery. Routing it through `nestedColRef` here
      // would compile the SAME rule against the REQUESTED locale, so one
      // permission would mean two different things depending on whether the
      // caller named a locale, which is the split this fix exists to end.
      const permColRef: ColRefResolver = (field) =>
        perm.localizedColRef && !field.includes(".") && localizedNameSet.has(field)
          ? perm.localizedColRef(field)
          : nestedColRef(field);
      const permWhere =
        hasJoins && perm.conditions
          ? combineConditions(perm.conditions, auth, permColRef, perm.relationLeaf, {
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
      // Versioned collections: hide drafts from callers without publish/update.
      const canSeeDrafts = await canSeeDraftsFor(ctx, auth, collection, perm);
      const draftWhere = draftFilter(
        collection,
        canSeeDrafts,
        c.req.query("status"),
        hasJoins ? collection.physicalTable : undefined,
      );
      // `?q=` on an FTS-enabled collection: narrow to keyword-index matches
      // (`_fts @@ …` on PG, FTS5 `MATCH` membership on SQLite) instead of the
      // substring LIKE that parseQuery would otherwise have folded into the
      // filter. Ordering still follows the request's `?sort=`/default — true
      // relevance ranking lives on the dedicated `POST /:slug/search` route.
      const searchWhere = q.search
        ? ftsMembershipWhere(collection, q.search, ctx.dialect)
        : null;
      // `?retired=` — opt-in, defaulting to every row. Unrecognised values are
      // refused rather than silently treated as `all`: an operator who typed
      // `retired=excluded` and got the whole table back has been told a filter
      // ran that did not.
      const retiredScope = parseRetiredScope(c.req.query("retired"));
      if (retiredScope === null) {
        throw new AppError("VALIDATION", '`retired` must be "all", "exclude" or "only"');
      }
      const retiredWhere = retiredFilter(
        collection.fields,
        retiredScope,
        ctx.dialect,
        hasJoins ? collection.physicalTable : undefined,
      );
      const wheres = [
        userWhere,
        permWhere,
        tenantWhere,
        deletedWhere,
        draftWhere,
        retiredWhere,
        searchWhere,
      ].filter((x): x is SQL => x != null);
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
      // A to-many expand head needs its raw id-array column SELECTed so the
      // batch step can read the ids — force it into the projection when one is
      // active (`?fields=...`). With no projection every column is already
      // selected, so this is a no-op.
      if (projection) {
        for (const h of expandManyHeads) {
          if (!projection.includes(h)) projection.push(h);
        }
      }
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
      // Localized fields have no base column — drop them from the base SELECT
      // (they'd reference a non-existent column) and materialize them via the
      // sidecar SELECT expressions below. Keep the pk so the row still carries
      // an id even when `?fields=` names only localized fields.
      const baseProjection: string[] | null = projection
        ? (() => {
            const filtered = projection.filter((c) => !localizedNameSet.has(c));
            if (!filtered.includes(collection.pkColumn)) filtered.push(collection.pkColumn);
            // A money field's currency may live in a column the caller did not
            // ask for. Selected here, and here only — the response projection
            // above stays exactly what was requested.
            return withMoneyCurrencyColumns(filtered, collection.fields);
          })()
        : null;
      const projectedLocalizedDefs = projection
        ? localizedDefs.filter((f) => projection.includes(f.name))
        : localizedDefs;
      const localizedSelects = buildLocalizedSelects(projectedLocalizedDefs, ctx.dialect, {
        physicalTable: collection.physicalTable,
        pkColumn: collection.pkColumn,
        locale,
        defaultLocale,
      });
      const baseSelectCols: SQL = baseProjection
        ? hasJoins
          ? buildProjectedWithJoins(baseProjection)
          : sql.join(
              baseProjection.map((col) => selectColRef(collection, col)),
              sql`, `,
            )
        : hasJoins
          ? buildStarWithJoins()
          : selectStar(collection);
      // Append `__expand_<head>` columns when expansions are requested, plus the
      // localized-field expressions. They live alongside the base SELECT and
      // never collide (double-underscore expand aliases; localized fields have
      // no base column).
      const extraSelects = [...expandSelects, ...localizedSelects];
      const selectCols: SQL = extraSelects.length
        ? sql`${baseSelectCols}, ${sql.join(extraSelects, sql`, `)}`
        : baseSelectCols;

      // A sort on a `geo` field orders by distance from the origin the request's
      // own `_near` filter named — parseQuery already refused the sort when
      // there wasn't one, so `planNear` here is reached only with an origin it
      // has already validated once.
      const geoSortPlans = new Map<string, GeoNearPlan>();
      for (const s of q.sort) {
        if (s.field.includes(".")) continue;
        if (geoFieldNames.has(s.field)) {
          const origin = q.nearOrigins.get(s.field);
          if (origin !== undefined) geoSortPlans.set(s.field, planNearOrThrow(s.field, origin));
        }
      }

      // Resolve the SQL column reference for one sort clause. Shared by the
      // ORDER BY and the keyset boundary so they reference the EXACT same
      // expression — a cursor minted against one sort axis must seek on that
      // same axis or it would skip/duplicate rows.
      const sortRefOf = (s: { field: string; dir: "asc" | "desc" }): SQL => {
        // Nested sort routes through the same `rel_<chain>` alias the filter
        // JOINs added (joinMap keyed by full chain prefix; multi-hop sees the
        // deepest alias like `rel_customer_id__address_id`).
        if (s.field.includes(".")) {
          const segs = s.field.split(".");
          const leaf = segs[segs.length - 1]!;
          const chainKey = segs.slice(0, -1).join(".");
          const j = joinMap.get(chainKey);
          return j
            ? sql`${sql.identifier(j.alias)}.${sql.identifier(leaf)}`
            : sql`${sql.identifier(s.field)}`;
        }
        if (localizedNameSet.has(s.field)) {
          return localizedColRef(s.field);
        }
        const physical = rewriteSortField(s.field, collection);
        const col = hasJoins
          ? sql`${baseTblId}.${sql.identifier(physical)}`
          : sql`${sql.identifier(physical)}`;
        // Squared distance — monotonic in distance, so `ASC` really is nearest
        // first, and no square root is needed on either dialect. In cursor mode
        // this same expression is selected as `__ks_i`, so the boundary the
        // next page seeks past is the same number the ORDER BY produced.
        const plan = geoSortPlans.get(s.field);
        if (plan) return geoDistanceSql(col, plan, ctx.dialect);
        return col;
      };

      // Keyset (cursor) pagination is opt-in via `?cursor` (q.cursor !== null).
      // It appends a guaranteed-unique `id` tiebreaker so the ORDER BY is a
      // TOTAL order, then seeks past the previous page's boundary tuple instead
      // of OFFSET-scanning. Classic offset paging is byte-for-byte untouched
      // when `?cursor` is absent (orderClause built from q.sort exactly as
      // before, no tiebreaker, no synthetic columns).
      const cursorMode = q.cursor !== null;
      const pkRef: SQL = hasJoins
        ? sql`${baseTblId}.${sql.identifier(collection.pkColumn)}`
        : sql`${sql.identifier(collection.pkColumn)}`;
      const lastSort = q.sort[q.sort.length - 1];
      const lastIsPk =
        !!lastSort &&
        !lastSort.field.includes(".") &&
        rewriteSortField(lastSort.field, collection) === collection.pkColumn;
      const tieDir: "asc" | "desc" = lastSort?.dir ?? "desc";
      // ksParts mirrors the effective ORDER BY 1:1 (sort clauses, then the pk
      // tiebreaker unless the last sort already IS the pk). Unused in offset
      // mode.
      const ksParts: KeysetPart[] = q.sort.map((s) => ({
        ref: sortRefOf(s),
        dir: s.dir,
      }));
      if (!lastIsPk) ksParts.push({ ref: pkRef, dir: tieDir });

      const orderClause = cursorMode
        ? sql.join(
            ksParts.map((p) => sql`${p.ref} ${sql.raw(p.dir.toUpperCase())}`),
            sql`, `,
          )
        : sql.join(
            q.sort.map(
              (s) => sql`${sortRefOf(s)} ${sql.raw(s.dir.toUpperCase())}`,
            ),
            sql`, `,
          );

      // Seek predicate for an incoming boundary. Empty cursor ("" — first page
      // in cursor mode) has no boundary, so the page starts at the head.
      const keysetBoundary: SQL | null =
        cursorMode && q.cursor
          ? keysetWhere(ksParts, decodeCursor(q.cursor))
          : null;
      // Boundary ANDs into the PAGE query only — the COUNT(*) below still
      // counts the whole filtered set (filter_count must not shrink page by
      // page).
      const pageWhere: SQL = keysetBoundary
        ? wheres.length
          ? sql`WHERE ${sql.join([...wheres, keysetBoundary], sql` AND `)}`
          : sql`WHERE ${keysetBoundary}`
        : whereClause;
      // Surface the boundary tuple under deterministic aliases so next_cursor
      // reads the raw DB values regardless of adopted-table column aliasing.
      const keysetSelects: SQL[] = cursorMode
        ? ksParts.map((p, i) => sql`${p.ref} AS ${sql.identifier(`__ks_${i}`)}`)
        : [];
      const selectColsFinal: SQL = keysetSelects.length
        ? sql`${selectCols}, ${sql.join(keysetSelects, sql`, `)}`
        : selectCols;

      const fromClause: SQL = hasJoins
        ? sql`${fromOf(collection)} ${sql.join(extraJoins, sql` `)}`
        : fromOf(collection);

      // Fire the page query and the optional COUNT(s) concurrently. Each is
      // its own (cross-region) D1 round-trip, so awaiting them in series cost
      // one extra round-trip per requested meta — `?meta=*` was 3 sequential
      // round-trips (data + filter_count + total_count). With Promise.all the
      // COUNT round-trips overlap the data fetch; wall time ≈ the slowest one.
      // Over-fetch one row past the page size: if it comes back, there's a
      // further page (`has_more`) and, in cursor mode, a `next_cursor` — all
      // without a COUNT round-trip. OFFSET is emitted only in classic mode;
      // keyset seeks via the boundary in `pageWhere` instead.
      const fetchLimit = q.limit + 1;
      const rowsPromise = queryAll<Record<string, unknown>>(
        ctx,
        cursorMode
          ? sql`SELECT ${selectColsFinal} FROM ${fromClause} ${pageWhere} ORDER BY ${orderClause} LIMIT ${fetchLimit}`
          : sql`SELECT ${selectColsFinal} FROM ${fromClause} ${whereClause} ORDER BY ${orderClause} LIMIT ${fetchLimit} OFFSET ${q.offset}`,
      );

      type CountRow = { count: number | string | bigint };
      const filterCountPromise: Promise<CountRow[]> | null = q.meta.filterCount
        ? queryAll<CountRow>(
            ctx,
            sql`SELECT COUNT(*) AS count FROM ${fromClause} ${whereClause}`,
          )
        : null;

      let totalCountPromise: Promise<CountRow[]> | null = null;
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
        totalCountPromise = queryAll<CountRow>(
          ctx,
          sql`SELECT COUNT(*) AS count FROM ${fromOf(collection)} ${totalWhere}`,
        );
      }

      const [rows, filterCountRows, totalCountRows] = await Promise.all([
        rowsPromise,
        filterCountPromise,
        totalCountPromise,
      ]);

      let metaOut: { filter_count?: number; total_count?: number } | undefined;
      if (filterCountRows || totalCountRows) {
        metaOut = {};
        if (filterCountRows) metaOut.filter_count = Number(filterCountRows[0]?.count ?? 0);
        if (totalCountRows) metaOut.total_count = Number(totalCountRows[0]?.count ?? 0);
      }

      // The +1 over-fetch row, if present, signals a further page; trim it off
      // the page and (in cursor mode) mint next_cursor from the last KEPT row's
      // boundary tuple before stripping the synthetic `__ks_*` columns.
      const hasMore = rows.length > q.limit;
      const pageRows = hasMore ? rows.slice(0, q.limit) : rows;
      let nextCursor: string | null = null;
      if (cursorMode && hasMore && pageRows.length > 0) {
        const boundary = pageRows[pageRows.length - 1]!;
        nextCursor = encodeCursor(
          ksParts.map((_, i) => boundary[`__ks_${i}`] ?? null),
        );
      }
      if (cursorMode) {
        for (const r of pageRows) {
          for (let i = 0; i < ksParts.length; i++) delete r[`__ks_${i}`];
        }
      }

      // Sensitive-read audit (opt-in per collection). Metadata only: the query
      // shape, result count, and a capped page of returned PK ids — never the
      // row contents. Fires after permission + fetch, so denied reads never log.
      auditRead(c, collection, null, {
        query: {
          filter: c.req.query("filter") ?? null,
          sort: c.req.query("sort") ?? null,
          q: c.req.query("q") ?? null,
          limit: q.limit,
          offset: q.offset,
        },
        count: pageRows.length,
        ids: pageRows.slice(0, 50).map((r) => r[collection.pkColumn] ?? null),
      });
      const data = pageRows.map((r) => {
        const out = deserializeRow(
          r,
          collection.fields,
          ctx.dialect,
          collection.ownerScoped,
          projection,
        );
        // Materialize sidecar (`localized`) fields from the joined / aggregated
        // SELECT values — single native value for `?locale=xx`, full map for `*`.
        applySidecarLocalization(out, r, collection.fields, ctx.dialect, locale);
        // Substitute the raw FK id with the inlined target row. The
        // `__expand_<head>` JSON object was emitted by the SELECT; we
        // parse + camelCase + timestamp-deserialize it here so the
        // wire shape matches `GET /api/items/<target>/<id>`.
        if (expandPlans.length > 0) {
          applyExpandToRow(out, r, expandPlans, ctx.dialect);
        }
        return out;
      });
      // to-many (`relation_many`) expands: one batch fetch per head over the
      // whole page, then each row's id array becomes an array of inlined rows.
      if (manyPlans.length > 0) {
        await applyManyExpandsToRows(ctx, auth, data, manyPlans);
      }
      // Staged-edits: flag rows carrying a pending staged patch for privileged
      // callers (one batched lookup per page). Applied after projection —
      // `_staged` is a system annotation, not a field.
      if (collection.versioned && collection.stagedEdits && canSeeDrafts && pageRows.length > 0) {
        const flagged = await stagedIdsFor(
          ctx,
          collection,
          pageRows.map((r) => String(r[collection.pkColumn])),
        );
        if (flagged.size > 0) {
          pageRows.forEach((r, i) => {
            if (flagged.has(String(r[collection.pkColumn]))) {
              const out = data[i];
              if (out) out._staged = true;
            }
          });
        }
      }
      return c.json({
        data,
        limit: q.limit,
        // Keyset mode replaces offset with next_cursor; offset stays for the
        // classic path so existing clients see the same envelope.
        ...(cursorMode
          ? { has_more: hasMore, next_cursor: nextCursor }
          : { offset: q.offset, has_more: hasMore }),
        ...(metaOut ? { meta: metaOut } : {}),
      });
    },
  )
;
