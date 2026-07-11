import type { VercelConfig } from "@vercel/config/v1";

/**
 * Routing, functions, and crons all live in `.vercel/output/config.json`
 * — emitted by `scripts/build-vercel-output.ts` as part of the build.
 * See that script for the why (Vercel's zero-config function discovery
 * runs before `buildCommand`, so anything we generate post-install is
 * invisible; the Build Output API bypasses discovery entirely).
 *
 * Here we only configure the install + build steps. `outputDirectory`
 * is omitted on purpose — when `.vercel/output/` exists, Vercel uses
 * it verbatim regardless of any `outputDirectory` setting.
 */
export const config: VercelConfig = {
  framework: null,
  installCommand: "bun install --frozen-lockfile",
  buildCommand:
    "DEPLOY_TARGET=vercel bun run --cwd apps/web build && bun scripts/build-vercel-output.ts",
};
