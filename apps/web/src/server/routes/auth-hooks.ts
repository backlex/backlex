/**
 * Auth hook admin CRUD. Admin-only, scoped to the active workspace. Mounted at
 * `/api/admin/auth-hooks`.
 *
 * The workspace comes from the session and the service's `tenantId` parameter
 * is a required `string`, so there is no way to express a hook that is not
 * bound to one workspace — the same "make it unrepresentable" posture the sync
 * hook routes take, and here the table has no nullable `tenant_id` at all.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  AUTH_HOOK_EVENTS,
  MAX_AUTH_HOOK_TIMEOUT_MS,
  createAuthHook,
  deleteAuthHook,
  listAuthHooks,
  testAuthHook,
  updateAuthHook,
} from "../services/auth-hooks";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const EventEnum = z.enum(AUTH_HOOK_EVENTS);

const HookView = z
  .object({
    id: z.string(),
    event: EventEnum,
    targetType: z.enum(["url", "function"]),
    url: z.string().nullable(),
    functionName: z.string().nullable(),
    headers: z.record(z.string(), z.string()).nullable(),
    timeoutMs: z.number(),
    onError: z.enum(["allow", "deny"]),
    enabled: z.boolean(),
    /** Presence only — the signing secret has no read-back path. */
    hasSecret: z.boolean(),
    consecutiveFailures: z.number(),
    lastFailureAt: z.union([z.number(), z.date()]).nullable(),
    disabledReason: z.string().nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
    updatedAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("AuthHook");

const HookInput = z
  .object({
    event: EventEnum.openapi({
      description:
        "Which moment to hook. One hook per event per workspace: each carries a different " +
        "payload and verdict, and two answering `custom-access-token` would fight over the same claim.",
    }),
    targetType: z.enum(["url", "function"]).openapi({
      description:
        "`url` — an HTTPS endpoint, called with Standard Webhooks headers. `function` — a backlex " +
        "function run in the sandbox, with no network hop.",
    }),
    url: z.string().url().nullish().openapi({ description: "Required when `targetType` is `url`." }),
    functionName: z.string().min(1).nullish().openapi({
      description: "Required when `targetType` is `function`. The function must already exist.",
    }),
    onError: z.enum(["allow", "deny"]).openapi({
      description:
        "Required — there is no safe default. `deny` fails the auth action when the hook cannot " +
        "answer; `allow` proceeds without it, which for `custom-access-token` means minting a token " +
        "MISSING the claim your authorizer reads.",
    }),
    secret: z.string().min(1).nullish().openapi({
      description:
        "Standard Webhooks signing secret (`whsec_<base64>`). Write-only; omit on update to keep the stored one.",
    }),
    headers: z.record(z.string(), z.string()).nullish(),
    timeoutMs: z.number().int().min(50).max(MAX_AUTH_HOOK_TIMEOUT_MS).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("AuthHookInput");

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

const tags = ["auth-hooks"];

export const authHooksRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List auth hooks",
      description: "Admin-only. Signing secrets are never included.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(HookView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listAuthHooks(c.get("ctx"), requireTenant(c)) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create an auth hook",
      description:
        "Admin-only. Hooks fire for this workspace's END-USER auth plane (`/api/t/<slug>/auth/*`) — " +
        "never for the platform operators who administer backlex itself.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: HookInput } } } },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: HookView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const data = await createAuthHook(ctx, tenantId, c.req.valid("json"));
      await logActivity(c, {
        action: "create",
        collection: "system_auth_hooks",
        itemId: data.id,
        payload: { event: data.event, targetType: data.targetType, onError: data.onError },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update an auth hook",
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
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: HookView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const data = await updateAuthHook(ctx, tenantId, id, c.req.valid("json"));
      await logActivity(c, { action: "update", collection: "system_auth_hooks", itemId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete an auth hook",
      description: "Admin-only. The moment it hooked stops consulting it immediately.",
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
      await deleteAuthHook(ctx, tenantId, id);
      await logActivity(c, { action: "delete", collection: "system_auth_hooks", itemId: id });
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
        "Admin-only. Fires one representative payload for this hook's event and reports the verdict, " +
        "so a misconfigured hook is found here rather than by a blocked sign-in in production. For " +
        "`custom-access-token` it also reports which returned claims WOULD be dropped as reserved. " +
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
                droppedClaims: z.array(z.string()).optional(),
                verdict: z
                  .object({
                    allow: z.boolean().optional(),
                    reason: z.string().optional(),
                    claims: z.record(z.string(), z.unknown()).optional(),
                    handled: z.boolean().optional(),
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
      return c.json(await testAuthHook(ctx, tenantId, id));
    },
  );
