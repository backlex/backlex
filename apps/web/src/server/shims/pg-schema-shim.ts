/**
 * Worker-build alias for `@backlex/db/pg/schema` — see pg-shim.ts for the why.
 *
 * `packages/auth` does `import * as pgSchema from "@backlex/db/pg/schema"` (and
 * `authSchemaFor` picks pg vs sqlite at runtime). On D1 the pg branch never
 * runs, so re-export the sqlite schema: every table name resolves identically
 * without dragging `pg/schema.ts` (pgTable defs + drizzle-orm/pg-core) into the
 * eager bundle. `tsc` still resolves the real package, so types are unaffected.
 */
export * from "@backlex/db/sqlite/schema";
