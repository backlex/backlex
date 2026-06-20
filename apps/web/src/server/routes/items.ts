import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { AppError, type AuthSubject } from "@backlex/core";
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
import { elapsedMs, keepAlive, recordActivity, requestMeta } from "../services/activity";
import { listRevisions, recordRevision } from "../services/revisions";
import {
  embedAndUpsert,
  deleteVector,
  isVectorizable,
  resolveModel,
} from "../services/vectorize";
import { ftsMembershipWhere, ftsRankedIds, isSearchable } from "../services/fts";
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
import {
  ITEMS_AGG_FUNCS,
  runItemsAggregate,
} from "../services/items/aggregate";
import { validateBody, validateRelations } from "../services/items/validate";
import {
  performCreate,
  performUpdate,
  performDelete,
  type WriteEnv,
} from "../services/items/write";
import { runBatch, BATCH_MAX } from "../services/items/batch";
import { toCsv, parseCsv } from "../services/items/csv";
import { localizeRow, mergeI18nPatch } from "../services/items/i18n";
import {
  deletedFilter,
  draftFilter,
  execute,
  fromOf,
  nowFor,
  physicalSystemCol,
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

/**
 * Fire-and-forget sensitive-read audit. No-op unless the collection opted in
 * via `auditReads`. Records an `access.read` activity row with **metadata only**
 * (who / when / ip + query shape, result count, item id(s)) — never the row
 * bodies, which would re-store the very sensitive data the audit exists to
 * protect. Runs inside `keepAlive` (waitUntil) so reads take zero added latency,
 * and `recordActivity` swallows its own errors so a failed insert never fails
 * the read. The `access.` prefix keeps these rows on their own Logs lens +
 * shorter retention (see ACCESS_AUDIT_RETENTION_DAYS in services/scheduler.ts).
 */
const auditRead = (
  c: Context<AppBindings>,
  collection: CollectionRow,
  itemId: string | null,
  payload: Record<string, unknown>,
): void => {
  if (!collection.auditReads) return;
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  keepAlive(
    c,
    recordActivity(
      { db: ctx.db, dialect: ctx.dialect },
      {
        userId: auth.userId,
        tenantId: auth.tenantId ?? null,
        action: "access.read",
        collection: collection.slug,
        itemId,
        ...requestMeta(c.req.raw),
        payload,
        durationMs: elapsedMs(c),
      },
    ),
  );
};

/**
 * Whether the caller may see drafts of a versioned collection. Admins and
 * holders of `publish` or `update` permission on the collection do; everyone
 * else gets published-only reads. Returns false for non-versioned collections
 * (no status filter is applied to them).
 */
const canSeeDraftsFor = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  perm: { isAdmin?: boolean },
): Promise<boolean> => {
  if (!collection.versioned) return false;
  if (perm.isAdmin) return true;
  const dbctx = { db: ctx.db as any, dialect: ctx.dialect };
  if ((await resolvePermission(dbctx, auth, collection.slug, "publish")).allowed) return true;
  return (await resolvePermission(dbctx, auth, collection.slug, "update")).allowed;
};

/** Cap a single import call so a stray multi-MB file can't tie up the worker.
 *  Larger imports should be chunked client-side (or use the batch endpoint). */
const IMPORT_MAX = 5000;

/** System/managed columns that show up in an export but aren't writable user
 *  fields. Stripped on import so an export round-trips cleanly (and a CSV with
 *  an `id` column doesn't 422 every row). Each imported row gets a fresh id. */
const SYSTEM_IMPORT_KEYS = new Set([
  "id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "deletedAt",
  "deleted_at",
  "ownerId",
  "owner_id",
  "tenantId",
  "tenant_id",
  "_status",
  "_published_at",
  "_publish_at",
  "_fts",
]);

const stripSystemColumns = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!SYSTEM_IMPORT_KEYS.has(k)) out[k] = v;
  }
  return out;
};

/**
 * Coerce a CSV row (every cell a string) into the typed shape `performCreate`
 * expects. Empty cells are dropped so column defaults / NULL apply. JSON-ish
 * fields are parsed; numbers/booleans are converted; unknown columns pass
 * through as strings (validation rejects anything the collection doesn't want).
 */
const coerceCsvRow = (
  row: Record<string, string>,
  fields: FieldDef[],
): Record<string, unknown> => {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === "") continue;
    const field = byName.get(key);
    if (!field) {
      // Keep id (adopted-collection PKs) + any extra column as-is.
      out[key] = value;
      continue;
    }
    switch (field.type) {
      case "integer":
      case "number": {
        const n = Number(value);
        out[key] = Number.isNaN(n) ? value : n;
        break;
      }
      case "boolean":
        out[key] = /^(true|1|yes)$/i.test(value);
        break;
      case "json":
      case "relation_many":
      case "i18n_text":
        try {
          out[key] = JSON.parse(value);
        } catch {
          out[key] = value;
        }
        break;
      default:
        out[key] = value;
    }
  }
  return out;
};

const BatchOp = z
  .object({
    op: z.enum(["create", "update", "delete"]),
    id: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("BatchOperation");

const BatchInput = z
  .object({
    operations: z.array(BatchOp).min(1).max(BATCH_MAX),
    atomic: z.boolean().optional(),
  })
  .openapi("BatchInput");

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
        isSearchable(collection),
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
      // Versioned collections: hide drafts from callers without publish/update.
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
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
      const wheres = [userWhere, permWhere, tenantWhere, deletedWhere, draftWhere, searchWhere].filter(
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

      // Fire the page query and the optional COUNT(s) concurrently. Each is
      // its own (cross-region) D1 round-trip, so awaiting them in series cost
      // one extra round-trip per requested meta — `?meta=*` was 3 sequential
      // round-trips (data + filter_count + total_count). With Promise.all the
      // COUNT round-trips overlap the data fetch; wall time ≈ the slowest one.
      const rowsPromise = queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectCols} FROM ${fromClause} ${whereClause} ORDER BY ${orderClause} LIMIT ${q.limit} OFFSET ${q.offset}`,
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

      const locale = c.req.query("locale") ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasI18nField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
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
        count: rows.length,
        ids: rows.slice(0, 50).map((r) => r[collection.pkColumn] ?? null),
      });
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
      method: "post",
      path: "/{slug}/aggregate",
      tags: TAGS,
      summary: "Aggregate items",
      description:
        "Compute count / sum / avg / min / max over a collection, optionally grouped by a column. Returns `[{ value }]` (scalar) or `[{ label, value }, …]` (grouped, ordered by value desc). Respects the caller's read permission (rows AND fields) and tenant scope. Single-table only — no relation traversal.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                agg: z.enum(ITEMS_AGG_FUNCS),
                field: z.string().optional(),
                groupBy: z.string().optional(),
                filter: z.record(z.string(), z.unknown()).optional(),
                limit: z.number().int().positive().max(200).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }),
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
      const { slug } = c.req.valid("param");
      if (!auth.tenantId) {
        throw new AppError("UNAUTHORIZED", "Active tenant required");
      }
      const body = c.req.valid("json");
      const data = await runItemsAggregate(
        ctx,
        auth,
        auth.tenantId,
        { collection: slug, ...body },
        { permWhere: perm.whereSql, allowedFields: perm.fields },
      );
      return c.json({ data });
    },
  )
  /**
   * Relevance search: keyword (full-text), semantic (vector), or `hybrid` —
   * the two fused with Reciprocal Rank Fusion (RRF). Returns whole rows,
   * best-first, with the caller's read permission (rows AND fields), tenant
   * scope, soft-delete, and draft visibility all enforced at hydration — so a
   * vector hit the caller can't see never leaks. `mode` defaults to `hybrid`
   * when both backends are enabled, else whichever single one is.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/search",
      tags: TAGS,
      summary: "Search items (full-text / vector / hybrid)",
      description:
        "Rank a collection's items against a query string. `mode: \"fts\"` uses the keyword index, `\"vector\"` uses semantic embeddings, `\"hybrid\"` fuses both with Reciprocal Rank Fusion. Requires the matching capability to be enabled on the collection (`fts` and/or `vectorize`). Honours read permission, tenant scope, soft-delete, and draft visibility.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                q: z.string().min(1),
                mode: z.enum(["fts", "vector", "hybrid"]).optional(),
                limit: z.number().int().positive().max(100).optional(),
                locale: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(ItemRow),
                mode: z.enum(["fts", "vector", "hybrid"]),
                limit: z.number().int().positive(),
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
      const body = c.req.valid("json");
      const needle = body.q.trim();
      if (!needle) throw new AppError("VALIDATION", "`q` must be non-empty");
      const limit = body.limit ?? 20;

      const ftsOn = isSearchable(collection);
      const vecOn = isVectorizable(collection, ctx.env);

      // Resolve the effective mode, rejecting requests for a backend the
      // collection hasn't enabled so the caller gets a precise 422 instead of
      // a silently-empty result.
      let mode: "fts" | "vector" | "hybrid";
      if (body.mode) {
        if (body.mode === "fts" && !ftsOn) {
          throw new AppError("VALIDATION", `Collection "${collection.slug}" does not have full-text search enabled.`);
        }
        if (body.mode === "vector" && !vecOn) {
          throw new AppError("VALIDATION", `Collection "${collection.slug}" does not have vector search configured.`);
        }
        if (body.mode === "hybrid" && !(ftsOn && vecOn)) {
          throw new AppError("VALIDATION", "Hybrid search needs both full-text search and vector search enabled on this collection.");
        }
        mode = body.mode;
      } else if (ftsOn && vecOn) {
        mode = "hybrid";
      } else if (ftsOn) {
        mode = "fts";
      } else if (vecOn) {
        mode = "vector";
      } else {
        throw new AppError("VALIDATION", `Collection "${collection.slug}" has neither full-text search nor vector search enabled.`);
      }

      // Over-fetch candidates from each backend so that rows dropped by the
      // permission/visibility filters at hydration don't starve the page.
      const pool = Math.min(100, Math.max(limit, 50));
      const wantFts = mode === "fts" || mode === "hybrid";
      const wantVec = mode === "vector" || mode === "hybrid";

      const vectorRankedIds = async (): Promise<string[]> => {
        const model = resolveModel(collection, ctx.env);
        if (!model) return [];
        const { values } = await ctx.embedding.embed({ model, texts: [needle], intent: "query" });
        const matches = await ctx.vector.query(model, {
          values: values[0]!,
          topK: pool,
          namespace: collection.slug,
        });
        return matches.map((m) => m.id);
      };

      const [ftsIds, vecIds] = await Promise.all([
        wantFts ? ftsRankedIds(ctx, collection, needle, pool) : Promise.resolve<string[]>([]),
        wantVec ? vectorRankedIds() : Promise.resolve<string[]>([]),
      ]);

      // Reciprocal Rank Fusion: each list contributes 1/(K + rank) per id, so a
      // row ranked highly by either backend floats up and rows ranked by both
      // win. K=60 is the canonical constant from the original RRF paper.
      const RRF_K = 60;
      const scores = new Map<string, number>();
      const fuse = (ids: string[]) => {
        ids.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
      };
      fuse(ftsIds);
      fuse(vecIds);
      const fusedIds = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id)
        .slice(0, limit);

      if (fusedIds.length === 0) {
        return c.json({ data: [], mode, limit });
      }

      // Hydrate the surviving ids from the physical table with EVERY read
      // filter re-applied — this is what enforces security on vector-sourced
      // ids (the vector store has no permission model). `fromOf`/`selectStar`
      // carry the adopted-collection ownership-join + aliased-column handling.
      const joined = usesOwnershipSideTable(collection);
      const baseTblId = sql.identifier(collection.physicalTable);
      const inList = sql.join(fusedIds.map((id) => sql`${id}`), sql`, `);
      const idWhere = joined
        ? sql`${baseTblId}.${sql.identifier(collection.pkColumn)} IN (${inList})`
        : sql`${sql.identifier(collection.pkColumn)} IN (${inList})`;
      const tenantWhereRaw = tenantFilter(collection, auth);
      const tenantWhere =
        joined && tenantWhereRaw && collection.tenantScoped && auth.tenantId
          ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
          : tenantWhereRaw;
      const deletedWhere = deletedFilter(collection, joined ? collection.physicalTable : undefined);
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        undefined,
        joined ? collection.physicalTable : undefined,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(idWhere, perm.whereSql, tenantWhere, deletedWhere, draftWhere)}`,
      );

      const locale = body.locale ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasI18nField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
      const byId = new Map<string, Record<string, unknown>>();
      for (const r of rows) {
        const projected = projectFields(
          localizeRow(
            deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped),
            collection.fields,
            locale,
            defaultLocale,
          ),
          perm.fields,
        );
        byId.set(String(projected.id), projected);
      }
      // Re-order to the fused ranking — `IN (…)` doesn't preserve order, and
      // hydration may have dropped ids the caller can't see.
      const data = fusedIds.map((id) => byId.get(id)).filter((r): r is Record<string, unknown> => r != null);

      auditRead(c, collection, null, { search: mode, count: data.length });
      return c.json({ data, mode, limit });
    },
  )
  /**
   * Bulk export — streams every row the caller can read as a downloadable JSON
   * array or CSV file. Reuses the exact read-filter stack (permission / tenant /
   * soft-delete / draft) so an export never leaks rows a list call wouldn't.
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/export",
      tags: TAGS,
      summary: "Export collection rows",
      description:
        "Downloads every readable row as a JSON array (`?format=json`, default) or a spreadsheet-friendly CSV (`?format=csv`). Honors permission, tenant, soft-delete and draft visibility.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ format: z.enum(["json", "csv"]).optional() }),
      },
      responses: {
        200: {
          description: "Export file",
          content: { "application/octet-stream": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const format = c.req.query("format") === "csv" ? "csv" : "json";

      const joined = usesOwnershipSideTable(collection);
      const baseTblId = sql.identifier(collection.physicalTable);
      const tenantWhereRaw = tenantFilter(collection, auth);
      const tenantWhere =
        joined && tenantWhereRaw && collection.tenantScoped && auth.tenantId
          ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
          : tenantWhereRaw;
      const deletedWhere = deletedFilter(
        collection,
        joined ? collection.physicalTable : undefined,
      );
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        undefined,
        joined ? collection.physicalTable : undefined,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(perm.whereSql, tenantWhere, deletedWhere, draftWhere)}`,
      );
      const data = rows.map((r) =>
        projectFields(
          deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped),
          perm.fields,
        ),
      );

      auditRead(c, collection, null, { export: format, count: data.length });

      if (format === "csv") {
        // Stable header: id + declared field names, then any extra keys the
        // rows carry (system columns, adopted-table columns).
        const cols: string[] = ["id", ...collection.fields.map((f) => f.name)];
        const seen = new Set(cols);
        for (const row of data) {
          for (const k of Object.keys(row)) {
            if (!seen.has(k)) {
              seen.add(k);
              cols.push(k);
            }
          }
        }
        return new Response(toCsv(data, cols), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${collection.slug}.csv"`,
          },
        });
      }
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${collection.slug}.json"`,
        },
      });
    },
  )
  /**
   * Bulk import — inserts rows from a JSON array or CSV upload, one row per
   * `performCreate` so every row goes through the same validation, permission
   * field-allow-list, relation checks, revisions, events and search/vector
   * indexing as a normal create. Per-row errors are captured, not fatal.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/import",
      tags: TAGS,
      summary: "Import collection rows",
      description:
        "Bulk-inserts rows from a JSON array (`?format=json`, default) or a CSV upload (`?format=csv`). Send the rows as the raw request body (`application/json` array, or `text/csv`). Each row runs through the normal create path; row-level failures are reported in `errors` without aborting the rest.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "create")],
      // No declared body schema on purpose: the import accepts either a JSON
      // array or a raw CSV upload, so the handler reads `c.req.text()` itself
      // rather than letting the OpenAPI JSON validator consume the stream.
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ format: z.enum(["json", "csv"]).optional() }),
      },
      responses: {
        200: {
          description: "Import summary",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  inserted: z.number().int(),
                  failed: z.number().int(),
                  total: z.number().int(),
                  errors: z.array(
                    z.object({ row: z.number().int(), error: z.string() }),
                  ),
                }),
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
      const contentType = c.req.header("content-type") ?? "";
      const format =
        c.req.query("format") === "csv" || contentType.includes("text/csv")
          ? "csv"
          : "json";
      const raw = await c.req.text();

      let records: Record<string, unknown>[];
      if (format === "csv") {
        records = parseCsv(raw).map((r) => coerceCsvRow(r, collection.fields));
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new AppError("VALIDATION", "Import body is not valid JSON.");
        }
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as any).data)
            ? (parsed as any).data
            : null;
        if (!arr) {
          throw new AppError(
            "VALIDATION",
            "JSON import must be an array of rows (or `{ data: [...] }`).",
          );
        }
        records = arr as Record<string, unknown>[];
      }

      if (records.length > IMPORT_MAX) {
        throw new AppError(
          "VALIDATION",
          `Import is limited to ${IMPORT_MAX} rows per call; got ${records.length}.`,
        );
      }

      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: null,
      };

      let inserted = 0;
      const errors: { row: number; error: string }[] = [];
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record || typeof record !== "object") {
          errors.push({ row: i + 1, error: "Row is not an object." });
          continue;
        }
        try {
          const res = await performCreate(env, stripSystemColumns(record), {
            whereSql: perm.whereSql,
            fields: perm.fields,
          });
          for (const fx of res.sideEffects) await fx();
          inserted += 1;
        } catch (e) {
          errors.push({ row: i + 1, error: (e as Error).message.slice(0, 200) });
        }
      }

      return c.json({
        data: {
          inserted,
          failed: errors.length,
          total: records.length,
          errors: errors.slice(0, 50),
        },
      });
    },
  )
  /**
   * Incremental changefeed for offline sync. Returns rows whose `updated_at` is
   * past the `since` cursor — **including soft-deleted tombstones** so a client
   * can converge its local store (apply non-deleted, drop `deleted_at != null`).
   * Keyset-paginated on `(updated_at, id)`; the opaque `cursor` in the response
   * feeds the next call. Requires a collection with `updated_at`.
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/changes",
      tags: TAGS,
      summary: "Incremental changes (offline sync)",
      description:
        "Rows changed since the `since` cursor, including soft-deleted tombstones, keyset-paginated on (updated_at, id). Use the returned `cursor` for the next page.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({
          since: z.string().optional().openapi({ description: "Opaque cursor from a prior response (omit for a full initial sync)." }),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: "Changes",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ItemRow), cursor: z.string().nullable(), hasMore: z.boolean() }),
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
      const updatedCol = physicalSystemCol(collection, "updated_at");
      if (!updatedCol) {
        throw new AppError("VALIDATION", "Collection has no updated_at column — changefeed unavailable");
      }
      const q = c.req.valid("query");
      const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
      // Cursor = base64url("<updatedAtMs>.<id>"). Absent → full sync from epoch.
      let sinceMs = 0;
      let sinceId = "";
      if (q.since) {
        try {
          const dec = Buffer.from(q.since, "base64url").toString("utf8");
          const dot = dec.indexOf(".");
          sinceMs = Number(dec.slice(0, dot));
          sinceId = dec.slice(dot + 1);
          if (!Number.isFinite(sinceMs)) throw new Error("bad");
        } catch {
          throw new AppError("VALIDATION", "Invalid `since` cursor");
        }
      }
      const col = sql`${sql.identifier(updatedCol)}`;
      const pkCol = sql`${sql.identifier(collection.pkColumn)}`;
      // Dual-dialect cursor literal: sqlite stores updated_at as epoch ms; pg as
      // timestamptz (compare against an ISO cast).
      const sinceLit = ctx.dialect === "pg" ? sql`${new Date(sinceMs).toISOString()}::timestamptz` : sql`${sinceMs}`;
      const keyset =
        sinceMs > 0 || sinceId
          ? sql`(${col} > ${sinceLit} OR (${col} = ${sinceLit} AND ${pkCol} > ${sinceId}))`
          : null;
      const tenantWhere = tenantFilter(collection, auth);
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        c.req.query("status"),
      );
      // NOTE: deletedFilter is intentionally omitted — tombstones must flow.
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(keyset, perm.whereSql, tenantWhere, draftWhere)} ORDER BY ${col} ASC, ${pkCol} ASC LIMIT ${limit + 1}`,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      let cursor: string | null = null;
      if (last) {
        const rawUpdated = last[updatedCol];
        const ms = rawUpdated instanceof Date ? rawUpdated.getTime() : Number(rawUpdated);
        cursor = Buffer.from(`${ms}.${String(last[collection.pkColumn])}`, "utf8").toString("base64url");
      }
      const data = page.map((r) => {
        const row = deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped);
        // `deserializeRow` drops `deleted_at`; surface a tombstone marker so a
        // sync client can drop the row from its local store.
        if (r.deleted_at != null) row._deleted = true;
        return row;
      });
      return c.json({ data, cursor, hasMore });
    },
  )
  /** Full revision (change) history for one item — newest first. Read-gated. */
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/{id}/revisions",
      tags: TAGS,
      summary: "List an item's revisions",
      description: "The append-only snapshot history for one row (most recent first).",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: { params: z.object({ slug: z.string(), id: z.string() }) },
      responses: {
        200: { description: "Revisions", content: { "application/json": { schema: z.object({ data: z.any() }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const slug = c.req.param("slug");
      await loadCollection(ctx, auth.tenantId, slug); // 404s unknown collection
      const data = await listRevisions(
        { db: ctx.db, dialect: ctx.dialect },
        slug,
        c.req.param("id"),
        auth.tenantId ?? null,
      );
      return c.json({ data });
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
      // Versioned collections: a draft fetched by id 404s for callers without
      // publish/update permission (the filter excludes it from the result).
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        c.req.query("status"),
        hasJoins ? collection.physicalTable : undefined,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectCols} FROM ${fromClause} ${whereOf(pkWhere, perm.whereSql, tenantWhere, deletedWhere, draftWhere)} LIMIT 1`,
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
      // Sensitive-read audit (opt-in). Records the viewed item id + the field
      // names returned — never the field values themselves.
      auditRead(c, collection, c.req.param("id"), {
        fields: Object.keys(projected),
      });
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
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      };
      const res = await performCreate(env, data, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ data: res.data ?? {} }, 201);
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
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      };
      const res = await performUpdate(env, id, patch, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ data: res.data ?? {} });
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
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: null,
      };
      const res = await performDelete(env, id, {
        whereSql: perm.whereSql,
        fields: perm.fields,
      });
      for (const fx of res.sideEffects) await fx();
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/batch",
      tags: TAGS,
      summary: "Batch write items",
      description:
        "Run many create/update/delete operations on one collection in a single request. Default is partial-success: each op is independent and you get a per-row result. Pass `atomic: true` to run the whole set in one transaction (all-or-nothing) — supported on Postgres (TCP) and self-host SQLite; rejected with 409 on D1 / libSQL / neon-http (HTTP transports). Per-op permissions are resolved by action; `update`/`delete` require `id`. Atomic mode does not support intra-batch read-after-write (an op can't see an earlier op's write in the same batch).",
      security: SECURITY,
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: { required: true, content: { "application/json": { schema: BatchInput } } },
      },
      responses: {
        200: {
          description: "Batch result",
          content: { "application/json": { schema: z.object({ data: z.any() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const body = c.req.valid("json");
      const result = await runBatch({
        ctx,
        auth,
        collection,
        operations: body.operations,
        atomic: body.atomic === true,
        meta: requestMeta(c.req.raw),
        durationMs: () => elapsedMs(c),
        locale: c.req.query("locale") ?? null,
      });
      return c.json({ data: result });
    },
  )
  /**
   * Publish / unpublish / schedule a versioned-collection row. Requires the
   * caller to have the `publish` permission on the collection.
   *
   * - default → publish now (`_status='published'`, `_published_at=now`).
   * - `?unpublish=1` → revert to draft (clears `_published_at` + `_publish_at`).
   * - body `{ publishAt: <future ISO> }` → schedule: stay draft, set
   *   `_publish_at`; the cron tick flips it to published when due.
   * - body `{ publishAt: null }` → cancel a pending schedule (stay draft).
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/{id}/publish",
      tags: TAGS,
      summary: "Publish, unpublish, or schedule a versioned item",
      description:
        "Versioned-collection only. Publishes now by default; `?unpublish=1` reverts to draft; body `{ publishAt }` (future ISO) schedules a publish that the cron tick applies when due, `{ publishAt: null }` cancels it.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "publish")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({ unpublish: z.enum(["1"]).optional() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({ publishAt: z.string().datetime().nullable().optional() }),
            },
          },
        },
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
      const body = (await c.req.json().catch(() => ({}))) as { publishAt?: string | null };
      const now = nowFor(ctx.dialect);
      const tsOf = (d: Date): Date | number => (ctx.dialect === "pg" ? d : d.getTime());

      // Decide the operation: unpublish > schedule (future publishAt) > publish-now.
      const scheduleAt =
        body.publishAt && new Date(body.publishAt).getTime() > Date.now()
          ? new Date(body.publishAt)
          : null;
      let event: "published" | "unpublished" | "scheduled";
      let setSql: SQL;
      if (unpublish) {
        event = "unpublished";
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      } else if (scheduleAt) {
        event = "scheduled";
        setSql = sql`${sql.identifier("_status")} = 'draft', ${sql.identifier("_published_at")} = NULL, ${sql.identifier("_publish_at")} = ${tsOf(scheduleAt)}, ${sql.identifier("updated_at")} = ${now}`;
      } else {
        event = "published";
        setSql = sql`${sql.identifier("_status")} = 'published', ${sql.identifier("_published_at")} = ${now}, ${sql.identifier("_publish_at")} = NULL, ${sql.identifier("updated_at")} = ${now}`;
      }
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
        { event, data: after },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
      );
      return c.json({ data: after });
    },
  );
