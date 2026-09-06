import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  loadCollection,
} from "../../services/items/collection-loader";
import { runChangefeed } from "../../services/items/changefeed";
import {
  ItemRow,
  TAGS,
} from "../../services/items/schemas";
import { canSeeDraftsFor } from "../../services/items/row-access";
import { defaultHook } from "../../lib/openapi-router";
import { auditRead } from "./shared";

export const itemsChangesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/changes",
      tags: TAGS,
      summary: "Incremental changes (offline sync)",
      description:
        "Rows changed since the `since` cursor, including soft-deleted tombstones, keyset-paginated on (updated_at, id). Use the returned `cursor` for the next page. Pass `shape` (a flat filter, same JSON grammar as `filter`) to replicate only a subset: matching rows come back in full, and a row that *stopped* matching comes back as `{ id, _shape_exit: true }` so the client can drop it. Shapes can't span relations.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({
          since: z.string().optional().openapi({ description: "Opaque cursor from a prior response (omit for a full initial sync)." }),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          shape: z.string().optional().openapi({ description: "JSON filter naming the subset to replicate. Flat fields only — no relation hops." }),
          fields: z.string().optional().openapi({ description: "Comma-separated projection. `id` and `updated_at` are always included." }),
        }),
      },
      responses: {
        200: {
          description: "Changes",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(ItemRow),
                cursor: z.string().nullable(),
                hasMore: z.boolean(),
                shape: z.string().optional().openapi({ description: "Stable key for the shape these changes were computed against; a client re-syncs from scratch when it changes." }),
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
      const q = c.req.valid("query");
      const page = await runChangefeed({
        ctx,
        auth,
        collection,
        perm,
        canSeeDrafts: await canSeeDraftsFor(ctx, auth, collection, perm),
        since: q.since,
        limit: q.limit,
        shape: q.shape,
        fields: q.fields,
        status: c.req.query("status"),
      });
      // The changefeed returns WHOLE ROWS and is cursor-paginated, so it pages
      // an `auditReads` collection end to end while the compliance log shows
      // nothing was read. Measured: `GET /api/items/patients/<id>` wrote an
      // `access.read` row and `GET /api/items/patients/changes` — which handed
      // back the same row's body — wrote none.
      auditRead(c, collection, null, { changes: page.data.length, since: q.since ?? null });
      return c.json(page);
    },
  )
  /** Full revision (change) history for one item — newest first. Read-gated. */
;
