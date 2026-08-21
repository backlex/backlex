/**
 * The public consent-config endpoint.
 *
 * A banner running on a customer's own domain asks this what to show: which
 * categories to offer, what to do before the visitor answers, the wording, and
 * the hash that identifies the artifact so the visitor's recorded decision can
 * point at something immutable.
 *
 * A plain `Hono` sub-app rather than an `OpenAPIHono` one, the same call
 * `analytics-collect.ts` makes: there is no JSON request body to describe, the
 * caller is a browser on somebody else's origin rather than an API consumer,
 * and the admin half of consent is already documented on `routes/consent.ts`.
 *
 * ── Its own mount, not a route on the collect sub-app ─────────────────────
 * The obvious-looking home was `analyticsCollectRoutes`, since it is already
 * public, already exempt from CORS and already serves cached artifacts. It
 * cannot be: that sub-app is mounted at `/api/analytics`, so nothing inside it
 * can ever answer `/api/consent/config`. Serving the consent artifact from an
 * `/api/analytics/*` path instead would tie a compliance surface to the
 * analytics product's URL space — and a site can run a banner while using
 * somebody else's analytics.
 *
 * ── Why it opts out of the credentialed CORS policy ───────────────────────
 * Identical to the collect route's reasoning: the app's `cors()` is
 * credentialed with an origin allowlist, and a customer's domain is not on it.
 * This answers `Access-Control-Allow-Origin: *` WITHOUT credentials. That is
 * safe here for a stronger reason than it is there — this route is READ-ONLY
 * and returns only what the operator publishes to their own visitors. It reads
 * no session, and the projection behind it names its columns explicitly so the
 * site's operator settings cannot reach the body.
 *
 * ── What it deliberately does not have ────────────────────────────────────
 * No `.options()` handler. A preflight would only be needed if the caller set
 * a non-safelisted request header, and the only candidate is `If-None-Match` —
 * which means the 304 path works through the browser's own cache revalidation
 * on a plain `fetch`, and an author-set `If-None-Match` would trade a 304 for
 * an extra round-trip that then fails. The banner must not set it by hand.
 */
import { Hono } from "hono";
import type { AppBindings } from "../app";
import { ifNoneMatch, weakETag } from "../lib/etag";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { CONSENT_CONFIG_OFF, getPublishedConsentConfig } from "../services/consent";
import { getConsentEntry, setConsentEntry } from "../services/consent-config-cache";

/**
 * Per-IP budget.
 *
 * Generous for the same reason the collect route's is: this key is shared by
 * everyone behind one NAT, so a budget tuned for a single browser would drop
 * real visitors behind an office or a mobile carrier gateway. A banner asks
 * once per page load and the answer is cached for five minutes, so a legitimate
 * client is nowhere near this.
 */
const MAX_PER_IP_PER_MINUTE = 600;
const WINDOW_MS = 60_000;

/**
 * Five minutes. Short enough that a wording fix reaches visitors the same
 * session, long enough that a busy site is not re-fetching a static document on
 * every page view. `must-revalidate` is deliberately absent, matching the
 * container route: the ETag already gives a cheap revalidation, and forcing one
 * before expiry would put a round-trip in front of a banner on every navigation.
 */
const MAX_AGE = 300;

/** Answered on every response, including the 429 — see the handler. */
const CORS = { "Access-Control-Allow-Origin": "*" } as const;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": `public, max-age=${MAX_AGE}`,
  ...CORS,
} as const;

/**
 * Nothing to show: no policy, switched off, unknown site, or a site deleted out
 * from under its policy. All four answer identically — see `CONSENT_CONFIG_OFF`.
 * No ETag, so flipping `enabled` back on is not pinned behind a 304 the browser
 * would keep revalidating into.
 *
 * Built as a bare `Response` rather than through the context, because it
 * depends on nothing in the request — which is the same reason all four cases
 * can share one body.
 */
const off = (): Response =>
  new Response(CONSENT_CONFIG_OFF, { status: 200, headers: { ...HEADERS } });

export const consentPublicRoutes = new Hono<AppBindings>().get("/config", async (c) => {
  const ctx = c.get("ctx");
  const ip = requestMeta(c.req.raw).ip ?? "unknown";

  // Before the site is even looked at, so an unauthenticated caller cannot
  // drive one database read per request by sending random ids. Returned rather
  // than thrown: the error middleware sets no CORS headers, so a thrown 429
  // would reach the banner as an opaque CORS failure instead of a throttle it
  // could read and back off from.
  if (!(await rateLimitOk(ctx.env, `consent-config-ip:${ip}`, MAX_PER_IP_PER_MINUTE, WINDOW_MS))) {
    return c.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests from this address." } },
      429,
      CORS,
    );
  }

  const siteId = (c.req.query("s") ?? "").trim().slice(0, 64);
  if (!siteId) return off();

  const now = Date.now();
  let hit = getConsentEntry(siteId, now);
  if (!hit) {
    const published = await getPublishedConsentConfig(
      { db: ctx.db, dialect: ctx.dialect },
      siteId,
    );
    if (!published) return off();
    hit = { at: now, body: published.body, hash: published.hash, tenantId: published.tenantId };
    setConsentEntry(siteId, hit);
  }

  // The site resolves the workspace — this request carries no other credential
  // — so metering is attributed from here, on the cache-hit path as well as the
  // miss. Without it an anonymous fetch bills whichever workspace the tenant
  // middleware happened to resolve, which is the DEFAULT one, and the owning
  // workspace's public traffic sits outside its own quota. That exact defect is
  // pinned as a regression for the other public routes.
  if (hit.tenantId) setMeterTenant(c, hit.tenantId);

  const etag = weakETag([hit.hash]);
  const headers = { ...HEADERS, ETag: etag };
  // `c.body` does no conditional handling of its own, so the 304 is explicit.
  if (ifNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, headers);
  }
  return c.body(hit.body, 200, headers);
});
