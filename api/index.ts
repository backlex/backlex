// Vercel Edge Function — re-exports the Hono Vercel adapter. The actual
// runtime entry (env wiring, app construction, cron route) lives at
// apps/web/src/server/entries/vercel.ts so it stays next to the other
// per-runtime entries.
export { default, config } from "../apps/web/src/server/entries/vercel";
