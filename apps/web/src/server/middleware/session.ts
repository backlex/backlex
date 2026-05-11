import type { MiddlewareHandler } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { findApiKey, touchLastUsed } from "../services/api-keys";

const extractIp = (req: Request): string | null => {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
};

const stampSessionMeta = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  sessionId: string,
  req: Request,
): Promise<void> => {
  const t = ctx.dialect === "pg" ? pg.schema.sessions : sqlite.schema.sessions;
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  // Only patch when the existing row is missing data — keeps writes off the
  // hot path for repeat requests in the same session.
  const set: Record<string, unknown> = {};
  if (ip) set.ipAddress = ip;
  if (ua) set.userAgent = ua;
  if (Object.keys(set).length === 0) return;
  try {
    await (ctx.db as any)
      .update(t)
      .set(set)
      .where(
        and(
          eq(t.id, sessionId),
          // Only fill empties — don't churn rows with the same value.
          ip ? isNull(t.ipAddress) : eq(t.id, sessionId),
        ),
      );
  } catch {
    // best-effort
  }
};

const loadRoleNames = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  userId: string,
  restrictRoleId: string | null,
): Promise<string[]> => {
  // Role names are loaded without a tenant filter here because the tenant
  // hasn't been resolved yet at this point in the pipeline. The downstream
  // permission resolver re-loads roles scoped to the active tenant; this
  // list is only used by the legacy `auth.roles` array, which the admin
  // routes filter by tenant themselves.
  //
  // When the request authenticated with a role-scoped API key, restrict to
  // that single role (still gated on the owner actually holding it) so the
  // narrowing is in effect from the very first middleware.
  const t =
    ctx.dialect === "pg"
      ? { roles: pg.schema.roles, userRoles: pg.schema.userRoles }
      : { roles: sqlite.schema.roles, userRoles: sqlite.schema.userRoles };
  const rows = (await (ctx.db as any)
    .select({ name: t.roles.name })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(
      restrictRoleId
        ? and(eq(t.userRoles.userId, userId), eq(t.roles.id, restrictRoleId))
        : eq(t.userRoles.userId, userId),
    )) as { name: string }[];
  return rows.map((r) => r.name);
};

const loadUserEmail = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  userId: string,
): Promise<string | null> => {
  const t = ctx.dialect === "pg" ? pg.schema.users : sqlite.schema.users;
  const rows = (await (ctx.db as any)
    .select({ email: t.email })
    .from(t)
    .where(eq(t.id, userId))
    .limit(1)) as { email: string }[];
  return rows[0]?.email ?? null;
};

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");

  let userId: string | null = null;
  let email: string | null = null;
  // When a request authenticates with an API key, the key carries the tenant
  // it was issued for. Surface it so tenantMiddleware can pin the request to
  // that workspace — header/cookie/user-pref resolution would otherwise miss
  // it on machine-to-machine calls that don't send the X-Workeros-Tenant.
  let apiKeyTenantId: string | null = null;
  // A role-scoped key narrows the request to a single role (see api_keys.role_id).
  let apiKeyRoleId: string | null = null;

  const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user?.id) {
    userId = session.user.id;
    email = session.user.email ?? null;
    const sessId = (session as { session?: { id?: string } }).session?.id;
    if (sessId) {
      // Fire-and-forget — the row only gets touched when ip/ua is missing.
      void stampSessionMeta(
        { db: ctx.db, dialect: ctx.dialect },
        sessId,
        c.req.raw,
      );
    }
  }

  if (!userId) {
    const authHeader = c.req.raw.headers.get("authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer pak_")) {
      const raw = authHeader.slice("bearer ".length).trim();
      const key = await findApiKey(ctx, raw);
      if (key) {
        userId = key.userId;
        email = await loadUserEmail(ctx, key.userId);
        apiKeyTenantId = key.tenantId ?? null;
        apiKeyRoleId = key.roleId ?? null;
        // fire-and-forget last-used update
        void touchLastUsed(ctx, key.id);
      }
    }
  }

  const roles = userId ? await loadRoleNames(ctx, userId, apiKeyRoleId) : [];

  c.set("auth", { userId, email, roles, apiKeyTenantId, apiKeyRoleId });
  await next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.userId)
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
      401,
    );
  await next();
};
