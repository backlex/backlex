import type { Config } from "drizzle-kit";

export default {
  schema: "./src/pg/schema.ts",
  out: "./drizzle/pg",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/workeros",
  },
} satisfies Config;
