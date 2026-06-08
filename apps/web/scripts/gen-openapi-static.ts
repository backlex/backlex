/**
 * Precompute the static half of the OpenAPI document at build time.
 *
 * The static spec (global registry + every sub-app's Zod schemas run through
 * `OpenApiGeneratorV31`) is deploy-constant — identical for every request and
 * every tenant — but costs ~5-6s of CPU to generate. Doing that at runtime is
 * fine on a long-lived process, but ruinous on Cloudflare: the REST Explorer's
 * `/api/openapi.json` is hit rarely, so it lands on cold isolates whose
 * in-memory cache is empty, paying the full generation on every open.
 *
 * This script runs as part of `bun run build` (before `vite build`) and writes
 * the generated doc to `openapi-static.generated.json`, which the worker bundle
 * imports. At runtime `buildOpenApiDoc` merges only the per-tenant dynamic
 * collection paths on top — so new collections still appear instantly while the
 * expensive static part costs nothing.
 *
 * `servers` (the only request-varying field) is omitted here and injected per
 * request.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticDoc } from "../src/server/lib/openapi";
import { SUBAPPS } from "../src/server/routes/openapi";
import { loadMetadata } from "../src/server/routes/openapi-metadata";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/server/lib/openapi-static.generated.json",
);

const main = async (): Promise<void> => {
  // Populate the global registry's lazily-loaded sibling metadata first.
  await loadMetadata();
  const doc = buildStaticDoc({ subApps: SUBAPPS });
  const pathCount = Object.keys((doc.paths ?? {}) as Record<string, unknown>).length;
  if (pathCount === 0) {
    throw new Error("[gen-openapi-static] generated doc has no paths — aborting");
  }
  writeFileSync(OUT, `${JSON.stringify(doc)}\n`);
  console.log(`[gen-openapi-static] wrote ${pathCount} static paths → ${OUT}`);
};

await main();
