import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { elapsedMs, requestMeta } from "../../services/activity";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  loadCollection,
} from "../../services/items/collection-loader";
import { runBatch, BATCH_MAX } from "../../services/items/batch";
import { runBulkUpdate, BULK_UPDATE_MAX } from "../../services/items/bulk";
import {
  TAGS,
} from "../../services/items/schemas";


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

const BulkUpdateInput = z
  .object({
    keys: z.array(z.string()).min(1).max(BULK_UPDATE_MAX),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("BulkUpdateInput");

export const itemsBatchRoutes = new OpenAPIHono<AppBindings>()
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
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/bulk-update",
      tags: TAGS,
      summary: "Bulk-update items",
      description:
        "Apply ONE shared patch to a list of selected item ids. Only the named fields change on each row; everything else is left untouched. Partial-success: a key the caller can't write (row-scope / tenant filtered) is reported per-row and counted in `failed`, the rest still commit. The shared `data` is validated once up front (a bad payload is a single 422). `json` / `file` / `relation_many` fields are rejected for bulk — edit them per record. Up to " +
        String(BULK_UPDATE_MAX) +
        " keys per call.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ locale: z.string().optional() }),
        body: { required: true, content: { "application/json": { schema: BulkUpdateInput } } },
      },
      responses: {
        200: {
          description: "Bulk-update result",
          content: { "application/json": { schema: z.object({ data: z.any() }) } },
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
      const result = await runBulkUpdate({
        ctx,
        auth,
        collection,
        keys: body.keys,
        data: body.data,
        perm: { whereSql: perm.whereSql, fields: perm.fields },
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
;
