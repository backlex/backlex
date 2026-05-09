export type Dialect = "pg" | "sqlite";

export const detectDialect = (env: { DATABASE_URL?: string; D1?: unknown }): Dialect => {
  if (env.D1) return "sqlite";
  if (env.DATABASE_URL) return "pg";
  return "pg";
};

export * from "./field-types";
export * from "./schema-applier";
export * from "./permission";
