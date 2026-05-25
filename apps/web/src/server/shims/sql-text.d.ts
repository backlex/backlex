/**
 * Bun's `import "./foo.sql" with { type: "text" }` resolves to a string at
 * runtime — TS needs the ambient declaration to type the import. Mirrors
 * `packages/db/src/sql.d.ts` so the migration-bundle imports from
 * `packages/db/src/{pg,sqlite}/migrations-bundle.ts` typecheck cleanly
 * under apps/web too.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
