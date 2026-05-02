import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";

export interface AuthConfig {
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
}

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
    advanced: {
      generateId: () => crypto.randomUUID(),
    },
  });

export type Auth = ReturnType<typeof createAuth>;
