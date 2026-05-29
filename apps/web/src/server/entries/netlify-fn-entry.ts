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

export default async (req: Request, _context: Context): Promise<Response> =>
  app.fetch(req);
