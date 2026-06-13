import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppBindings } from "../app";
import { errorResponses } from "../lib/openapi";
import { resolvePlatformAuthSurface } from "../services/auth-config";

/**
 * Public, unauthenticated discovery endpoint for a workspace's auth surface —
 * the "auth as a service" entry point a frontend app built on a backlex
 * workspace calls to learn which sign-in providers to render.
 *
 * The active workspace is resolved the usual way (`X-Backlex-Tenant` header /
 * `backlex-tenant` cookie / default workspace). The response carries no
 * secrets: only provider ids, labels, `enabled` flags, and non-secret policy
 * toggles (e.g. whether sign-up is open).
 *
 * Mounted at `/api/auth/providers` *before* the better-auth catch-all
 * (`/api/auth/*`) so it isn't swallowed by it.
 */

const AuthProvider = z
  .object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
  })
  .passthrough()
  .openapi("AuthProvider");

const AuthSurface = z
  .object({
    providers: z.array(AuthProvider),
    policy: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .openapi("AuthSurface");

export const authPublicRoutes = new OpenAPIHono<AppBindings>().openapi(
  createRoute({
    method: "get",
    path: "/providers",
    tags: ["auth-public"],
    summary: "Public auth surface",
    description:
      "Unauthenticated discovery endpoint — returns the active workspace's sign-in providers and non-secret policy flags. The workspace is resolved from `X-Backlex-Tenant` / cookie / default.",
    security: [],
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ data: AuthSurface }) } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    // Control-plane surface: email/password (+passkey/magic/otp) with social
    // excluded, plus instance-global platform SAML/LDAP SSO (gated by
    // PLATFORM_SSO_ENABLED). Consumer social login lives on the workspace
    // end-user surface (`/api/t/<slug>/auth/providers`).
    const surface = await resolvePlatformAuthSurface(
      { db: ctx.db, dialect: ctx.dialect },
      ctx.env,
      auth.tenantId ?? null,
    );
    return c.json({ data: surface });
  },
);
