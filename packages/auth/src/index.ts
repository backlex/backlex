import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";
import { emailOTP } from "better-auth/plugins/email-otp";
import { anonymous } from "better-auth/plugins/anonymous";
import { passkey } from "@better-auth/passkey";
import type { EmailAdapter } from "@backlex/core";
import * as pgSchema from "@backlex/db/pg/schema";
import * as sqliteSchema from "@backlex/db/sqlite/schema";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";

export interface AuthHooks {
  /** Runs before a user row is created (any sign-up path: email/password,
   *  social, magic-link, anonymous). Return `{ allow: false }` to reject the
   *  sign-up — the auth handler turns it into a 403 with `reason` as message. */
  onBeforeUserCreated?: () =>
    | Promise<{ allow: boolean; reason?: string }>
    | { allow: boolean; reason?: string };
  onUserCreated?: (user: { id: string; email: string }) => Promise<void> | void;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export type AuthPlugin = "magic-link" | "email-otp" | "anonymous" | "passkey";

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
}

const authSchemaFor = (provider: "pg" | "sqlite") => {
  const s = provider === "pg" ? pgSchema : sqliteSchema;
  return {
    user: s.users,
    session: s.sessions,
    account: s.accounts,
    verification: s.verifications,
    passkey: s.passkeys,
  };
};

const buildPlugins = (config: AuthConfig) => {
  const out: ReturnType<typeof magicLink>[] = [];
  // Always on: lets native/mobile admin clients authenticate with
  // `Authorization: Bearer <session-token>` instead of a cookie. The session
  // row is identical either way — header vs cookie is the only difference, so
  // browser cookie auth is unaffected.
  out.push(bearer() as unknown as ReturnType<typeof magicLink>);
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
  if (enabled.has("passkey")) {
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

export const createAuth = (
  db: PgDb | SqliteDb,
  provider: "pg" | "sqlite",
  config: AuthConfig,
) =>
  betterAuth({
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
                subject: "Reset your workeros password",
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
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
      // Sign the session payload into the cookie and skip the DB lookup for
      // the next 60s. Cuts ~1 D1 round-trip off every authenticated request;
      // sign-out / session revocation still works because better-auth invalidates
      // the cache on its own sign-out paths.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    databaseHooks:
      config.hooks?.onUserCreated || config.hooks?.onBeforeUserCreated
        ? {
            user: {
              create: {
                ...(config.hooks?.onBeforeUserCreated
                  ? {
                      before: async () => {
                        const r = await config.hooks!.onBeforeUserCreated!();
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
        : undefined,
    socialProviders: config.socialProviders,
    plugins: buildPlugins(config),
  });

export type Auth = ReturnType<typeof createAuth>;

export { createTenantAuth, type TenantAuth, type TenantAuthConfig } from "./tenant";
export { withTenantScope } from "./tenant-adapter";
