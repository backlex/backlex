import type { MiddlewareHandler } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { findApiKey, touchLastUsed } from "../services/api-keys";
import { verifyAccessToken } from "../lib/jwt";

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

/**
 * Cross-tenant role names (unfiltered union). Only consulted by tenantMiddleware
 * when the caller isn't a member of the requested workspace — to decide whether
 * they're a super-admin who should pass through anyway. Skipped entirely on the
 * hot path (member of the active tenant), so this lookup is exported and called
 * lazily rather than from sessionMiddleware on every request.
 */
export const loadUnfilteredRoleNames = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  userId: string,
  restrictRoleId: string | null,
): Promise<string[]> => {
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

/**
 * Look up a workspace end-user session by its bearer token. The token format
 * is exactly what better-auth's `bearer` plugin issues (the value of
 * `app_sessions.token`). Returns `null` for unknown / expired tokens — the
 * caller treats that as "no app session" and falls through.
 */
const findAppSession = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  token: string,
): Promise<{ userId: string; tenantId: string; email: string | null } | null> => {
  const t =
    ctx.dialect === "pg"
      ? { sessions: pg.schema.appSessions, users: pg.schema.appUsers }
      : { sessions: sqlite.schema.appSessions, users: sqlite.schema.appUsers };
  const rows = (await (ctx.db as any)
    .select({
      userId: t.sessions.userId,
      tenantId: t.sessions.tenantId,
      expiresAt: t.sessions.expiresAt,
      email: t.users.email,
      status: t.users.status,
    })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
    .where(eq(t.sessions.token, token))
    .limit(1)) as Array<{
      userId: string;
      tenantId: string;
      expiresAt: Date | number;
      email: string | null;
      status: string;
    }>;
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "active") return null; // suspended end-users get no access
  const exp =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  if (exp <= Date.now()) return null;
  return { userId: row.userId, tenantId: row.tenantId, email: row.email };
};

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");

  let plane: "platform" | "app" = "platform";
  let userId: string | null = null;
  let email: string | null = null;
  // When a request authenticates with an API key, the key carries the tenant
  // it was issued for. Surface it so tenantMiddleware can pin the request to
  // that workspace — header/cookie/user-pref resolution would otherwise miss
  // it on machine-to-machine calls that don't send the X-Backlex-Tenant.
  let apiKeyTenantId: string | null = null;
  // A role-scoped key narrows the request to a single role (see api_keys.role_id).
  let apiKeyRoleId: string | null = null;
  // The key's id + MCP guard fields. The MCP dispatcher reads these to
  // filter `tools/list` and reject out-of-allowlist `tools/call`. For
  // session-based requests (no API key) they stay null/false and the MCP
  // surface enforces no extra restriction beyond permissions.
  let apiKeyId: string | null = null;
  let apiKeyMcpTools: string[] | null = null;
  let apiKeyMcpReadOnly = false;
  // Workspace end-user sessions (`Authorization: Bearer <app-session-token>`)
  // similarly pin the request to the workspace that issued the session — the
  // app's frontend doesn't send a tenant header, it just uses its token.
  let appSessionTenantId: string | null = null;

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
        apiKeyId = key.id;
        apiKeyMcpTools = key.mcpTools ?? null;
        apiKeyMcpReadOnly = Boolean(key.mcpReadOnly);
        // fire-and-forget last-used update
        void touchLastUsed(ctx, key.id);
      }
    } else if (authHeader.toLowerCase().startsWith("bearer ")) {
      // Any non-`pak_` bearer is a workspace end-user token. Two accepted
      // shapes, tried in order:
      //   1. a stateless access JWT — verified with AUTH_SECRET, no DB hit;
      //   2. an opaque, DB-backed session token (the refresh token, also
      //      issued directly by SAML/LDAP and better-auth's bearer plugin).
      // Unknown tokens fall through → unauthenticated.
      const token = authHeader.slice("bearer ".length).trim();
      const claims = await verifyAccessToken(ctx.env.AUTH_SECRET, token);
      if (claims) {
        plane = "app";
        userId = claims.sub;
        email = claims.email;
        appSessionTenantId = claims.tid;
      } else {
        const appSess = await findAppSession(
          { db: ctx.db, dialect: ctx.dialect },
          token,
        );
        if (appSess) {
          plane = "app";
          userId = appSess.userId;
          email = appSess.email;
          appSessionTenantId = appSess.tenantId;
        }
      }
    }
  }

  // Roles aren't loaded here — tenantMiddleware will load them tenant-scoped a
  // moment later, and on the hot path (caller is already a member of the active
  // workspace) it never needs the unfiltered union. The lazy fallback inside
  // tenantMiddleware uses `loadUnfilteredRoleNames` only when membership fails,
  // so we save one D1 round-trip on every authenticated request.
  c.set("auth", {
    plane,
    userId,
    email,
    roles: [],
    apiKeyTenantId,
    apiKeyRoleId,
    apiKeyId,
    apiKeyMcpTools,
    apiKeyMcpReadOnly,
    appSessionTenantId,
  });
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
