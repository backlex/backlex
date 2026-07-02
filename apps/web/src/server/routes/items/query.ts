import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { resolvePermission } from "../../services/permissions";
import {
  isVectorizable,
  resolveModel,
} from "../../services/vectorize";
import { ftsRankedIds, isSearchable } from "../../services/fts";
import { loadAppSettings } from "../../services/settings";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  hasI18nField,
  loadCollection,
} from "../../services/items/collection-loader";
import {
  deserializeRow,
  projectFields,
} from "../../services/items/serialize";
import {
  ITEMS_AGG_FUNCS,
  runItemsAggregate,
} from "../../services/items/aggregate";
import { localizeRow, } from "../../services/items/i18n";
import {
  deletedFilter,
  draftFilter,
  fromOf,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "../../services/items/sql-helpers";
import {
  ItemRow,
  TAGS,
} from "../../services/items/schemas";
import { auditRead, canSeeDraftsFor } from "./shared";

export const itemsQueryRoutes = new OpenAPIHono<AppBindings>()
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
      // Match list/get/search visibility: always hide soft-deleted rows, and
      // hide drafts unless the caller can see them (admin or holds publish/
      // update). Without this, a non-privileged caller could use COUNT/MIN/MAX
      // as an oracle over rows they can't read.
      const canSeeDrafts =
        Boolean(perm.isAdmin) ||
        (await resolvePermission(ctx, auth, slug, "publish")).allowed ||
        (await resolvePermission(ctx, auth, slug, "update")).allowed;
      const data = await runItemsAggregate(
        ctx,
        auth,
        auth.tenantId,
        { collection: slug, ...body },
        {
          permWhere: perm.whereSql,
          allowedFields: perm.fields,
          excludeSoftDeleted: true,
          excludeDrafts: !canSeeDrafts,
        },
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
;
