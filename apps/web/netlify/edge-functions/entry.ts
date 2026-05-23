// Netlify edge function shim — re-exports the Hono Netlify adapter entry.
// Keeps the per-platform entries in `apps/web/src/server/entries/netlify.ts`
// so the runtime-agnostic core stays in one place.
export { default } from "../../src/server/entries/netlify.ts";

export const config = { path: "/api/*" };
