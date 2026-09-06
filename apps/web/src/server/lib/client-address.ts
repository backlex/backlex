/**
 * The one place that answers "which address is this request from".
 *
 * Every IP-keyed limiter in the app used to answer it for itself, and all
 * eleven copies answered it the same wrong way:
 *
 *     cf-connecting-ip || x-real-ip || x-forwarded-for.split(",")[0]
 *
 * `cf-connecting-ip` is set by Cloudflare and, on Cloudflare, cannot be forged —
 * the edge overwrites whatever the client sent. Off Cloudflare nothing sets it
 * and nothing strips it, so on the Bun/Node self-host and on the Vercel and
 * Netlify entries this repo also ships, the value is simply what the caller
 * typed. A fresh value per request is a fresh bucket per request, which is not a
 * rate limit at all: the 10/min sign-in cap, the 5/min sign-up, forget-password,
 * magic-link and verify-email caps, and every unauthenticated public limiter
 * (forms, booking, analytics, inbound hooks, payments, public dashboards,
 * webhook triggers, consent, realtime, MCP) were void on three of the four
 * targets. `services/consent-records.ts` already carried a comment saying so.
 *
 * The first XFF hop is the same mistake in a second costume. `x-forwarded-for`
 * grows left-to-right as it crosses proxies, so element [0] is the value the
 * ORIGINAL client sent — attacker-controlled even on a correctly configured
 * reverse proxy. The trustworthy end is the right.
 *
 * So the rule here is: a header is read only where something the operator
 * controls is known to have written it.
 *
 *   1. `TRUSTED_PROXY_HEADER` names the header the deployment's own proxy sets.
 *      This is the self-host answer, and it is opt-in because only the operator
 *      knows whether there is a proxy and what it writes.
 *   2. Otherwise the platform's own header, on the platforms that set one and
 *      strip the inbound copy: Cloudflare, Vercel, Netlify.
 *   3. Otherwise `null`. A direct-to-Bun deployment has no trustworthy header,
 *      and answering `null` is the honest result — the limiter then falls back
 *      to its own shared bucket, which is a real (if blunt) limit, where a
 *      forged value was no limit whatsoever.
 *
 * Deliberately NOT a module-level cached decision, even though the answer is
 * the same for every request in an isolate: the test suite builds many apps
 * with different envs in one process, and a cached first answer would leak
 * across them.
 */
import {
  isCloudflareWorkers,
  isNetlify,
  isNetlifyEdge,
  isVercel,
} from "./runtime";

/** The env this needs. A structural subset of `Env` so callers that only hold a
 *  narrower object (and the specs) can still pass one. */
export interface ClientAddressEnv {
  TRUSTED_PROXY_HEADER?: string | undefined;
}

/** Header a platform sets itself and strips from the inbound request. Ordered:
 *  the platform-specific one first, then the generic one that platform's proxy
 *  also writes. */
const platformHeaders = (): readonly string[] => {
  if (isCloudflareWorkers()) return ["cf-connecting-ip"];
  // Vercel strips inbound `x-vercel-*`, so that one is the unforgeable half;
  // `x-real-ip` is set by the same proxy and kept as the documented fallback.
  if (isVercel()) return ["x-vercel-forwarded-for", "x-real-ip"];
  if (isNetlify() || isNetlifyEdge()) return ["x-nf-client-connection-ip", "x-real-ip"];
  return [];
};

/**
 * Last hop of a possibly comma-separated forwarding header.
 *
 * A single-value header (`x-real-ip`, `cf-connecting-ip`) has one element and
 * is returned as-is. A list (`x-forwarded-for`) is read from the RIGHT, because
 * that is the end the nearest proxy appended; the left end is whatever the
 * original client claimed. This assumes ONE trusted proxy in front of the app,
 * which is what `TRUSTED_PROXY_HEADER` is documented to mean.
 */
const lastHop = (raw: string): string | null => {
  const parts = raw.split(",");
  for (let i = parts.length - 1; i >= 0; i--) {
    const v = parts[i]?.trim();
    if (v) return v;
  }
  return null;
};

/**
 * The client address, or `null` when nothing on this deployment is entitled to
 * state one. Never falls back to a client-supplied header.
 */
export const clientAddress = (req: Request, env: ClientAddressEnv): string | null => {
  const configured = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (configured) {
    const raw = req.headers.get(configured);
    return raw ? lastHop(raw) : null;
  }
  for (const name of platformHeaders()) {
    const raw = req.headers.get(name);
    const v = raw ? lastHop(raw) : null;
    if (v) return v;
  }
  return null;
};

/**
 * The same answer as a limiter-key fragment: `null` collapses to one shared
 * bucket rather than to a per-request one.
 *
 * Every limiter already spelled `ip ?? "unknown"` at its call site; naming it
 * once means a future limiter cannot accidentally spell it `ip ?? crypto
 * .randomUUID()` and re-open the hole in a way that reads as defensive.
 */
export const clientAddressKey = (req: Request, env: ClientAddressEnv): string =>
  clientAddress(req, env) ?? "unknown";
