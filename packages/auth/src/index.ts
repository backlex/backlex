import type { EmailAdapter } from "@backlex/core";
import type { PgDb } from "@backlex/db/pg";
import * as pgSchema from "@backlex/db/pg/schema";
import type { SqliteDb } from "@backlex/db/sqlite";
import * as sqliteSchema from "@backlex/db/sqlite/schema";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { anonymous } from "better-auth/plugins/anonymous";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";
import { twoFactor } from "better-auth/plugins/two-factor";

export interface AuthHooks {
  /** Runs before a user row is created (any sign-up path: email/password,
   *  social, magic-link, anonymous). Receives the pending user's email/name so
   *  the host can make admission decisions (e.g. allow an invited address even
   *  when public sign-up is closed). Return `{ allow: false }` to reject the
   *  sign-up — the auth handler turns it into a 403 with `reason` as message. */
  onBeforeUserCreated?: (user: { email: string; name?: string }) =>
    | Promise<{ allow: boolean; reason?: string }>
    | { allow: boolean; reason?: string };
  onUserCreated?: (user: { id: string; email: string }) => Promise<void> | void;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export type AuthPlugin = "magic-link" | "email-otp" | "anonymous" | "passkey" | "two-factor";

/**
 * One workspace-defined OIDC / OAuth2 identity provider, in the shape
 * better-auth's `genericOAuth` plugin consumes.
 *
 * This is the generic path: Okta, Auth0, Keycloak, Entra, Authentik, GitLab,
 * Discord and LinkedIn are all *configuration*, not code. `discoveryUrl` is the
 * preferred wiring — the caller resolves the explicit endpoints from it and
 * passes both, so a provider whose discovery document later moves keeps
 * working from the stored values.
 */
export interface GenericOidcProvider {
  /** better-auth `providerId` — also the sign-in route segment. */
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
  pkce?: boolean;
}

export interface AuthConfig {
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  hooks?: AuthHooks;
  socialProviders?: {
    google?: OAuthProviderConfig;
    github?: OAuthProviderConfig;
    apple?: OAuthProviderConfig;
  };
  email?: EmailAdapter;
  /** Recognized: `magic-link`, `email-otp`, `anonymous`, `passkey`. Plugins
   *  requiring an email adapter are silently skipped if `email` is not
   *  provided. `passkey` adds a `passkey` table — run migrations after
   *  enabling. */
  plugins?: ReadonlyArray<AuthPlugin>;
  /** Workspace-defined OIDC / OAuth2 providers. Each becomes a `genericOAuth`
   *  entry; an empty/absent list keeps the plugin out of the instance. */
  oidcProviders?: ReadonlyArray<GenericOidcProvider>;
  /** Require a confirmed email before password sign-in. better-auth mails a
   *  verification link on sign-up (and blocks login until it's clicked). The
   *  caller MUST only set this when `email` is a real transport — gating login
   *  behind a verification mail that only logs to the console would lock every
   *  new user out. Defaults to off. */
  requireEmailVerification?: boolean;
}

const authSchemaFor = (provider: "pg" | "sqlite") => {
  const s = provider === "pg" ? pgSchema : sqliteSchema;
  return {
    user: s.users,
    session: s.sessions,
    account: s.accounts,
    verification: s.verifications,
    passkey: s.passkeys,
    twoFactor: s.twoFactors,
    oauthApplication: s.oauthApplications,
    oauthAccessToken: s.oauthAccessTokens,
    oauthConsent: s.oauthConsents,
  };
};

/** OAuth scopes the MCP authorization server advertises on top of the plugin's
 *  built-in defaults (openid/profile/email/offline_access). `mcp:write` is the
 *  one the resource server inspects: tokens without it run MCP read-only. */
export const MCP_OAUTH_SCOPES = ["mcp:read", "mcp:write"] as const;

const buildPlugins = async (config: AuthConfig) => {
  const out: ReturnType<typeof magicLink>[] = [];
  // Always on: lets native/mobile admin clients authenticate with
  // `Authorization: Bearer <session-token>` instead of a cookie. The session
  // row is identical either way — header vs cookie is the only difference, so
  // browser cookie auth is unaffected.
  out.push(bearer() as unknown as ReturnType<typeof magicLink>);
  // Always on: the two-factor (TOTP) plugin only adds endpoints + reads the
  // `twoFactor` table / `users.two_factor_enabled` column. It does nothing
  // until a user opts in from Settings, so it's safe to enable unconditionally
  // — mirroring how `bearer` is always present.
  out.push(
    twoFactor({ issuer: "backlex" }) as unknown as ReturnType<typeof magicLink>,
  );
  const enabled = new Set(config.plugins ?? []);
  if (enabled.has("magic-link") && config.email) {
    out.push(
      magicLink({
        sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
          await config.email!.send({
            to: email,
            subject: "Your sign-in link",
            text: `Click to sign in: ${url}`,
          });
        },
      }) as unknown as ReturnType<typeof magicLink>,
    );
  }
  if (enabled.has("email-otp") && config.email) {
    out.push(
      emailOTP({
        sendVerificationOTP: async ({ email, otp }: { email: string; otp: string }) => {
          await config.email!.send({
            to: email,
            subject: "Your verification code",
            text: `Code: ${otp}`,
          });
        },
      }) as unknown as ReturnType<typeof magicLink>,
    );
  }
  if (enabled.has("anonymous")) {
    out.push(anonymous() as unknown as ReturnType<typeof magicLink>);
  }
  // Workspace-defined OIDC / OAuth2 identity providers. Registered only when
  // at least one is configured, so instances without SSO don't carry the
  // plugin's routes.
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
  // Always on: turns this instance into an OAuth 2.1 authorization server for
  // the MCP endpoint (discovery metadata, dynamic client registration, PKCE
  // authorize/token, consent) so OAuth-only MCP clients — hosted Claude
  // (claude.ai custom connectors) foremost — can connect to `/mcp` without a
  // pasted `pak_` key. Endpoints live under the better-auth basePath
  // (`/api/auth/mcp/*`); the app mounts root `/.well-known/*` aliases and an
  // authorize wrapper that forces a consent screen (the plugin skips consent
  // unless the client sends `prompt=consent` — with open dynamic registration
  // that would allow silent authorization). Dynamic import keeps the plugins
  // barrel (the only export path that carries the server-side `mcp`) out of
  // the module graph until instance construction.
  const { mcp } = await import("better-auth/plugins");
  // The metadata builders do NOT merge `oidcConfig.scopes` into the
  // advertised scopes_supported — without an explicit override discovery
  // shows only the four defaults, clients never request mcp:write, and every
  // token lands read-only. Plugin quirk: the authorization-server document
  // spreads a TOP-LEVEL `MCPOptions.metadata` (absent from the type — hence
  // the cast below) while the protected-resource document reads
  // `oidcConfig.metadata`, so the override must live in BOTH places.
  const mcpMetadata = {
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "offline_access",
      ...MCP_OAUTH_SCOPES,
    ],
  };
  out.push(
    mcp({
      loginPage: "/sign-in",
      // RFC 9728 resource identifier — strict MCP clients compare this against
      // the server URL they were pointed at, so it must be the /mcp endpoint,
      // not the bare origin the plugin would default to.
      resource: `${config.baseURL.replace(/\/+$/, "")}/mcp`,
      metadata: mcpMetadata,
      oidcConfig: {
        // The type wants loginPage here too, but at runtime mcp() overrides it
        // with its own top-level `loginPage` — keep the two in sync anyway.
        loginPage: "/sign-in",
        scopes: [...MCP_OAUTH_SCOPES],
        consentPage: "/oauth/consent",
        // PKCE stays required (plugin default) — hosted clients are public.
        metadata: mcpMetadata,
      },
    } as Parameters<typeof mcp>[0]) as unknown as ReturnType<typeof magicLink>,
  );
  if (enabled.has("passkey")) {
    // Dynamic import: @better-auth/passkey pulls @simplewebauthn (+ its crypto
    // graph) — a chunk every cold isolate would otherwise eval even when
    // passkeys are disabled. Loaded only when the `passkey` plugin is enabled.
    const { passkey } = await import("@better-auth/passkey");
    out.push(
      passkey({
        rpName: "backlex",
        // `requireSession: true` means passkeys can only be added by an
        // already-signed-in user — first-factor sign-in still goes through
        // email/password (or social), then they enrol a passkey for the
        // next sign-in.
        registration: { requireSession: true },
        authentication: {},
      }) as unknown as ReturnType<typeof magicLink>,
    );
  }
  return out;
};

export const createAuth = async (
  db: PgDb | SqliteDb,
  provider: "pg" | "sqlite",
  config: AuthConfig,
) => {
  // Awaited up front so the (conditionally dynamic-imported) passkey plugin is
  // ready before the auth instance is constructed. createAuth is called once
  // per isolate from the already-async buildContext, so this adds no per-
  // request cost.
  const plugins = await buildPlugins(config);
  return betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, {
      provider,
      schema: authSchemaFor(provider),
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      // Only gate login behind verification when the caller opted in AND an
      // email transport exists — see the AuthConfig doc-comment.
      ...(config.email && config.requireEmailVerification
        ? { requireEmailVerification: true }
        : {}),
      ...(config.email
        ? {
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              await config.email!.send({
                to: user.email,
                subject: "Reset your backlex password",
                text:
                  `We received a request to reset your password.\n\n` +
                  `Choose a new password: ${url}\n\n` +
                  `If you didn't request this, you can safely ignore this email.`,
                html:
                  `<p>We received a request to reset your password.</p>` +
                  `<p><a href="${url}">Choose a new password</a></p>` +
                  `<p>If you didn't request this, you can safely ignore this email.</p>`,
              });
            },
          }
        : {}),
    },
    // Verification mail + auto-sign-in after confirm. Wired only when login is
    // actually gated (real email + opt-in), so an instance without email never
    // promises a verification link it can't deliver.
    ...(config.email && config.requireEmailVerification
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              await config.email!.send({
                to: user.email,
                subject: "Verify your backlex email",
                text:
                  `Confirm your email address to finish setting up your account.\n\n` +
                  `Verify: ${url}\n\n` +
                  `If you didn't create an account, you can ignore this email.`,
                html:
                  `<p>Confirm your email address to finish setting up your account.</p>` +
                  `<p><a href="${url}">Verify your email</a></p>` +
                  `<p>If you didn't create an account, you can ignore this email.</p>`,
              });
            },
          },
        }
      : {}),
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
      // Sign the session payload into the cookie and skip the DB lookup for
      // the next 60s. Cuts ~1 D1 round-trip off every authenticated request.
      //
      // **This is the lever for "sign out my other devices" latency, and the
      // number is not 60 seconds.** Measured against the shipped config
      // (`apps/web/tests/auth-admin-sessions.test.ts`): a revoked device still
      // gets 200 on `/api/me` immediately after `revoke-others`, with nothing
      // cleared, because this blob answers our routes too — not just
      // better-auth's own `/api/auth/*`. Worse, a request it answers is written
      // into `services/permissions-cache`'s 30s per-isolate cache under the
      // bare-token key, so the two windows COMPOUND: the last warm request at
      // t=59s keeps the token accepted to roughly t=89s.
      //
      // Flipping `enabled` to false was measured too: revocation becomes
      // IMMEDIATE (401 on the same request), because the handler already calls
      // `invalidateSession` and nothing repopulates it. The price is
      // better-auth's ~2 D1 round-trips on every request that misses the inner
      // 30s cache. That trade — up to ~90s of stale access against a session
      // read per cold request — is a deliberate open decision, not an
      // oversight; it is written down here because this line is where someone
      // would come to change it.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    databaseHooks: {
      // Block session creation for suspended operators at the source — covers
      // every sign-in path (email/password, magic-link, and the SSO mint, which
      // goes through better-auth's internalAdapter.createSession). Mirrors the
      // workspace end-user guard in tenant.ts. `sessionMiddleware` still rejects
      // a slipped-through session, so this just fails the flow earlier.
      session: {
        create: {
          before: async (session: { userId?: string }) => {
            const userId = session.userId;
            if (userId) {
              const u = provider === "pg" ? pgSchema.users : sqliteSchema.users;
              try {
                const rows = (await (db as never as { select: Function })
                  .select({ status: u.status })
                  .from(u)
                  .where(eq(u.id, userId))
                  .limit(1)) as Array<{ status: string }>;
                if (rows[0] && rows[0].status === "suspended") return false;
              } catch {
                // Degrade open on a transient read error — don't lock everyone
                // out if the status read fails.
              }
            }
            return { data: session };
          },
        },
      },
      ...(config.hooks?.onUserCreated || config.hooks?.onBeforeUserCreated
        ? {
            user: {
              create: {
                ...(config.hooks?.onBeforeUserCreated
                  ? {
                      before: async (data: { email?: string; name?: string }) => {
                        const r = await config.hooks!.onBeforeUserCreated!({
                          email: data.email ?? "",
                          name: data.name,
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
                      after: async (user: { id: string; email: string }) => {
                        await config.hooks!.onUserCreated!(user);
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    },
    socialProviders: config.socialProviders,
    plugins,
  });
};

export type Auth = Awaited<ReturnType<typeof createAuth>>;

export { createTenantAuth, type TenantAuth, type TenantAuthConfig } from "./tenant";
export { withTenantScope } from "./tenant-adapter";
export { hashSecret, verifySecret, isSecretHash } from "./secret-hash";
