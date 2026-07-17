import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  deleteFlag,
  evaluateFlags,
  listFlags,
  upsertFlag,
} from "../services/feature-flags";

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

/** Scope: `?scope=global` targets the `tenantId IS NULL` default row; otherwise
 *  the caller's active workspace. */
const scopeTenant = (c: { get: (k: string) => any; req: { query: (k: string) => string | undefined } }): string | null => {
  if (c.req.query("scope") === "global") return null;
  const tid = c.get("auth")?.tenantId as string | undefined;
  if (!tid) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tid;
};

const RulesSchema = z
  .object({
    condition: z.unknown().optional(),
    rollout: z.number().int().min(0).max(100).optional(),
  })
  .nullable();

const FlagInput = z
  .object({
    enabled: z.boolean().optional(),
    value: z.unknown().optional(),
    rules: RulesSchema.optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("FeatureFlagInput");

const tags = ["feature-flags"];

/** Public, caller-scoped flag evaluation — what client apps read. */
export const flagsPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "get",
    path: "/",
    tags,
    summary: "Evaluate feature flags for the caller",
    description:
      "Returns `{ data: { <key>: { enabled, value } } }` with each flag resolved against the caller's targeting rules (condition + rollout).",
    security: SECURITY,
    responses: {
      200: {
        description: "Evaluated flags",
        content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.object({ enabled: z.boolean(), value: z.unknown() })) }) } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const data = await evaluateFlags(ctx, auth);
    return c.json({ data });
  },
);

/** Admin CRUD for flag definitions. */
export const flagsAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List feature flags",
      description: "Flag definitions visible to the active workspace (global defaults + per-tenant overrides).",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "Flags", content: { "application/json": { schema: z.object({ data: z.any() }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth")?.tenantId ?? null;
      const data = await listFlags(ctx, tenantId);
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/{key}",
      tags,
      summary: "Create or update a feature flag",
      description: "Upserts the flag for the active workspace, or the global default with `?scope=global`.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string().min(1).max(128) }),
        query: z.object({ scope: z.enum(["global"]).optional() }),
        body: { required: true, content: { "application/json": { schema: FlagInput } } },
      },
      responses: {
        200: { description: "Saved", content: { "application/json": { schema: z.object({ data: z.any() }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = scopeTenant(c);
      const key = c.req.valid("param").key;
      const body = c.req.valid("json");
      const data = await upsertFlag(ctx, {
        tenantId,
        key,
        enabled: body.enabled,
        value: body.value,
        rules: body.rules as { condition?: any; rollout?: number } | null | undefined,
        description: body.description,
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{key}",
      tags,
      summary: "Delete a feature flag",
      description: "Removes the flag for the active workspace, or the global default with `?scope=global`.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string() }),
        query: z.object({ scope: z.enum(["global"]).optional() }),
      },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = scopeTenant(c);
      await deleteFlag(ctx, tenantId, c.req.valid("param").key);
      return c.json({ ok: true });
    },
  );
