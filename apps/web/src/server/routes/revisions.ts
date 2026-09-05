import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { resolvePermission } from "../services/permissions";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { getRevision, listRevisionsForCaller } from "../services/revisions";
import { loadCollection } from "../services/items/collection-loader";
import { performUpdate, type WriteEnv } from "../services/items/write";
import { elapsedMs, requestMeta } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

/*
 * `loadCollection` is the shared one from `services/items/collection-loader`.
 *
 * This file used to carry its own four-field copy — slug, physicalTable,
 * fields, ownerScoped — which was enough for the hand-rolled `UPDATE … WHERE
 * id = ?` the revert once built and not enough for anything else. That local
 * copy is precisely how the revert path drifted away from the write core it
 * should always have been part of: a private loader made the private statement
 * look reasonable.
 */

const collectionFromParam = (c: Context<AppBindings>) =>
  c.req.param("collection" as never) as string;

const _RevisionRow = z
  .object({
    id: z.string(),
    collection: z.string(),
    itemId: z.string(),
    tenantId: z.string().nullable(),
    userId: z.string().nullable(),
    snapshot: z.record(z.string(), z.unknown()),
    createdAt: z.unknown(),
  })
  .openapi("RevisionRow");

export const revisionsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{collection}/{itemId}",
      tags: ["revisions"],
      summary: "List revisions for an item",
      description:
        "Returns every recorded snapshot of `(collection, itemId)`. Requires `read` permission on the target collection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({
          collection: z
            .string()
            .openapi({ description: "Collection slug (e.g. `posts`)." }),
          itemId: z.string(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.any(),
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
      const { collection, itemId } = c.req.valid("param");
      // Same service as the `/api/items/{slug}/{id}/revisions` twin, so the row
      // condition and the field allow-list cannot be applied on one surface and
      // skipped on the other — they were skipped on both.
      const col = await loadCollection(ctx, auth.tenantId, collection);
      const rows = await listRevisionsForCaller(ctx, auth, col, itemId, perm);
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/revert",
      tags: ["revisions"],
      summary: "Revert an item to a recorded revision",
      description:
        "Rewrites the live row in `c_<slug>` from the snapshot and records a new revision documenting the revert. Requires `update` permission on the target collection.",
      security: SECURITY,
      request: {
        params: z.object({
          id: z
            .string()
            .openapi({ description: "Revision row id (NOT the item id)." }),
        }),
      },
      responses: {
        200: {
          description: "Reverted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      if (!auth.userId) {
        throw new AppError("UNAUTHORIZED", "Sign in required");
      }
      const rev = await getRevision(ctx, id, auth.tenantId);
      if (!rev) throw new AppError("NOT_FOUND", "Revision not found");

      // Permission check on the target collection (update).
      // We re-resolve here rather than via middleware, since the target slug
      // is dynamic from the revision row.
      const perm = await resolvePermission(ctx, auth, rev.collection, "update");
      if (!perm.allowed) {
        throw new AppError(
          "FORBIDDEN",
          `No update permission on ${rev.collection}`,
        );
      }

      const collection = await loadCollection(ctx, auth.tenantId, rev.collection);
      const snapshot = rev.snapshot;

      // Routed through `performUpdate` rather than hand-rolled.
      //
      // This used to build its own `UPDATE … SET … WHERE id = ?` from the
      // snapshot, having checked only that the caller holds `update` on the
      // collection AT ALL. It applied neither `perm.whereSql` nor the condition
      // behind it, and named no tenant in the WHERE — so a revision snapshot,
      // which is by definition a `beforeRow`, made every value the column ever
      // held replayable by anyone with the verb. Verified before the fix: an
      // app-plane end-user reverted a row back into the organization an admin
      // had moved it out of, while the identical change through PATCH was 403.
      //
      // A revert is an update. Sending it through the same core is what makes
      // it obey the same rule — and it also picks up the field allow-list, the
      // sync hooks, the FTS and vector reindex, the realtime event and the
      // revision record, none of which the hand-rolled statement did.
      //
      // That last one replaces the explicit `recordRevision` this used to make,
      // and the entry is better: the core records `beforeRow` — the state the
      // row was in JUST BEFORE the revert — so the revert is itself undoable.
      // The old call recorded the snapshot being reverted TO, which was already
      // in the history and made the revert look like it changed nothing.
      //
      // The snapshot is passed as an ordinary patch, so `validateBody` sees it.
      // A snapshot naming a field the schema has since dropped is refused with
      // the same message any other stale payload gets, which is a better answer
      // than writing a column that no longer means what it did.
      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        email: auth.email ?? null,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        orgIds: auth.orgIds ?? [],
        meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
        durationMs: () => elapsedMs(c),
        locale: null,
        readFields: new Set<string>(),
      };
      // Only the fields the collection still has, and only ones the snapshot
      // actually carries — `performUpdate` treats an explicit `undefined` as a
      // clear, which would turn a revert into a wipe of everything the snapshot
      // predates.
      const patch: Record<string, unknown> = {};
      for (const f of collection.fields) {
        if (snapshot[f.name] === undefined) continue;
        patch[f.name] = snapshot[f.name];
      }
      const res = await performUpdate(env, rev.itemId, patch, {
        whereSql: perm.whereSql,
        fields: perm.fields,
        conditions: perm.conditions,
      });
      for (const fx of res.sideEffects) await fx();

      return c.json({ ok: true });
    },
  );
