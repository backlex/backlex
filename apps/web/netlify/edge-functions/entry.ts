// Netlify edge function — delegates to the Hono app exported by the
// per-platform Netlify entry. Using `app.fetch(req)` directly avoids
// the `hono/netlify` adapter subpath, which Netlify's edge npm
// resolver currently can't load.
import app from "../../src/server/entries/netlify.ts";

export default async (request: Request): Promise<Response> => app.fetch(request);

export const config = { path: "/api/*" };
