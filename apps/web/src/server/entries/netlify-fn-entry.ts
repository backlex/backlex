/**
 * Netlify Function (Node 22, v2 Web Standard) source entry.
 *
 * This file is the input for `scripts/build-netlify-fn.ts`, which pre-bundles
 * it into `apps/web/netlify/functions/api.mjs`. Pre-bundling is necessary
 * because Netlify's function bundler can't transpile our `.ts`-source
 * workspace packages (`@backlex/*`) — Bun's bundler inlines them and only
 * leaves npm deps external.
 *
 * The actual Hono app + cron route wiring lives in `./netlify.ts`.
 */
import type { Context } from "@netlify/functions";
import app from "./netlify";

// Mark the runtime at module load so server code (the image-transform router)
// can detect a Netlify Function reliably — `process.env.NETLIFY` isn't
// guaranteed in the function runtime. Runs at module eval, before any request.
(globalThis as { __BACKLEX_NETLIFY?: boolean }).__BACKLEX_NETLIFY = true;

export default async (req: Request, _context: Context): Promise<Response> =>
  app.fetch(req);
