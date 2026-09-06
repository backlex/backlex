import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { invalidateSession } from "../services/permissions-cache";
import { encryptSecret } from "../lib/crypto";
import { invalidateTenantAuth } from "../services/tenant-auth";
import { SECURITY, OkSchema, errorResponses, httpUrl } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { assertTenantMember, requireTenant } from "../services/roles/guards";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        sessions: pg.schema.sessions,
        users: pg.schema.users,
        config: pg.schema.authConfig,
        tenantMembers: pg.schema.tenantMembers,
        apiKeys: pg.schema.apiKeys,
      }
    : {
        sessions: sqlite.schema.sessions,
        users: sqlite.schema.users,
        config: sqlite.schema.authConfig,
        tenantMembers: sqlite.schema.tenantMembers,
        apiKeys: sqlite.schema.apiKeys,
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
    redirectUrls: z.array(httpUrl()).optional(),
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

const _SessionRow = z
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
      // Gate password sign-in behind a verification link. Honoured only when a
      // real email transport is configured (otherwise the instance can't
      // deliver the link). Takes effect on the next isolate build.
      requireEmailVerification: false,
      // Closed by default — admins open public sign-up explicitly; the first
      // user and invited addresses are admitted regardless (see context.ts).
      openSignup: false,
    } as Record<string, unknown>,
    sessionLifetime: "30d",
    redirectUrls: [`${env.APP_URL}/auth/callback`] as string[],
  };
}

export const authAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
        "Active better-auth sessions for members of the active workspace, joined with user email. Flags the caller's current session.",
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
    /** Active sessions of the workspace's own members, joined with the user's
     *  email. `sessions` is a global table (no tenant_id), so the workspace
     *  scope has to come from a `tenant_members` join — without it a tenant
     *  admin would read the email + IP of every operator on the instance. Same
     *  invariant `routes/roles/users.ts` enforces with `assertTenantMember`. */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
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
        .innerJoin(
          t.tenantMembers,
          and(
            eq(t.tenantMembers.userId, t.sessions.userId),
            eq(t.tenantMembers.tenantId, tenantId),
          ),
        )
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
    /** Revoke a single session; the next request from that token gets 401.
     *  Resolves the session's owner first and asserts they belong to the active
     *  workspace — `sessions.id` is a global identifier, so without the check a
     *  tenant admin could sign out any user on the instance. */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      const row = (await (ctx.db as any)
        .select({ userId: t.sessions.userId })
        .from(t.sessions)
        .where(eq(t.sessions.id, id))
        .limit(1)) as { userId: string }[];
      // Idempotent by contract: an unknown id stays a 200 no-op rather than
      // leaking whether that session exists in some other workspace.
      if (!row[0]) return c.json({ ok: true });
      await assertTenantMember(ctx, tenantId, row[0].userId);
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
        "Signs out every session for the caller except the one making this request. " +
        "Always reports how many API keys the caller still holds — those are not " +
        "sessions and outlive a sign-out. Pass `?apiKeys=1` to revoke them too.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        // A QUERY flag, not a body. This route has always been a bodyless POST,
        // and giving it an optional JSON body is the exact shape that 500'd
        // live twice in this repo: a client that sets
        // `content-type: application/json` with an empty body makes the
        // zod-openapi body validator throw `Malformed JSON in request body`,
        // even with `body.required: false`. A query parameter cannot reach that
        // code path, and every existing caller keeps working untouched.
        query: z.object({
          // `"0"` is accepted and means no. It would be easy to allow only
          // `"1"` and let everything else 422, but then the natural way to say
          // no — `?apiKeys=0` — is an error, and a caller who gets a 422 on a
          // destructive endpoint cannot tell whether the sessions went too.
          apiKeys: z
            .enum(["0", "1"])
            .optional()
            .openapi({
              description:
                "Set to `1` to ALSO revoke every API key the caller owns. Off by " +
                "default on purpose: a personal key can be powering a CI job or a " +
                "server integration that has nothing to do with the browser " +
                "session being signed out.",
            }),
        }),
      },
      responses: {
        200: {
          description: "Revoked",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                removed: z.number().int().nonnegative(),
                /** Live API keys the caller owns AFTER this call. */
                apiKeys: z.number().int().nonnegative(),
                apiKeysRevoked: z.number().int().nonnegative(),
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
     *
     * **API keys are reported, and only revoked on request.** `api_keys` is
     * keyed on `user_id` and never on a session, so a key survives every
     * sign-out — which makes the revocation window (~90s, see
     * `packages/auth`'s `cookieCache` note) long enough for a stolen session to
     * mint permanent access. Revoking them by default would be worse than the
     * hole: the same personal key routinely powers a CI job or a server
     * integration that has nothing to do with the laptop being signed out, so
     * "sign out my other devices" would become an outage. Reporting the count
     * unconditionally turns an invisible gap into a visible one; `?apiKeys=1`
     * is there for the caller who actually suspects compromise.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tableFor(ctx.dialect);
      // `token` as well as `id`: deleting the row is only half of a
      // revocation, because `middleware/session.ts` answers from a per-isolate
      // cache keyed on the session's cookie. Without this the revoked device
      // kept passing for the cache's full TTL on top of better-auth's own.
      const allSessions = await (ctx.db as any)
        .select({ id: t.sessions.id, token: t.sessions.token })
        .from(t.sessions)
        .where(eq(t.sessions.userId, auth.userId!));
      // We only need to keep the caller's current session. Find it from the
      // request cookies via better-auth getSession.
      const current = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
      const keepId = (current as { session?: { id?: string } } | null)?.session?.id ?? null;
      let removed = 0;
      for (const s of allSessions as { id: string; token: string | null }[]) {
        if (s.id === keepId) continue;
        await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.id, s.id));
        // Same isolate only — this is a per-worker cache, so it does not reach
        // whichever other isolate served that device last. It is the half we
        // can close from here; see `invalidateSession` for the half we cannot.
        if (s.token) invalidateSession(s.token);
        removed += 1;
      }

      // Scoped to the caller's own keys IN THE ACTIVE WORKSPACE. Both halves
      // are load-bearing and the second one was added because
      // `scripts/scan-tenant-scope.ts` refused the query without it — rightly:
      // `api_keys` carries a `tenant_id` and `sessions` does not, which is this
      // codebase saying that a key belongs to a workspace while a session
      // belongs to an account. Dropping the tenant predicate would let a
      // sign-out on workspace A kill the key a job runs against workspace B.
      //
      // The residual, stated rather than left to be discovered: keys the caller
      // holds in their OTHER workspaces are out of reach from here, so an
      // account-level compromise still needs this run once per workspace.
      const keyScope = and(
        eq(t.apiKeys.tenantId, auth.tenantId!),
        eq(t.apiKeys.userId, auth.userId!),
        // Already-revoked keys are not live: neither counted nor revoked twice.
        isNull(t.apiKeys.revokedAt),
      );
      const liveKeys = await (ctx.db as any)
        .select({ id: t.apiKeys.id })
        .from(t.apiKeys)
        .where(keyScope);
      let apiKeysRevoked = 0;
      if (c.req.query("apiKeys") === "1") {
        for (const k of liveKeys as { id: string }[]) {
          await (ctx.db as any)
            .update(t.apiKeys)
            .set({ revokedAt: new Date() })
            // Re-stating the scope on the write, not just `id`: the scanner
            // reads each statement on its own, and so does anyone auditing it.
            .where(and(eq(t.apiKeys.id, k.id), keyScope));
          apiKeysRevoked += 1;
        }
      }
      return c.json({
        ok: true,
        removed,
        // What still grants access AFTER this call — the number the caller has
        // to act on, not the number they had a moment ago.
        apiKeys: (liveKeys as unknown[]).length - apiKeysRevoked,
        apiKeysRevoked,
      });
    },
  );
