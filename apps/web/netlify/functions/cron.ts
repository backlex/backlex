/**
 * Netlify scheduled function — fires per `netlify.toml::[[scheduled_functions]]`.
 * Pings the API function's `/api/_cron/tick` so the cron dedupe state lives
 * alongside the rest of the runtime, not split across function types. Sends
 * `x-cron-secret` from `CRON_SECRET`; without it the route 401s and the
 * tick is silently dropped, so we fail loudly here instead.
 *
 * Uses Netlify Functions v2 (Web Standard handler). The whole `functions/`
 * directory shares a runtime detection pass, so mixing v1 (`export const
 * handler`) with v2 (`export default`) made the entire dir get wrapped as
 * v1 — which broke our API's `export default` shape.
 */
export default async (): Promise<Response> => {
  const base = process.env.URL ?? process.env.DEPLOY_URL ?? "";
  if (!base) {
    return new Response("URL env not set", { status: 500 });
  }
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    return new Response("CRON_SECRET env not set", { status: 500 });
  }
  const res = await fetch(`${base}/api/_cron/tick`, {
    headers: { "x-cron-secret": secret },
  });
  return new Response(await res.text(), {
    status: res.ok ? 200 : 500,
  });
};
