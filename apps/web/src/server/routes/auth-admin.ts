import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        sessions: pg.schema.sessions,
        users: pg.schema.users,
        config: pg.schema.authConfig,
      }
    : {
        sessions: sqlite.schema.sessions,
        users: sqlite.schema.users,
        config: sqlite.schema.authConfig,
      };

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const ConfigInput = z.object({
  providers: z.record(z.unknown()).optional(),
  policy: z.record(z.unknown()).optional(),
  sessionLifetime: z.string().optional(),
  redirectUrls: z.array(z.string().url()).optional(),
});

export const authAdminRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  /** Read the active tenant's auth config; falls back to env-derived defaults. */
  .get("/config", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const tenantId = auth.tenantId ?? "_global";
    const rows = await (ctx.db as any)
      .select()
      .from(t.config)
      .where(eq(t.config.tenantId, tenantId))
      .limit(1);
    if (rows[0]) return c.json({ data: rows[0] });

    // Defaults: read what env actually has so the UI shows the live state.
    const envProviders: Record<string, unknown> = {
      email: { enabled: true, configured: true, system: true },
      magic: { enabled: Boolean(ctx.env.AUTH_PLUGINS?.includes("magic-link")), configured: true, system: true },
      passkey: { enabled: Boolean(ctx.env.AUTH_PLUGINS?.includes("passkey")), configured: true },
      github: {
        enabled: Boolean(ctx.env.OAUTH_GITHUB_CLIENT_ID && ctx.env.OAUTH_GITHUB_CLIENT_SECRET),
        configured: Boolean(ctx.env.OAUTH_GITHUB_CLIENT_ID),
        clientId: ctx.env.OAUTH_GITHUB_CLIENT_ID ?? null,
      },
      google: {
        enabled: Boolean(ctx.env.OAUTH_GOOGLE_CLIENT_ID && ctx.env.OAUTH_GOOGLE_CLIENT_SECRET),
        configured: Boolean(ctx.env.OAUTH_GOOGLE_CLIENT_ID),
        clientId: ctx.env.OAUTH_GOOGLE_CLIENT_ID ?? null,
      },
    };
    return c.json({
      data: {
        tenantId,
        providers: envProviders,
        policy: {
          requireEmailVerification: true,
          mfaTotp: false,
          mfaRequiredForAdmins: false,
          passkeys: Boolean(ctx.env.AUTH_PLUGINS?.includes("passkey")),
          openSignup: true,
        },
        sessionLifetime: "30d",
        redirectUrls: [`${ctx.env.APP_URL}/auth/callback`],
        updatedAt: null,
      },
    });
  })
  .patch("/config", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = ConfigInput.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const tenantId = auth.tenantId ?? "_global";
    const existing = await (ctx.db as any)
      .select({ tenantId: t.config.tenantId })
      .from(t.config)
      .where(eq(t.config.tenantId, tenantId))
      .limit(1);
    if (existing[0]) {
      await (ctx.db as any)
        .update(t.config)
        .set({
          ...(body.providers !== undefined ? { providers: body.providers } : {}),
          ...(body.policy !== undefined ? { policy: body.policy } : {}),
          ...(body.sessionLifetime !== undefined
            ? { sessionLifetime: body.sessionLifetime }
            : {}),
          ...(body.redirectUrls !== undefined
            ? { redirectUrls: body.redirectUrls }
            : {}),
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(eq(t.config.tenantId, tenantId));
    } else {
      await (ctx.db as any).insert(t.config).values({
        tenantId,
        providers: body.providers ?? {},
        policy: body.policy ?? {},
        sessionLifetime: body.sessionLifetime ?? "30d",
        redirectUrls: body.redirectUrls ?? [],
      });
    }
    return c.json({ ok: true });
  })
  /** All currently-active sessions, joined with the user's email. */
  .get("/sessions", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select({
        id: t.sessions.id,
        userId: t.sessions.userId,
        userEmail: t.users.email,
        ipAddress: t.sessions.ipAddress,
        userAgent: t.sessions.userAgent,
        createdAt: t.sessions.createdAt,
        expiresAt: t.sessions.expiresAt,
      })
      .from(t.sessions)
      .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
      .orderBy(desc(t.sessions.createdAt));
    return c.json({ data: rows });
  })
  /** Revoke a single session; the next request from that token gets 401. */
  .delete("/sessions/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  /**
   * Revoke every session except the caller's. Useful for "sign out other
   * devices" flows triggered from the auth-settings page.
   */
  .post("/sessions/revoke-others", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const allSessions = await (ctx.db as any)
      .select({ id: t.sessions.id })
      .from(t.sessions)
      .where(eq(t.sessions.userId, auth.userId!));
    // We only need to keep the caller's current session. Find it from the
    // request cookies via better-auth getSession.
    const current = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
    const keepId = (current as { session?: { id?: string } } | null)?.session?.id ?? null;
    let removed = 0;
    for (const s of allSessions as { id: string }[]) {
      if (s.id === keepId) continue;
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.id, s.id));
      removed += 1;
    }
    return c.json({ ok: true, removed });
  });
