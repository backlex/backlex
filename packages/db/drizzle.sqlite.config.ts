import type { Config } from "drizzle-kit";

export default {
  schema: "./src/sqlite/schema.ts",
  out: "./drizzle/sqlite",
  dialect: "sqlite",
  driver: "d1-http",
} satisfies Config;
