import type { Handler } from "hono";
import type { AppBindings } from "../app";
import { resolveAuthSurface } from "../services/auth-config";

/**
 * Public, unauthenticated discovery endpoint for a workspace's auth surface —
 * the "auth as a service" entry point a frontend app built on a workeros
 * workspace calls to learn which sign-in providers to render.
 *
 * The active workspace is resolved the usual way (`X-Workeros-Tenant` header /
 * `workeros-tenant` cookie / default workspace). The response carries no
 * secrets: only provider ids, labels, `enabled` flags, and non-secret policy
 * toggles (e.g. whether sign-up is open).
 *
 * Mounted as `GET /api/auth/providers` *before* the better-auth catch-all
 * (`/api/auth/*`) so it isn't swallowed by it.
 */
export const authProvidersHandler: Handler<AppBindings> = async (c) => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const surface = await resolveAuthSurface(
    { db: ctx.db, dialect: ctx.dialect },
    ctx.env,
    auth.tenantId ?? null,
  );
  return c.json({ data: surface });
};
