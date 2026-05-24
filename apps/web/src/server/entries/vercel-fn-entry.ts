/**
 * Vercel Function source entry, pre-bundled by
 * `scripts/build-vercel-fn.ts` into `api/index.mjs`.
 *
 * Three constraints stacked on top of each other:
 *
 * 1. Pre-bundling — Vercel's function bundler can't transpile our
 *    `.ts`-source workspace packages (same issue Netlify Functions hits
 *    without pre-bundling). Bun inlines the workspace tree first.
 *
 * 2. Handler shape — Vercel Node runtime treats `export default function`
 *    as the legacy Express signature `(IncomingMessage, ServerResponse)`,
 *    which Hono can't consume. The Web Standard shape
 *    `export default { fetch(request: Request): Response }` opts into the
 *    modern path where Vercel passes a real Web `Request`. Hono's
 *    `app.fetch` matches that contract exactly.
 *
 * 3. URL reconstruction — Vercel's "Other Frameworks" filesystem routing
 *    only matches literal filenames (no `[...slug]` outside Next.js), so
 *    `vercel.ts::rewrites` funnels every `/api/*` path through this
 *    single file at `/api/index?__path=<captured-rest>`. By the time the
 *    request lands in the function, `request.url.pathname` is
 *    `/api/index` — Hono's router would route that as the literal path
 *    and miss every real route. We rebuild the URL from `__path` so Hono
 *    sees the original `/api/auth/get-session` etc.
 */
import app from "./vercel";

export default {
  fetch: (request: Request) => {
    const url = new URL(request.url);
    const path = url.searchParams.get("__path");
    if (path !== null) {
      url.pathname = `/api/${path}`;
      url.searchParams.delete("__path");
      // Re-wrap with the corrected URL. Pass the original request as init
      // so method/headers/body/signal are preserved; the Web Standard
      // Request constructor accepts another Request as its second arg.
      return app.fetch(new Request(url.toString(), request));
    }
    return app.fetch(request);
  },
};
