import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { resolvePermission } from "../../services/permissions";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  loadCollection,
} from "../../services/items/collection-loader";
import {
  ITEMS_AGG_FUNCS,
  runItemsAggregate,
} from "../../services/items/aggregate";
import { searchCollectionItems } from "../../services/items/search";
import {
  ItemRow,
  TAGS,
} from "../../services/items/schemas";
import { auditRead, canSeeDraftsFor } from "./shared";
import { defaultHook } from "../../lib/openapi-router";

export const itemsQueryRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
      const { data, mode, limit } = await searchCollectionItems(ctx, auth, collection, body, {
        permWhere: perm.whereSql,
        permFields: perm.fields,
        canSeeDrafts: await canSeeDraftsFor(ctx, auth, collection, perm),
      });
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
