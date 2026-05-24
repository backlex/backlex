/**
 * Pre-bundles the Netlify Function entry so Netlify's bundler doesn't have
 * to walk our `.ts`-source workspace packages (which it can't transpile).
 *
 * - Source: `apps/web/src/server/entries/netlify-fn-entry.ts`
 * - Output: `apps/web/netlify/functions/api.mjs`
 *
 * Workspace `@workeros/*` deps are INLINED via Bun's bundler. npm deps stay
 * external — Netlify's nft bundler symlinks them from `apps/web/node_modules`
 * into the function zip, and Lambda resolves them at runtime.
 */
import { $ } from "bun";

const SOURCE = "apps/web/src/server/entries/netlify-fn-entry.ts";
const OUTPUT = "apps/web/netlify/functions/api.mjs";

// npm deps that should stay external. Workspace `@workeros/*` deliberately
// not in this list so Bun inlines their `.ts` source into the bundle.
const EXTERNAL = [
  "hono", "hono/*",
  "drizzle-orm", "drizzle-orm/*",
  "@neondatabase/serverless", "@neondatabase/*",
  "postgres",
  "better-auth", "better-auth/*", "@better-auth/*",
  "@hono/*",
  "@asteasolutions/zod-to-openapi",
  "samlify",
  "ldapts",
  "nodemailer",
  "@cf-wasm/*",
  "graphql", "graphql-yoga", "graphql/*",
  "aws4fetch",
  "zod",
  "cron-parser",
  "bun:sqlite",
  "@netlify/*",
  "xml-crypto",
  "xml2js",
  "xmldom",
  "@xmldom/*",
];

const externalArgs = EXTERNAL.flatMap((e) => ["--external", e]);

await $`bun build ${SOURCE} --target=node --format=esm --outfile=${OUTPUT} ${externalArgs}`;

console.log(`✓ Pre-bundled Netlify function → ${OUTPUT}`);
