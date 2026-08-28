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
export * from "./order";
export * from "./phone";
export * from "./range";
export * from "./retirement";
export * from "./rollup";
export * from "./sequence";
export * from "./slug";
export * from "./transitions";
export * from "./url";
export * from "./schema-applier";
export * from "./schema-diff";
export * from "./permission";
export * from "./rls";
export * from "./migrations-manifest.generated";
/**
 * Types only, deliberately.
 *
 * `auto-migrate.ts` statically imports both migration bundles, and a bundle is
 * 259 `.sql` files inlined as text — 338 KiB the worker compiled at every cold
 * start because this line put it behind a specifier that ~80 files import. The
 * one caller (`apps/web/src/server/context.ts`) reaches the runtime through
 * `@backlex/db/auto-migrate`, inside the `if (!env.D1)` branch that already
 * gated it: on Cloudflare the migrations are applied by `wrangler d1 migrations
 * apply` during the build, so the worker never runs this at all.
 *
 * A type re-export is erased before the bundler sees it, so the convenience of
 * naming these from the package index costs nothing. Adding `ensureMigrations`
 * back here would quietly restore all 338 KiB.
 */
export type { AutoMigrateDb, MigrationOutcome } from "./auto-migrate";
