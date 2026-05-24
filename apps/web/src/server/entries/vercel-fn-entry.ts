/**
 * Vercel Function source entry, pre-bundled by
 * `scripts/build-vercel-fn.ts` into `api/[...all].mjs`.
 *
 * Two things matter here:
 *
 * 1. Pre-bundling — Vercel's function bundler can't transpile our
 *    `.ts`-source workspace packages (same issue Netlify Functions hits
 *    without pre-bundling). Bun inlines the workspace tree before Vercel
 *    sees it.
 *
 * 2. Handler shape — Vercel Node runtime treats `export default function`
 *    as the legacy Express signature `(IncomingMessage, ServerResponse)`,
 *    which Hono can't consume. The Web Standard shape `export default
 *    { fetch(request: Request): Response }` opts into the modern path
 *    where Vercel passes a real Web `Request`. Hono's `app.fetch` matches
 *    that contract exactly.
 */
import app from "./vercel";

export default {
  fetch: (request: Request) => app.fetch(request),
};
