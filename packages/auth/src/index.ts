import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { emailOTP } from "better-auth/plugins/email-otp";
import { anonymous } from "better-auth/plugins/anonymous";
import { passkey } from "@better-auth/passkey";
import type { EmailAdapter } from "@workeros/core";
import * as pgSchema from "@workeros/db/pg/schema";
import * as sqliteSchema from "@workeros/db/sqlite/schema";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";

export interface AuthHooks {
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
        rpName: "workeros",
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
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
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
    plugins: buildPlugins(config),
  });

export type Auth = ReturnType<typeof createAuth>;
