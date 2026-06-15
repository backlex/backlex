/**
 * Serve the pre-built admin SPA (vite `dist/client`) from the Hono app on the
 * self-host runtimes (Bun / Node / Deno self-host + Deno Deploy). On Cloudflare
 * Workers the SPA is served by the Static Assets binding (`wrangler.toml
 * [assets]`) instead, so `mountSpa` is never called from `worker.ts`.
 *
 * Each entry passes its runtime's `serveStatic` (`hono/bun`, `hono/deno`, or
 * `@hono/node-server/serve-static`) — they share the `{ root, path }` option
 * shape. `root` is resolved relative to the process CWD: the repo root for a
 * plain `deno run` / `node` / `bun`, and `/tmp/build/src` on Deno Deploy (where
 * the uploaded working tree, including a pre-built `dist/client`, lands).
 *
 * Mounted AFTER every `/api` route in `createApp`, so real routes always win;
 * only unmatched GETs fall through to a static file, with an `index.html`
 * fallback so client-side (React Router) routes resolve. API-ish prefixes are
 * skipped so an unknown `/api/*` still returns the JSON 404 from the app rather
 * than the SPA shell.
 */
import type { Hono } from "hono";
import type { Env as HonoEnv, Schema } from "hono/types";

type ServeStatic = (options: {
  root?: string;
  path?: string;
}) => (c: never, next: () => Promise<void>) => Promise<Response | void>;

const SKIP_PREFIXES = ["/api", "/health", "/mcp"];

const isApiPath = (path: string): boolean =>
  SKIP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

export function mountSpa<E extends HonoEnv, S extends Schema, P extends string>(
  app: Hono<E, S, P>,
  serveStatic: ServeStatic,
  root = "apps/web/dist/client",
): void {
  const files = serveStatic({ root });
  const shell = serveStatic({ path: `${root}/index.html` });

  // Static assets (JS/CSS/img) first; falls through to `next()` when missing.
  app.use("/*", async (c, next) =>
    isApiPath(c.req.path) ? next() : files(c as never, next),
  );
  // SPA fallback: any remaining GET serves index.html for client-side routing.
  app.get("/*", async (c, next) =>
    isApiPath(c.req.path) ? next() : shell(c as never, next),
  );
}
