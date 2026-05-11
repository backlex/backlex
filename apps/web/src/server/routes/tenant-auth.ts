import { Hono } from "hono";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId, getTenantAuth } from "../services/tenant-auth";

/**
 * Workspace end-user auth surface — the "auth as a service" router. Mounted
 * at `/api/t/:slug/auth/*`. Every request resolves the workspace from the
 * URL, fetches that workspace's cached better-auth instance, and forwards
 * the raw Fetch Request to its handler. The instance's internal `basePath`
 * is configured to `/api/t/{slug}/auth` so it routes the URL correctly.
 *
 * No middleware on this surface uses the control-plane session: customer
 * end-users authenticate against the tenant pool via bearer tokens (the
 * better-auth `bearer` plugin), not the platform's session cookie.
 */
export const tenantAuthRoutes = new Hono<AppBindings>().all("/:slug/auth/*", async (c) => {
  const ctx = c.get("ctx");
  const slug = c.req.param("slug");
  const tenant = await findTenantBySlugOrId(
    { db: ctx.db, dialect: ctx.dialect },
    slug,
  );
  if (!tenant) {
    throw new AppError("NOT_FOUND", `Workspace "${slug}" not found`);
  }
  const auth = await getTenantAuth(
    { db: ctx.db, dialect: ctx.dialect },
    ctx.env,
    tenant,
  );
  return auth.handler(c.req.raw);
});
