import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId } from "../services/tenant-auth";

/**
 * The signed-in workspace END-USER, pinned to the workspace named in the path.
 *
 * WHY IT IS A MIDDLEWARE
 *
 * This check existed, byte-for-byte identical, as a local
 * `const requireAppUser = async (c) => …` in BOTH `routes/app-orgs-public.ts`
 * and `routes/app-agents-public.ts`, called from every handler body. The routes
 * were protected; the protection was invisible to anything reading Hono's
 * `app.routes`, which is how twenty `/api/t/:slug/*` entries showed up in the
 * ungated sweep in #345 — and invisible is exactly how the 2026-09 audit's
 * largest cluster happened, where five route groups used the wrong gate while
 * the correct rule sat written down in another file.
 *
 * Mounted per route rather than on a wildcard, deliberately. One route in
 * `app-orgs-public.ts` — `GET /:slug/orgs/invites/:token` — runs before its
 * visitor has any session at all, and a wildcard mount would need an exemption
 * list to spare it. An exemption list is the thing this repo has twice found
 * laundering defects; naming the gate on each route that wants it says the same
 * thing with no ledger to go stale.
 *
 * NAMED FUNCTION EXPRESSION, not a const arrow. Measured under Bun: a const
 * arrow declared inside a function comes out as `""` in `app.routes`, so a
 * registry keyed on names would fail silent. Same rule `requirePermissionMw`
 * follows — see `middleware/permission.ts`.
 *
 * WHAT IT CHECKS
 *
 * The identity must be app-plane (a control-plane admin session is deliberately
 * NOT accepted here; admins use the `/api/app-orgs` twin behind an admin gate),
 * and the workspace in the path must be the one the session is bound to — the
 * session already carries its own tenant, so a mismatched slug means the caller
 * is pointing a token at the wrong workspace.
 */
export const requireAppUserMw: MiddlewareHandler<AppBindings> =
  async function requireAppUserMw(c, next) {
    c.set("appUser", await resolveAppUser(c as Context<AppBindings>));
    await next();
  };

/** The check itself. Separate so the reader below can fall back to it. */
const resolveAppUser = async (
  c: Context<AppBindings>,
): Promise<{ tenantId: string; appUserId: string }> => {
  const auth = c.get("auth");
  if (auth.plane !== "app" || !auth.userId)
    throw new AppError("UNAUTHORIZED", "Workspace end-user sign-in required");
  const tenantId = auth.tenantId;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Session is not bound to a workspace");

  const ctx = c.get("ctx");
  const slug = c.req.param("slug");
  const tenant = slug
    ? await findTenantBySlugOrId({ db: ctx.db, dialect: ctx.dialect }, slug)
    : null;
  if (!tenant) throw new AppError("NOT_FOUND", `Workspace "${slug ?? ""}" not found`);
  if (tenant.id !== tenantId)
    throw new AppError("FORBIDDEN", "Session belongs to a different workspace");
  return { tenantId, appUserId: auth.userId };
};

/**
 * What {@link requireAppUserMw} resolved, for the handler behind it.
 *
 * Falls back to running the check itself when the value is absent. That is not
 * belt-and-braces for its own sake: it is what makes moving the gate to the
 * router SAFE to do incrementally. A handler that keeps calling this is correct
 * whether or not its route got the middleware, so a route missed during the
 * move loses visibility — not its gate. The `await` costs one cached tenant
 * lookup on the mounted path and nothing on the second call.
 */
export const appUserOf = async (
  c: Context<AppBindings>,
): Promise<{ tenantId: string; appUserId: string }> =>
  c.get("appUser") ?? (await resolveAppUser(c));
