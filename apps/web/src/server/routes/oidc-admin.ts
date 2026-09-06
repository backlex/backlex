/**
 * Generic OIDC / OAuth2 provider admin CRUD. Admin-only, scoped to the active
 * workspace. Mounted at `/api/admin/oidc`. The generic twin of
 * `routes/saml-admin.ts`: reads never include the client secret (only a
 * presence flag), writes accept plaintext that the service encrypts.
 *
 * Endpoints:
 *   - `GET    /providers`            — list (sanitized)
 *   - `POST   /providers`            — create
 *   - `PATCH  /providers/:id`        — partial update (blank secret = keep)
 *   - `DELETE /providers/:id`        — remove
 *   - `POST   /discover`             — resolve endpoints from a discovery URL
 *                                       so the create form can self-fill
 *
 * After every mutation the cached tenant-auth instance is invalidated so the
 * next `/api/t/:slug/auth/*` request picks the change up.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses, httpUrl } from "../lib/openapi";
import {
  createOidcProvider,
  deleteOidcProvider,
  discoverOidcEndpoints,
  listOidcProviders,
  updateOidcProvider,
} from "../services/oidc-providers";
import { invalidateTenantAuth } from "../services/tenant-auth";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const ProviderView = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    clientId: z.string(),
    /** Presence only — the secret itself has no read-back path. */
    hasClientSecret: z.boolean(),
    discoveryUrl: z.string().nullable(),
    authorizationUrl: z.string().nullable(),
    tokenUrl: z.string().nullable(),
    userInfoUrl: z.string().nullable(),
    scopes: z.array(z.string()),
    pkce: z.boolean(),
    emailClaim: z.string().nullable(),
    groupsClaim: z.string().nullable(),
    defaultRoleId: z.string().nullable(),
    groupsToRoles: z.record(z.string(), z.string()).nullable(),
    linkByVerifiedEmail: z.boolean(),
    enabled: z.boolean(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
    updatedAt: z.union([z.number(), z.date()]).nullable(),
  })
  .openapi("OidcProvider");

const ProviderInput = z
  .object({
    name: z.string().min(1).openapi({ description: "Label on the sign-in button." }),
    slug: z
      .string()
      .min(2)
      .openapi({ description: "URL-safe id; also the better-auth providerId." }),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).openapi({ description: "Encrypted at rest; never returned." }),
    discoveryUrl: httpUrl().nullish().openapi({
      description: "`.well-known/openid-configuration` URL, or the issuer origin.",
    }),
    authorizationUrl: httpUrl().nullish(),
    tokenUrl: httpUrl().nullish(),
    userInfoUrl: httpUrl().nullish(),
    scopes: z.array(z.string().min(1)).optional(),
    pkce: z.boolean().optional(),
    emailClaim: z.string().nullish(),
    groupsClaim: z.string().nullish(),
    defaultRoleId: z.string().nullish(),
    groupsToRoles: z.record(z.string(), z.string()).nullish(),
    linkByVerifiedEmail: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("OidcProviderInput");

/** Every field optional; a blank/absent `clientSecret` keeps the stored one. */
const ProviderPatch = ProviderInput.partial().openapi("OidcProviderPatch");

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

export const oidcAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/providers",
      tags,
      summary: "List OIDC providers",
      description: "Admin-only. Client secrets are never included.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(ProviderView) }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      return c.json({ data: await listOidcProviders(ctx, requireTenant(c)) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/discover",
      tags,
      summary: "Resolve endpoints from a discovery URL",
      description:
        "Admin-only. Fetches `.well-known/openid-configuration` (https only) and returns the " +
        "authorization / token / userinfo endpoints so the create form can fill itself in.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ url: z.string().min(1) }) } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  issuer: z.string().optional(),
                  authorizationUrl: z.string().optional(),
                  tokenUrl: z.string().optional(),
                  userInfoUrl: z.string().optional(),
                  scopesSupported: z.array(z.string()).optional(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      requireTenant(c);
      const ctx = c.get("ctx");
      const { url } = c.req.valid("json");
      return c.json({ data: await discoverOidcEndpoints(ctx.env, url) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers",
      tags,
      summary: "Create an OIDC provider",
      description: "Admin-only. The client secret is encrypted at rest and never readable again.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: ProviderInput } } } },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.object({ data: ProviderView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const data = await createOidcProvider(ctx, tenantId, body, ctx.env.AUTH_SECRET);
      invalidateTenantAuth(tenantId);
      await logActivity(c, {
        action: "create",
        collection: "system_oidc_providers",
        itemId: data.id,
        payload: { slug: data.slug },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/providers/{id}",
      tags,
      summary: "Update an OIDC provider",
      description: "Admin-only. Omit `clientSecret` to keep the stored credential.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: ProviderPatch } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: ProviderView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const data = await updateOidcProvider(ctx, tenantId, id, c.req.valid("json"), ctx.env.AUTH_SECRET);
      invalidateTenantAuth(tenantId);
      await logActivity(c, {
        action: "update",
        collection: "system_oidc_providers",
        itemId: id,
        payload: { slug: data.slug },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/providers/{id}",
      tags,
      summary: "Delete an OIDC provider",
      description: "Admin-only. Existing linked accounts are left in place.",
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
      await deleteOidcProvider(ctx, tenantId, id);
      invalidateTenantAuth(tenantId);
      await logActivity(c, { action: "delete", collection: "system_oidc_providers", itemId: id });
      return c.json({ ok: true });
    },
  );
