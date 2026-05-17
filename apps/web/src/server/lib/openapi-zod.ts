/**
 * Side-effect-only module: applies `extendZodWithOpenApi(z)` exactly once.
 *
 * Every `*.openapi.ts` metadata file imports this at the top so the
 * `.openapi(...)` chainable exists on `z.*` builders by the time the file
 * evaluates — regardless of whether the file is loaded statically (eager
 * SSR-graph traversal by vite's worker-runner during dev) or dynamically
 * (`loadMetadata()` at openapi-route runtime).
 *
 * The helper deliberately lives in its own module so the metadata files
 * don't have to import the heavier `lib/openapi.ts` (which pulls in the
 * registry + generator). Keeps the per-file dependency footprint tiny.
 */
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

let applied = false;
if (!applied) {
  extendZodWithOpenApi(z);
  applied = true;
}

export {};
