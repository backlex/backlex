/**
 * Worker-build alias for `@backlex/db/pg`.
 *
 * The D1 (sqlite) instance never takes the Postgres code path at runtime —
 * `context.ts` selects the sqlite dialect whenever `env.D1` is bound, so every
 * `dialect === "pg" ? pg.schema.X : sqlite.schema.X` ternary resolves to the
 * sqlite branch. But the static `import * as pg from "@backlex/db/pg"` across
 * ~80 files would otherwise pull `pg/schema.ts` (one `pgTable(...)` per table)
 * and, through it, drizzle-orm's pg-core into the EAGER cold-start bundle.
 *
 * Re-point `schema` at the already-eager sqlite schema (the table NAMES match,
 * and the pg branches that read it never execute on D1) and make the client
 * factory throw. The source stays dual-dialect for self-host Postgres; only the
 * Workers build is aliased — same pattern as the bun:sqlite / postgres / neon /
 * nodemailer shims. `tsc` resolves the real package, so types are unaffected.
 */
export { schema } from "@backlex/db/sqlite";

export const createPgClient = (): never => {
  throw new Error(
    "Postgres driver is not bundled on the D1 Workers build (pg-shim).",
  );
};
