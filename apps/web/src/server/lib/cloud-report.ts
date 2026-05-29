import type { Env } from "../env";

/**
 * Opt-in observability reporting to the workeros **cloud** control plane.
 *
 * This is a NO-OP unless the cloud provisioner injected `CLOUD_REPORT_URL` +
 * `CLOUD_REPORT_SECRET` + `CLOUD_PROJECT_ID` into the worker. Self-hosted /
 * OSS installs never set these, so nothing is ever sent — no phone-home.
 *
 * When enabled, it HMAC-SHA256-signs the JSON body with the per-project secret
 * and fire-and-forget POSTs it to the control plane's `/api/webhooks/tenant-report`.
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
  const url = env.CLOUD_REPORT_URL;
  const secret = env.CLOUD_REPORT_SECRET;
  const projectId = env.CLOUD_PROJECT_ID;
  if (!url || !secret || !projectId) return undefined;
  const body = JSON.stringify(report);
  return hmacHex(secret, body)
    .then((sig) =>
      fetch(`${url.replace(/\/$/, "")}/api/webhooks/tenant-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Backlex-Project": projectId,
          "X-Backlex-Signature": sig,
        },
        body,
      }),
    )
    .catch(() => undefined);
}
