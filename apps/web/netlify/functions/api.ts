/**
 * Netlify Function (Node 22) — API surface for the workeros admin.
 *
 * Uses Netlify's Web Standard handler signature (the modern recommendation
 * from https://docs.netlify.com/build/functions/get-started/?data-tab=TypeScript)
 * so the underlying Hono app — already a `(Request) => Response` handler —
 * can be invoked directly with `app.fetch(req)`. No Lambda adapter required.
 *
 * Routing: `netlify.toml` rewrites `/api/*` to `/.netlify/functions/api/:splat`,
 * so request URLs reach Hono with their original `/api/...` path and match
 * the existing route tree.
 *
 * Edge Functions were dropped because Netlify's Deno edge bundler can't
 * resolve this repo's npm/workspace dep tree (postgres-js node builtins,
 * @cf-wasm/quickjs WASM, samlify, etc.). Node 22 runs the existing
 * source unchanged.
 */
import type { Context } from "@netlify/functions";
import app from "../../src/server/entries/netlify";

export default async (req: Request, _context: Context): Promise<Response> =>
  app.fetch(req);
