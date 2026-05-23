/**
 * Netlify scheduled function — fires per `netlify.toml::[[scheduled_functions]]`.
 * Pings the Edge entry's `/api/_cron/tick` so the cron dedupe state lives
 * alongside the rest of the runtime, not split across function types. Sends
 * `x-cron-secret` from `CRON_SECRET`; without it the edge route 401s and the
 * tick is silently dropped, so we fail loudly here instead.
 */
import type { Handler } from "@netlify/functions";

const handler: Handler = async () => {
  const base = process.env.URL ?? process.env.DEPLOY_URL ?? "";
  if (!base) {
    return { statusCode: 500, body: "URL env not set" };
  }
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    return { statusCode: 500, body: "CRON_SECRET env not set" };
  }
  const res = await fetch(`${base}/api/_cron/tick`, {
    headers: { "x-cron-secret": secret },
  });
  return {
    statusCode: res.ok ? 200 : 500,
    body: await res.text(),
  };
};

export { handler };
