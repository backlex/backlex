import type { Env } from "../env";

/**
 * Opt-in observability reporting to the workeros **cloud** control plane.
 *
 * This is a NO-OP unless the cloud provisioner injected `CLOUD_REPORT_SECRET` +
 * `CLOUD_PROJECT_ID` plus a delivery channel. Self-hosted / OSS installs never
 * set these, so nothing is ever sent — no phone-home.
 *
 * Delivery channel, in order of preference:
 *  1. `CLOUD_REPORT_SERVICE` — a Service Binding to the control-plane worker.
 *     Required on Workers for Platforms: a provisioned tenant runs *inside* the
 *     dispatch namespace, so a plain `fetch()` to the control plane's public
 *     hostname loops back into the dispatcher and is dropped (HTTP 522). A
 *     service binding calls the worker directly, bypassing the public route.
 *  2. `CLOUD_REPORT_URL` — plain HTTPS POST. Used by non-WfP managed deploys
 *     where no loopback exists.
 *
 * Either way it HMAC-SHA256-signs the JSON body with the per-project secret and
 * fire-and-forget POSTs it to the control plane's `/api/webhooks/tenant-report`.
 */
export type CloudReport =
  | { kind: "error"; message: string; route?: string; status?: number }
  | { kind: "ai_usage"; tokensIn?: number; tokensOut?: number; neurons?: number };

const hmacHex = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Returns the fetch promise (caller can keepAlive it), or undefined if disabled. */
export function reportToCloud(env: Env | undefined, report: CloudReport): Promise<unknown> | undefined {
  if (!env) return undefined;
  const secret = env.CLOUD_REPORT_SECRET;
  const projectId = env.CLOUD_PROJECT_ID;
  if (!secret || !projectId) return undefined;

  const service = env.CLOUD_REPORT_SERVICE;
  const url = env.CLOUD_REPORT_URL;
  if (!service && !url) return undefined;

  const body = JSON.stringify(report);
  // Service bindings ignore the request hostname (they target the bound worker
  // directly), so a placeholder origin is fine; only the path is meaningful.
  const base = service ? "https://cloud-report.internal" : (url as string).replace(/\/$/, "");
  const target = `${base}/api/webhooks/tenant-report`;

  return hmacHex(secret, body)
    .then((sig) => {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Backlex-Project": projectId,
          "X-Backlex-Signature": sig,
        },
        body,
      };
      return service ? service.fetch(new Request(target, init)) : fetch(target, init);
    })
    .catch(() => undefined);
}
