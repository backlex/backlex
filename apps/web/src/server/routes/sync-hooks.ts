/**
 * Sync hook admin CRUD. Admin-only, scoped to the active workspace. Mounted at
 * `/api/admin/sync-hooks`.
 *
 * The workspace is taken from the session and passed to a service whose
 * `tenantId` parameter is a required `string`. That is deliberate: a
 * `tenant_id = NULL` hook is INSTANCE-WIDE and receives the pending row data of
 * every workspace on the instance, so an API caller must have no way to express
 * one. Making it unrepresentable beats a check somebody can forget.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  MAX_HOOK_TIMEOUT_MS,
  createSyncHook,
  deleteSyncHook,
  listSyncHooks,
  testSyncHook,
  updateSyncHook,
} from "../services/sync-hooks";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const HookView = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    headers: z.record(z.string(), z.string()).nullable(),
    timeoutMs: z.number(),
    onError: z.enum(["allow", "deny"]),
    canMutate: z.boolean(),
    priority: z.number(),
    enabled: z.boolean(),
    /** Presence only — the signing secret has no read-back path. */
    hasSecret: z.boolean(),
    consecutiveFailures: z.number(),
    lastFailureAt: z.union([z.number(), z.date()]).nullable(),
    disabledReason: z.string().nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
    updatedAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("SyncHook");

const HookInput = z
  .object({
    name: z.string().min(1),
    url: z.string().url().openapi({ description: "Your service. Receives a POST per matching write." }),
    events: z
      .array(z.string().min(1))
      .min(1)
      .openapi({
        description:
          "`<collection>.beforeCreate|beforeUpdate|beforeDelete`, or `<collection>.*` / `*.<phase>` / `*`.",
      }),
    onError: z.enum(["allow", "deny"]).openapi({
      description:
        "Required — there is no safe default. `allow` silently drops the guarantee the hook provides; " +
        "`deny` turns your app's outage into your customers'.",
    }),
    secret: z.string().min(1).nullish().openapi({
      description: "HMAC signing secret. Write-only; omit on update to keep the stored one.",
    }),
    headers: z.record(z.string(), z.string()).nullish(),
    timeoutMs: z.number().int().min(50).max(MAX_HOOK_TIMEOUT_MS).optional(),
    canMutate: z.boolean().optional().openapi({
      description: "Whether this hook's `data` patch is applied. Off unless asked for.",
    }),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("SyncHookInput");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["sync-hooks"];

export const syncHooksRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List sync hooks",
      description: "Admin-only. Signing secrets are never included.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(HookView) }) } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listSyncHooks(c.get("ctx"), requireTenant(c)) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create a sync hook",
      description:
        "Admin-only. The hook runs on the write path: it can reject a write, and (with `canMutate`) " +
        "patch the payload. Scoped to the active workspace — an instance-wide hook cannot be created " +
        "through this API.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: HookInput } } } },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.object({ data: HookView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const data = await createSyncHook(ctx, tenantId, c.req.valid("json"));
      await logActivity(c, {
        action: "create",
        collection: "system_sync_hooks",
        itemId: data.id,
        payload: { name: data.name, events: data.events, onError: data.onError },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update a sync hook",
      description:
        "Admin-only. Omit `secret` to keep the stored one. Re-enabling clears the failure counter, " +
        "or the breaker would trip again immediately.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: HookInput.partial() } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: HookView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const data = await updateSyncHook(ctx, tenantId, id, c.req.valid("json"));
      await logActivity(c, { action: "update", collection: "system_sync_hooks", itemId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete a sync hook",
      description: "Admin-only. Writes stop being gated by it immediately.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await deleteSyncHook(ctx, tenantId, id);
      await logActivity(c, { action: "delete", collection: "system_sync_hooks", itemId: id });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/test",
      tags,
      summary: "Send a test call",
      description:
        "Admin-only. Fires one synthetic `__test__.beforeCreate` payload and reports the verdict, " +
        "so a misconfigured hook is found here rather than by a blocked write in production. " +
        "Does not touch the failure counter.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                ms: z.number(),
                error: z.string().optional(),
                verdict: z
                  .object({
                    allow: z.boolean(),
                    reason: z.string().optional(),
                    data: z.record(z.string(), z.unknown()).optional(),
                  })
                  .optional(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      return c.json(await testSyncHook(ctx, tenantId, id));
    },
  );
