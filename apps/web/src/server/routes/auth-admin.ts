import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { desc, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { encryptSecret } from "../lib/crypto";
import { invalidateTenantAuth } from "../services/tenant-auth";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

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

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const TAG = "auth-admin";

const ConfigInput = z
  .object({
    providers: z.record(z.string(), z.unknown()).optional(),
    policy: z.record(z.string(), z.unknown()).optional(),
    sessionLifetime: z.string().optional(),
    redirectUrls: z.array(z.string().url()).optional(),
  })
  .openapi("AuthConfigInput");

const AuthConfigRow = z
  .object({
    tenantId: z.string(),
    providers: z.record(z.string(), z.unknown()),
    policy: z.record(z.string(), z.unknown()),
    sessionLifetime: z.string(),
    redirectUrls: z.array(z.string()),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("AuthConfigRow");

const SessionRow = z
  .object({
    id: z.string(),
    userId: z.string(),
    userEmail: z.string(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.unknown(),
    updatedAt: z.unknown(),
    expiresAt: z.unknown(),
    current: z.boolean(),
  })
  .openapi("AuthSessionRow");

/**
 * Strip secret material from a stored `providers` map before sending it to the
 * admin client: `clientSecretEnc` (ciphertext) is removed and replaced with a
 * boolean `hasSecret`; a stray plaintext `clientSecret` (shouldn't ever land
 * in storage, but belt-and-braces) is dropped too.
 */
function sanitizeProvidersForRead(
  providers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(providers ?? {})) {
    if (v && typeof v === "object") {
      const { clientSecretEnc, clientSecret: _drop, ...rest } = v as Record<
        string,
        unknown
      >;
      out[k] = { ...rest, hasSecret: typeof clientSecretEnc === "string" };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Pre-process an incoming `providers` patch: any `clientSecret` string is
 * encrypted into `clientSecretEnc` (and the plaintext dropped); an empty /
 * null `clientSecret` clears the stored secret. `null` provider values (delete
 * a provider) and primitives pass through unchanged.
 */
async function encryptIncomingProviderSecrets(
  incoming: Record<string, unknown>,
  appSecret: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || typeof v !== "object") {
      out[k] = v;
      continue;
    }
    const obj = { ...(v as Record<string, unknown>) };
    if ("clientSecret" in obj) {
      const raw = obj.clientSecret;
      delete obj.clientSecret;
      if (typeof raw === "string" && raw.trim()) {
        obj.clientSecretEnc = await encryptSecret(raw.trim(), appSecret);
      } else {
        obj.clientSecretEnc = null; // explicit clear
      }
    }
    out[k] = obj;
  }
  return out;
}

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
      emailOtp: {
        enabled: Boolean(env.AUTH_PLUGINS?.includes("email-otp")),
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
      apple: {
        enabled: Boolean(env.OAUTH_APPLE_CLIENT_ID && env.OAUTH_APPLE_CLIENT_SECRET),
        configured: Boolean(env.OAUTH_APPLE_CLIENT_ID),
        clientId: env.OAUTH_APPLE_CLIENT_ID ?? null,
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

export const authAdminRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/config",
      tags: [TAG],
      summary: "Get auth config",
      description:
        "Read the active workspace's auth config. Falls back to env-derived defaults when no row exists. Secrets are redacted.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: AuthConfigRow }) } },
        },
        ...errorResponses,
      },
    }),
    /** Read the active tenant's auth config; falls back to env-derived defaults. */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tableFor(ctx.dialect);
      const tenantId = auth.tenantId ?? "_global";
      const rows = await (ctx.db as any)
        .select()
        .from(t.config)
        .where(eq(t.config.tenantId, tenantId))
        .limit(1);
      const d = envAuthDefaults(ctx.env);
      if (rows[0]) {
        return c.json({
          data: {
            ...rows[0],
            // Merge env-derived built-in providers beneath the stored map so
            // providers introduced after this row was first written (e.g.
            // apple) still surface. Stored entries win for any key they define.
            providers: sanitizeProvidersForRead({
              ...d.providers,
              ...((rows[0].providers ?? {}) as Record<string, unknown>),
            }),
          },
        });
      }

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
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/config",
      tags: [TAG],
      summary: "Patch auth config",
      description:
        "Partial update. Provider `clientSecret` plaintext is encrypted into `clientSecretEnc`. Invalidates the cached tenant-auth instance.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        body: { required: true, content: { "application/json": { schema: ConfigInput } } },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
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
      // value removes that provider. Incoming `clientSecret` is encrypted into
      // `clientSecretEnc` first — plaintext never reaches storage.
      let providers = base.providers as Record<string, unknown>;
      if (body.providers !== undefined) {
        const incoming = await encryptIncomingProviderSecrets(
          body.providers as Record<string, unknown>,
          ctx.env.AUTH_SECRET,
        );
        providers = { ...providers };
        for (const [k, v] of Object.entries(incoming)) {
          if (v === null) {
            delete providers[k];
            continue;
          }
          if (v && typeof v === "object") {
            const merged = {
              ...((providers[k] as Record<string, unknown>) ?? {}),
              ...(v as Record<string, unknown>),
            };
            // An explicit `clientSecretEnc: null` clears the stored secret.
            if (merged.clientSecretEnc == null) delete merged.clientSecretEnc;
            // Never persist a plaintext secret under any name.
            delete (merged as Record<string, unknown>).clientSecret;
            providers[k] = merged;
          } else {
            providers[k] = v;
          }
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
      // The workspace's end-user auth instance is cached per isolate — drop it
      // so the next /api/t/<slug>/auth/* request rebuilds from the new config.
      if (auth.tenantId) invalidateTenantAuth(auth.tenantId);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/sessions",
      tags: [TAG],
      summary: "List active sessions",
      description:
        "Every active better-auth session joined with user email. Flags the caller's current session.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    /** All currently-active sessions, joined with the user's email. */
    async (c) => {
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/sessions/{id}",
      tags: [TAG],
      summary: "Revoke a session",
      description:
        "Idempotent — the next request from this session id returns 401.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    /** Revoke a single session; the next request from that token gets 401. */
    async (c) => {
      const ctx = c.get("ctx");
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.id, id));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/sessions/revoke-others",
      tags: [TAG],
      summary: "Revoke other sessions",
      description:
        "Signs out every session for the caller except the one making this request.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      responses: {
        200: {
          description: "Revoked",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                removed: z.number().int().nonnegative(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    /**
     * Revoke every session except the caller's. Useful for "sign out other
     * devices" flows triggered from the auth-settings page.
     */
    async (c) => {
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
    },
  );
