export type Dialect = "pg" | "sqlite";

export const detectDialect = (env: { DATABASE_URL?: string; D1?: unknown }): Dialect => {
  if (env.D1) return "sqlite";
  if (env.DATABASE_URL) return "pg";
  return "pg";
};

export * from "./email";
export * from "./field-types";
export * from "./geo";
export * from "./money";
export * from "./phone";
export * from "./range";
export * from "./rollup";
export * from "./sequence";
export * from "./transitions";
export * from "./schema-applier";
export * from "./schema-diff";
export * from "./permission";
export * from "./migrations-manifest.generated";
export { ensureMigrations, type MigrationOutcome } from "./auto-migrate";
