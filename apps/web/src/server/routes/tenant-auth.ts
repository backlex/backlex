import { Hono, type Context } from "hono";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId, getTenantAuth } from "../services/tenant-auth";
import { resolveAuthSurface } from "../services/auth-config";

/**
 * Workspace end-user auth surface — the "auth as a service" router. Mounted
 * at `/api/t/:slug/auth/*`.
 *
 *   - `GET /api/t/:slug/auth/providers` — public, unauthenticated discovery:
 *     which sign-in providers + policy flags the workspace's app should
 *     render. No secrets. (Registered before the catch-all so it isn't
 *     swallowed by the better-auth handler.)
 *   - everything else under `/api/t/:slug/auth/*` is delegated to that
 *     workspace's cached better-auth instance, whose internal `basePath` is
 *     `/api/t/{slug}/auth` so the URL routes correctly.
 *
 * No middleware here uses the control-plane session: customer end-users
 * authenticate against the tenant pool via bearer tokens (the better-auth
 * `bearer` plugin), not the platform's session cookie.
 */
const resolveTenant = async (c: Context<AppBindings>) => {
  const ctx = c.get("ctx");
  const slug = c.req.param("slug");
  const tenant = slug
    ? await findTenantBySlugOrId({ db: ctx.db, dialect: ctx.dialect }, slug)
    : null;
  if (!tenant) throw new AppError("NOT_FOUND", `Workspace "${slug ?? ""}" not found`);
  return { ctx, tenant };
};

export const tenantAuthRoutes = new Hono<AppBindings>()
  .get("/:slug/auth/providers", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const surface = await resolveAuthSurface(
      { db: ctx.db, dialect: ctx.dialect },
      ctx.env,
      tenant.id,
    );
    return c.json({ data: surface });
  })
  .all("/:slug/auth/*", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const auth = await getTenantAuth(
      { db: ctx.db, dialect: ctx.dialect },
      ctx.env,
      ctx.email,
      tenant,
    );
    return auth.handler(c.req.raw);
  });
