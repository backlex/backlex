import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { EmailAdapter } from "@workeros/core";
import * as pgSchema from "@workeros/db/pg/schema";
import * as sqliteSchema from "@workeros/db/sqlite/schema";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import { withTenantScope } from "./tenant-adapter";
import type { AuthHooks, AuthPlugin, OAuthProviderConfig } from "./index";

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
  /** Origin of the platform (e.g. `https://app.workeros.com`). Better-auth
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
  };
  email?: EmailAdapter;
  plugins?: ReadonlyArray<AuthPlugin>;
}

const buildPlugins = (config: TenantAuthConfig) => {
  const out: unknown[] = [];
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
      }),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    databaseHooks: config.hooks?.onUserCreated
      ? {
          user: {
            create: {
              after: async (user: { id: string; email: string }) => {
                await config.hooks!.onUserCreated!(user);
              },
            },
          },
        }
      : undefined,
    socialProviders: config.socialProviders,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: buildPlugins(config) as any,
  });
};

export type TenantAuth = ReturnType<typeof createTenantAuth>;
