import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as pgSchema from "@workeros/db/pg/schema";
import * as sqliteSchema from "@workeros/db/sqlite/schema";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";

export interface AuthConfig {
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
}

const authSchemaFor = (provider: "pg" | "sqlite") => {
  const s = provider === "pg" ? pgSchema : sqliteSchema;
  return {
    user: s.users,
    session: s.sessions,
    account: s.accounts,
    verification: s.verifications,
  };
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
  });

export type Auth = ReturnType<typeof createAuth>;
