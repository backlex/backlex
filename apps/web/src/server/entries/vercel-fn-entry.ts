/**
 * Vercel Function (Node 22) source entry, pre-bundled by
 * `scripts/build-vercel-fn.ts` into `api/index.mjs`.
 *
 * Pre-bundling is necessary because Vercel's function bundler can't
 * transpile our `.ts` workspace package sources (same issue Netlify
 * Functions hits — `Cannot find module entries/vercel` at Lambda
 * runtime). Bun inlines the workspace tree before Vercel sees it.
 *
 * The Hono app + cron route wiring live in `./vercel.ts`.
 */
import app from "./vercel";

export default async (req: Request): Promise<Response> => app.fetch(req);
