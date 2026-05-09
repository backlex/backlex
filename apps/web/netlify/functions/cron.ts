/**
 * Netlify scheduled function — fires per `netlify.toml::[[scheduled_functions]]`.
 * Pings the Edge entry's `/api/_cron/tick` so the cron dedupe state lives
 * alongside the rest of the runtime, not split across function types.
 */
import type { Handler } from "@netlify/functions";

const handler: Handler = async () => {
  const base = process.env.URL ?? process.env.DEPLOY_URL ?? "";
  if (!base) {
    return { statusCode: 500, body: "URL env not set" };
  }
  const res = await fetch(`${base}/api/_cron/tick`);
  return {
    statusCode: res.ok ? 200 : 500,
    body: await res.text(),
  };
};

export { handler };
