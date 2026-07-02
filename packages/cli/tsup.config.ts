import { defineConfig } from "tsup";

// npm build for the `backlex` CLI. In the monorepo the bin runs straight from
// TypeScript via Bun (`bun backlex …`); for npm consumers we bundle the single
// entry `bin/backlex.ts` (which pulls in all of src/) into one Node-runnable
// ESM file with a shebang. `backlex` (the SDK) and `drizzle-orm` stay external —
// they're declared dependencies, installed alongside. `bun:sqlite` is imported
// lazily in migrate.ts so the bundle loads under Node; only `migrate` needs Bun.
export default defineConfig({
  entry: { backlex: "bin/backlex.ts" },
  format: ["esm"],
  target: "es2022",
  clean: true,
  treeshake: true,
  // `@backlex/migrate` is a workspace-source package (not published) — inline
  // it into the bundle. `postgres` stays external like the other declared deps.
  noExternal: ["@backlex/migrate"],
  // The `#!/usr/bin/env node` shebang on bin/backlex.ts carries through to the
  // bundle, so the output is directly executable (`./dist/backlex.js` / npx).
});
