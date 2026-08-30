// CI-only: rewrite package.json to publish the compiled dist/ to npm.
//
// The committed package.json points main/types/exports at src/ so the monorepo
// consumes TypeScript source with no build step (CLAUDE.md invariant). Right
// before `npm publish`, the publish workflow runs `tsup` then this script to
// swap those fields to the compiled dist/ output. The mutation is ephemeral
// (CI checkout) — do not run it on a working tree you intend to keep.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(path, "utf8"));

pkg.main = "./dist/index.js";
pkg.types = "./dist/index.d.ts";
// Every subpath the source package declares must appear here, or it simply
// does not resolve for npm consumers — `./token` was missing, so the
// `backlex/token` import documented in docs/auth-planes.md failed for everyone
// installing from npm while working fine in the monorepo and on JSR. Kept in
// agreement with package.json / jsr.json / tsup.config.ts by
// `apps/web/tests/sdk-exports.test.ts`.
pkg.exports = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  "./types": { types: "./dist/types.d.ts", default: "./dist/types.js" },
  "./webhook": { types: "./dist/webhook.d.ts", default: "./dist/webhook.js" },
  "./token": { types: "./dist/token.d.ts", default: "./dist/token.js" },
  "./react": { types: "./dist/react.d.ts", default: "./dist/react.js" },
};
pkg.files = ["dist", "README.md", "LICENSE", "skills"];
// Build-only tooling — consumers never need it.
delete pkg.scripts;
delete pkg.devDependencies;

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("package.json rewritten for npm (compiled dist) publish");
