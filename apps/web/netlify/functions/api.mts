/**
 * Netlify Function (Node 22, v2 Web Standard) — API surface.
 *
 * Loads the Hono app lazily via dynamic import so that any module-load
 * failure surfaces as a 500 with the error in the response body — much
 * easier to debug than the runtime's "y.handler is not a function"
 * fallback. Once the load succeeds it's cached per Lambda instance.
 */
import type { Context } from "@netlify/functions";

let cachedApp: { fetch: (req: Request) => Promise<Response> } | null = null;
let cachedLoadError: { message: string; stack: string } | null = null;

const getApp = async () => {
  if (cachedApp) return cachedApp;
  try {
    const mod = await import("../../src/server/entries/netlify");
    cachedApp = mod.default as typeof cachedApp;
    return cachedApp;
  } catch (e: unknown) {
    const err = e as Error;
    cachedLoadError = {
      message: String(err?.message ?? e),
      stack: String(err?.stack ?? "").slice(0, 1500),
    };
    return null;
  }
};

export default async (req: Request, _context: Context): Promise<Response> => {
  const app = await getApp();
  if (!app) {
    return new Response(
      JSON.stringify({
        error: "module_load_failed",
        ...cachedLoadError,
        env_present: {
          AUTH_SECRET: !!process.env.AUTH_SECRET,
          DATABASE_URL: !!process.env.DATABASE_URL,
          DATABASE_DRIVER: process.env.DATABASE_DRIVER,
          S3_BUCKET: !!process.env.S3_BUCKET,
          node_version: process.version,
        },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  return app.fetch(req);
};
