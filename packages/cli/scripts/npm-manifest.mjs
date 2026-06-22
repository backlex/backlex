// CI-only: rewrite package.json to publish the compiled dist/ to npm.
//
// The committed package.json points `bin` at bin/backlex.ts and keeps the SDK
// (`backlex`) as a workspace devDependency so the monorepo runs the CLI straight
// from source (CLAUDE.md invariant). Right before `npm publish`, the publish
// workflow runs `tsup` (→ dist/, with the SDK bundled in) + copies the SQLite
// migrations (→ drizzle/), then this script swaps `bin` to the compiled output.
// The only runtime dependency left is drizzle-orm (used by the Bun-only
// `migrate`). The mutation is ephemeral (CI checkout) — don't run it on a tree
// you intend to keep.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(path, "utf8"));

pkg.bin = { backlex: "./dist/backlex.js" };
pkg.files = ["dist", "drizzle", "README.md", "LICENSE"];
// Build-only tooling (incl. the bundled-in SDK) — consumers never need it.
delete pkg.scripts;
delete pkg.devDependencies;

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("package.json rewritten for npm (compiled dist) publish");
