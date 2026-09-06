import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { inviteTokenFrom } from "./index";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";
import { emailOTP } from "better-auth/plugins/email-otp";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { and, eq } from "drizzle-orm";
import type { EmailAdapter } from "@backlex/core";
import * as pgSchema from "@backlex/db/pg/schema";
import * as sqliteSchema from "@backlex/db/sqlite/schema";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import { withTenantScope } from "./tenant-adapter";
import type { AuthHooks, AuthPlugin, GenericOidcProvider, OAuthProviderConfig } from "./index";

const appAuthSchemaFor = (provider: "pg" | "sqlite") => {
  const s = provider === "pg" ? pgSchema : sqliteSchema;
  return {
    user: s.appUsers,
    session: s.appSessions,
    account: s.appAccounts,
    verification: s.appVerifications,
  };
};

export interface TenantAuthConfig {
  /** Workspace this auth instance serves. Stamped onto every row it writes
   *  via the tenant-scoping adapter wrapper, AND folded into the cookie name
   *  + base path so two tenants' sessions never collide in the same browser. */
  tenantId: string;
  /** URL-safe workspace handle — used for the cookie prefix + the route the
   *  instance is mounted at (`{appUrl}/api/t/{slug}/auth`). */
  tenantSlug: string;
  /** Origin of the platform (e.g. `https://app.backlex.com`). Better-auth
   *  builds redirect URLs / cookie domains from this. */
  appURL: string;
  secret: string;
  /** Origins allowed to send credentialled requests. Always includes the
   *  appURL; the workspace's own redirect-allowlist can extend it. */
  trustedOrigins?: string[];
  /** Whether email+password sign-in is offered. Defaults to `true`. A
   *  workspace can turn it off (via its `auth_config`) to be OAuth/SSO-only. */
  emailAndPasswordEnabled?: boolean;
  /** Session lifetime in seconds. Defaults to 7 days. */
  sessionExpiresInSeconds?: number;
  hooks?: AuthHooks;
  socialProviders?: {
    google?: OAuthProviderConfig;
    github?: OAuthProviderConfig;
    apple?: OAuthProviderConfig;
  };
  email?: EmailAdapter;
  /**
   * Intercept an auth mail before it reaches {@link email}.
   *
   * The host uses this to offer the workspace's `send-email` auth hook the
   * message first, so an app can deliver sign-in mail through its own
   * transport and templates. It receives the message's MEANING (which auth
   * mail, and the link or code it carries) rather than the rendered body —
   * re-templating is the point, and a hook handed a finished subject line
   * could only re-send ours.
   *
   * Returns true when the interceptor delivered the message, in which case
   * `email` is not called. Throwing propagates: a hook the operator configured
   * to `deny` must fail the auth action, not silently fall back.
   */
  authEmail?: (msg: {
    type: "magic-link" | "email-otp";
    to: string;
    url?: string;
    otp?: string;
  }) => Promise<boolean>;
  plugins?: ReadonlyArray<AuthPlugin>;
  /** Workspace-defined OIDC / OAuth2 providers — the app-plane SSO path.
   *  Absent/empty keeps the `genericOAuth` plugin out of the instance. */
  oidcProviders?: ReadonlyArray<GenericOidcProvider>;
}

const buildPlugins = (config: TenantAuthConfig) => {
  const out: unknown[] = [];
  const enabled = new Set(config.plugins ?? []);
  if (enabled.has("magic-link") && config.email) {
    out.push(
      magicLink({
        sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
          if (await config.authEmail?.({ type: "magic-link", to: email, url })) return;
          await config.email!.send({
            to: email,
            subject: "Your sign-in link",
            text: `Click to sign in: ${url}`,
          });
        },
      }),
    );
  }
  // Workspace-defined OIDC / OAuth2 identity providers — the app-plane SSO
  // path. Registered only when at least one is configured.
  if (config.oidcProviders && config.oidcProviders.length > 0) {
    out.push(
      genericOAuth({
        config: config.oidcProviders.map((p) => ({
          providerId: p.providerId,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          ...(p.discoveryUrl ? { discoveryUrl: p.discoveryUrl } : {}),
          ...(p.authorizationUrl ? { authorizationUrl: p.authorizationUrl } : {}),
          ...(p.tokenUrl ? { tokenUrl: p.tokenUrl } : {}),
          ...(p.userInfoUrl ? { userInfoUrl: p.userInfoUrl } : {}),
          scopes: p.scopes ?? ["openid", "profile", "email"],
          pkce: p.pkce ?? true,
        })),
      }) as unknown as ReturnType<typeof magicLink>,
    );
  }
  if (enabled.has("email-otp") && config.email) {
    out.push(
      emailOTP({
        sendVerificationOTP: async ({ email, otp }: { email: string; otp: string }) => {
          if (await config.authEmail?.({ type: "email-otp", to: email, otp })) return;
          await config.email!.send({
            to: email,
            subject: "Your verification code",
            text: `Code: ${otp}`,
          });
        },
      }),
    );
  }
  // Bearer is always on for the app-plane: the customer's frontend lives on
  // a different origin and uses `Authorization: Bearer <session-token>`
  // instead of cookies. The session row in `app_sessions` is the same
  // either way — the bearer plugin just trades a cookie for a header.
  out.push(bearer());
  return out;
};

/**
 * Build a workspace-scoped better-auth instance backing the `app_users` pool.
 *
 * Two things make this different from `createAuth` (the control-plane factory):
 *
 *   1. The DB adapter is wrapped in {@link withTenantScope}, so every read /
 *      write is AND-ed with `tenant_id = config.tenantId`. A signup with
 *      email `a@b.co` in workspace A is a *different identity* from the same
 *      email in workspace B — they're not even visible to each other's
 *      better-auth instance.
 *
 *   2. The session cookie and base path are namespaced by tenant slug, so a
 *      browser can hold sessions for multiple workspaces simultaneously
 *      without them colliding.
 *
 * Anonymous-promotion / passkey are deliberately omitted — they require
 * additional tables (or platform-pool semantics) that aren't part of the
 * end-user pool yet.
 */
export const createTenantAuth = (
  db: PgDb | SqliteDb,
  provider: "pg" | "sqlite",
  config: TenantAuthConfig,
) => {
  const baseAdapter = drizzleAdapter(db, {
    provider,
    schema: appAuthSchemaFor(provider),
  });
  return betterAuth({
    baseURL: config.appURL,
    basePath: `/api/t/${config.tenantSlug}/auth`,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: withTenantScope(baseAdapter as any, config.tenantId) as any,
    emailAndPassword: {
      enabled: config.emailAndPasswordEnabled ?? true,
      autoSignIn: true,
      minPasswordLength: 8,
    },
    // `tenantId` is declared on every model that has a `tenant_id` column so
    // better-auth's adapter factory keeps the field — its `transformInput`
    // step otherwise drops anything not in the model schema, even fields the
    // tenant-scoping wrapper stamps. `input: false` keeps callers from
    // forging it via the API; the wrapper supplies the value from
    // `config.tenantId` on every create.
    session: {
      expiresIn: config.sessionExpiresInSeconds ?? 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
      },
    },
    account: {
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
      },
    },
    verification: {
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
      },
    },
    advanced: {
      cookiePrefix: `wo_${config.tenantSlug}`,
    },
    databaseHooks: {
      ...(config.hooks?.onUserCreated || config.hooks?.onBeforeUserCreated
        ? {
            user: {
              create: {
                ...(config.hooks?.onBeforeUserCreated
                  ? {
                      before: async (
                        data: { email?: string; name?: string },
                        hookCtx?: unknown,
                      ) => {
                        const r = await config.hooks!.onBeforeUserCreated!({
                          email: data.email ?? "",
                          name: data.name,
                          inviteToken: inviteTokenFrom(hookCtx),
                        });
                        if (!r.allow)
                          throw new APIError("FORBIDDEN", {
                            message: r.reason ?? "Sign-up is disabled",
                          });
                        // Returning nothing keeps the original user data.
                      },
                    }
                  : {}),
                ...(config.hooks?.onUserCreated
                  ? {
                      after: async (
                        user: { id: string; email: string },
                        hookCtx?: unknown,
                      ) => {
                        await config.hooks!.onUserCreated!({
                          ...user,
                          inviteToken: inviteTokenFrom(hookCtx),
                        });
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      session: {
        create: {
          // Block sign-in for suspended end-users: aborting the session
          // create makes the sign-in flow fail. `sessionMiddleware` also
          // rejects sessions whose owner is suspended, so even a session that
          // slipped through is useless — this just makes the rejection happen
          // at the source.
          before: async (session: { userId?: string }) => {
            const userId = session.userId;
            if (userId) {
              const appUsers = appAuthSchemaFor(provider).user;
              const rows = (await (db as any)
                .select({ status: appUsers.status })
                .from(appUsers)
                .where(and(eq(appUsers.id, userId), eq(appUsers.tenantId, config.tenantId)))
                .limit(1)) as Array<{ status: string }>;
              if (rows[0] && rows[0].status === "suspended") return false;
            }
            return { data: session };
          },
        },
      },
    },
    socialProviders: config.socialProviders,
    plugins: buildPlugins(config) as any,
  });
};

export type TenantAuth = ReturnType<typeof createTenantAuth>;
