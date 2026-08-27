/**
 * SCIM admin config. Admin-only, scoped to the active workspace. Mounted at
 * `/api/admin/scim`. Distinct from `routes/scim.ts`, which is the RFC 7644
 * surface the IdP itself calls with a bearer token.
 *
 *   - `GET    /`         — current config (never the token)
 *   - `POST   /token`    — create or rotate; returns the token EXACTLY once
 *   - `PATCH  /`         — enable/disable, change the default role
 *   - `DELETE /`         — tear the endpoint down
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  deleteScimConfig,
  getScimConfig,
  issueScimToken,
  updateScimConfig,
} from "../services/scim";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";
import { readJsonOr } from "../lib/body";

const ConfigView = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    /** Leading fragment of the token, for telling two apart. Never the token. */
    tokenPrefix: z.string(),
    defaultRoleId: z.string().nullable(),
    lastRequestAt: z.union([z.number(), z.date()]).nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
    updatedAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("ScimConfig");

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

const tags = ["sso"];

export const scimAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "SCIM provisioning config",
      description:
        "Admin-only. `null` when SCIM has never been set up for this workspace. The bearer token " +
        "itself is never returned — only its leading fragment.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: ConfigView.nullable() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      return c.json({ data: await getScimConfig(ctx, requireTenant(c)) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/token",
      tags,
      summary: "Create or rotate the SCIM bearer token",
      description:
        "Admin-only. Returns the token EXACTLY once — it is stored only as a SHA-256 hash, so a " +
        "lost token must be rotated rather than recovered. Rotating invalidates the previous one " +
        "immediately, which will break an IdP still using it until you paste the new value.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                defaultRoleId: z.string().nullish().openapi({
                  description: "Role granted to every SCIM-provisioned user.",
                }),
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
                data: ConfigView,
                token: z.string().openapi({ description: "Shown once. Not recoverable." }),
                /** Where the IdP should point. */
                baseUrl: z.string(),
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
      const body = (await readJsonOr(c.req, {})) as { defaultRoleId?: string | null };
      const { config, token } = await issueScimToken(ctx, tenantId, {
        ...(body.defaultRoleId !== undefined ? { defaultRoleId: body.defaultRoleId } : {}),
      });
      // Deliberately does NOT log the token or any fragment beyond the prefix
      // already stored on the row.
      await logActivity(c, {
        action: "update",
        collection: "system_scim",
        itemId: config.id,
        payload: { rotated: true },
      });
      const base = (ctx.env.APP_URL ?? "").replace(/\/+$/, "");
      return c.json({ data: config, token, baseUrl: `${base}/api/scim/v2` });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/",
      tags,
      summary: "Update the SCIM config",
      description: "Admin-only. Disabling refuses every SCIM request without discarding the token.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                enabled: z.boolean().optional(),
                defaultRoleId: z.string().nullish(),
              }),
            },
          },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: ConfigView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const data = await updateScimConfig(ctx, tenantId, c.req.valid("json"));
      await logActivity(c, { action: "update", collection: "system_scim", itemId: data.id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/",
      tags,
      summary: "Remove the SCIM endpoint",
      description:
        "Admin-only. Drops the token and the config. Users the directory already provisioned are " +
        "left exactly as they are — this stops future syncs, it does not deprovision anyone.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      await deleteScimConfig(ctx, tenantId);
      await logActivity(c, { action: "delete", collection: "system_scim" });
      return c.json({ ok: true });
    },
  );
