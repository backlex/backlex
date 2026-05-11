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

/**
 * Defaults derived from environment — used when a tenant has no stored
 * `auth_config` row yet so the UI reflects what the worker actually has, and
 * as the base for the first PATCH so a partial update doesn't drop the
 * built-in providers/policy keys.
 */
function envAuthDefaults(env: any) {
  return {
    providers: {
      email: { enabled: true, configured: true, system: true },
      magic: {
        enabled: Boolean(env.AUTH_PLUGINS?.includes("magic-link")),
        configured: true,
        system: true,
      },
      passkey: {
        enabled: Boolean(env.AUTH_PLUGINS?.includes("passkey")),
        configured: true,
      },
      github: {
        enabled: Boolean(env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET),
        configured: Boolean(env.OAUTH_GITHUB_CLIENT_ID),
        clientId: env.OAUTH_GITHUB_CLIENT_ID ?? null,
      },
      google: {
        enabled: Boolean(env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET),
        configured: Boolean(env.OAUTH_GOOGLE_CLIENT_ID),
        clientId: env.OAUTH_GOOGLE_CLIENT_ID ?? null,
      },
    } as Record<string, Record<string, unknown>>,
    policy: {
      requireEmailVerification: true,
      mfaTotp: false,
      mfaRequiredForAdmins: false,
      passkeys: Boolean(env.AUTH_PLUGINS?.includes("passkey")),
      openSignup: true,
    } as Record<string, unknown>,
    sessionLifetime: "30d",
    redirectUrls: [`${env.APP_URL}/auth/callback`] as string[],
  };
}

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

    const d = envAuthDefaults(ctx.env);
    return c.json({
      data: {
        tenantId,
        providers: d.providers,
        policy: d.policy,
        sessionLifetime: d.sessionLifetime,
        redirectUrls: d.redirectUrls,
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
      .select()
      .from(t.config)
      .where(eq(t.config.tenantId, tenantId))
      .limit(1);

    const defaults = envAuthDefaults(ctx.env);
    const base = existing[0]
      ? {
          providers: (existing[0].providers ?? {}) as Record<string, Record<string, unknown>>,
          policy: (existing[0].policy ?? {}) as Record<string, unknown>,
          sessionLifetime: (existing[0].sessionLifetime ?? defaults.sessionLifetime) as string,
          redirectUrls: (existing[0].redirectUrls ?? defaults.redirectUrls) as string[],
        }
      : {
          providers: defaults.providers,
          policy: defaults.policy,
          sessionLifetime: defaults.sessionLifetime,
          redirectUrls: defaults.redirectUrls,
        };

    // Merge providers per-key so partial updates (toggling one provider,
    // editing one provider's clientId) don't wipe sibling keys. A `null`
    // value removes that provider.
    let providers = base.providers as Record<string, unknown>;
    if (body.providers !== undefined) {
      providers = { ...providers };
      for (const [k, v] of Object.entries(body.providers as Record<string, unknown>)) {
        if (v === null) delete providers[k];
        else if (v && typeof v === "object")
          providers[k] = {
            ...((providers[k] as Record<string, unknown>) ?? {}),
            ...(v as Record<string, unknown>),
          };
        else providers[k] = v;
      }
    }
    const policy =
      body.policy !== undefined ? { ...base.policy, ...body.policy } : base.policy;
    const sessionLifetime =
      body.sessionLifetime !== undefined ? body.sessionLifetime : base.sessionLifetime;
    const redirectUrls =
      body.redirectUrls !== undefined ? body.redirectUrls : base.redirectUrls;

    if (existing[0]) {
      await (ctx.db as any)
        .update(t.config)
        .set({
          providers,
          policy,
          sessionLifetime,
          redirectUrls,
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(eq(t.config.tenantId, tenantId));
    } else {
      await (ctx.db as any).insert(t.config).values({
        tenantId,
        providers,
        policy,
        sessionLifetime,
        redirectUrls,
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
        updatedAt: t.sessions.updatedAt,
        expiresAt: t.sessions.expiresAt,
      })
      .from(t.sessions)
      .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
      .orderBy(desc(t.sessions.updatedAt));
    const current = await ctx.auth.api
      .getSession({ headers: c.req.raw.headers })
      .catch(() => null);
    const currentId =
      (current as { session?: { id?: string } } | null)?.session?.id ?? null;
    return c.json({
      data: (rows as { id: string }[]).map((r) => ({
        ...r,
        current: currentId != null && r.id === currentId,
      })),
    });
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
