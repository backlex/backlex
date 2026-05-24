/**
 * Netlify Function (Node 22) — API surface for the workeros admin.
 *
 * Uses Netlify Functions v2 (Web Standard handler). The Hono app is
 * already a `(Request) => Response` handler, so we forward directly
 * with `app.fetch(req)` — no Lambda adapter needed.
 *
 * Routing: `netlify.toml` rewrites `/api/*` to `/.netlify/functions/api/:splat`.
 */
import type { Context } from "@netlify/functions";
import app from "../../src/server/entries/netlify";

export default async (req: Request, _context: Context): Promise<Response> =>
  app.fetch(req);
