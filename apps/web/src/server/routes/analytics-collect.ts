/**
 * The public collect endpoint for the web tag, and the tag itself.
 *
 * This is a plain `Hono` sub-app rather than an `OpenAPIHono` one because
 * neither route has a JSON request body to describe: `/collect` accepts
 * `text/plain` on purpose, and `/script.js` returns JavaScript.
 *
 * ── Why this cannot reuse `POST /api/analytics/events` ────────────────────
 * Four separate blockers, each fatal on its own:
 *
 *  1. The app's CORS middleware is credentialed with an origin allowlist
 *     (`app.ts`, fed by `services/cors-origins.ts`). A customer's site is not
 *     on it, and adding every customer domain to a credentialed allowlist is
 *     not something we want to be true.
 *  2. `navigator.sendBeacon` cannot set request headers, but the ingest key is
 *     read only from `x-backlex-ingest-key`.
 *  3. Any custom header or JSON content-type triggers a CORS preflight, and a
 *     beacon fired during page unload does not get a second round-trip.
 *  4. `EventInput.distinctId` is required, and a cookieless tag has none — the
 *     server derives it.
 *
 * So this route opts out of the credentialed CORS middleware and answers
 * `Access-Control-Allow-Origin: *` WITHOUT credentials, exactly the carve-out
 * `/.well-known/*` already takes. That is safe here precisely because the
 * route is append-only and can never read a row back.
 *
 * ── What replaces the origin check ────────────────────────────────────────
 * The site's `require_known_origin` compares the reported host to the
 * registered domain, and the per-(site, ip) budget below bounds volume. Be
 * honest about the first one: `Origin` is forgeable by any non-browser client,
 * so it stops a snippet copied onto a staging host and casual abuse — it is
 * not a security boundary. The rate limit is the part that bounds a determined
 * caller, and the endpoint's blast radius is "rows in your own analytics
 * table", not data disclosure.
 */
import { Hono } from "hono";
import type { AppBindings } from "../app";
import { AppError } from "@backlex/core";
import { rateLimitOk } from "../lib/rate-limit";
import { requestMeta } from "../services/activity";
import { setMeterTenant } from "../lib/usage-meter";
import { getSiteById, recordWebEvents } from "../services/analytics";
import { dailyVisitorId } from "../services/analytics-identity";
import { enrichmentFromRequest, parseUserAgent } from "../services/analytics-enrich";
import { TRACKER_BOOT_JS, TRACKER_JS } from "../services/analytics-tracker";
import { TAG_RUNTIME_JS, safeJson } from "../services/tag-runtime";
import { CONSENT_BANNER_JS } from "../services/consent-banner-bundle";
import { getPublishedConsentConfig } from "../services/consent";
import { getPublishedArtifact } from "../services/tag-manager";
import { ifNoneMatch, weakETag, weakHash } from "../lib/etag";
import {
  getContainerEntry,
  setContainerEntry,
} from "../services/tag-container-cache";
import { getConsentEntry, setConsentEntry } from "../services/consent-config-cache";

/**
 * Per-(site, IP) budget.
 *
 * Far larger than the SDK ingest route's 120/min, and the difference is not
 * generosity — it is that this key is shared by everyone behind one NAT. An
 * office, a school or a mobile carrier gateway presents a single address for
 * hundreds of real visitors, and a budget tuned for one browser tab would drop
 * their traffic silently and look like a quiet afternoon.
 */
const COLLECT_MAX_PER_MINUTE = 600;
const COLLECT_WINDOW_MS = 60_000;

/**
 * A cheaper ceiling keyed on the IP ALONE, checked before the site lookup.
 *
 * Without it the ordering leaks work: an unauthenticated caller sending random
 * site ids would drive one database read per request and never reach the
 * per-site limit, because that limit needs the site the read was going to
 * find. Set above the per-site budget so a visitor legitimately hitting two of
 * a workspace's sites is never caught by it — this is a floor under the
 * lookup, not a second traffic policy.
 */
const COLLECT_MAX_PER_IP_PER_MINUTE = 1_200;

/** Longest body we will read. A pageview is a few hundred bytes. */
const MAX_BODY_BYTES = 8_192;

/**
 * How long a browser keeps a container before asking again.
 *
 * Fifteen minutes, which is GTM's own figure, and the honest way to describe it
 * is "a publish reaches every visitor within fifteen minutes". The alternative
 * — a version in the URL — would make every publish an edit to the customer's
 * HTML. Preview mode is what gives an operator an instant answer.
 *
 * Note that `must-revalidate` is deliberately NOT here. It forbids serving a
 * STALE entry after expiry; it does not make a browser revalidate before one.
 * The ETag is what turns the post-expiry request into a bodyless 304.
 */
const CONTAINER_MAX_AGE = 900;

/**
 * The other half of what the `/tm` file actually IS.
 *
 * The body served there is the tracker plus the container runtime plus the
 * published artifact, but the ETag was derived from the artifact hash alone —
 * so a browser holding a cached container revalidated, got a 304, and kept
 * executing the OLD runtime until the operator happened to republish. A fix to
 * the consent gate could not be pushed to a live site at all; it waited on an
 * unrelated human action that might never come.
 *
 * Derived from the source rather than a hand-bumped constant, because a
 * constant someone must remember to bump is a constant that silently stops
 * describing the code. Computed once per isolate over ~36 KB, which is FNV-1a
 * over a string already resident in memory.
 */
const RUNTIME_FINGERPRINT = weakHash(TRACKER_JS + TAG_RUNTIME_JS + CONSENT_BANNER_JS);

/** CORS for an uncredentialed, append-only, cross-origin endpoint. */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // Deliberately no `Access-Control-Allow-Credentials`: with `ACAO: *` the
  // browser rejects the response outright if credentials are involved, and we
  // want no ambient authority here anyway.
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

/** `example.com` and `www.example.com` are the same site to an operator. */
const hostMatches = (registered: string, reported: string): boolean => {
  const a = registered.toLowerCase();
  const b = reported.toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return b === `www.${a}` || a === `www.${b}` || b.endsWith(`.${a}`);
};

/**
 * Glob match for excluded paths. Supports a trailing `*` and a leading `*`,
 * which is the whole vocabulary an operator needs for `/admin/*` and
 * `*.json` — a full glob engine here would be a parser accepting untrusted
 * input for no additional expressiveness anyone asked for.
 */
const pathExcluded = (path: string, patterns: string[]): boolean => {
  const p = path.split("?")[0] ?? path;
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat) continue;
    const starts = pat.startsWith("*");
    const ends = pat.endsWith("*");
    const core = pat.slice(starts ? 1 : 0, ends ? pat.length - 1 : pat.length);
    if (starts && ends) {
      if (p.includes(core)) return true;
    } else if (ends) {
      if (p.startsWith(core)) return true;
    } else if (starts) {
      if (p.endsWith(core)) return true;
    } else if (p === pat) {
      return true;
    }
  }
  return false;
};

interface CollectBody {
  s?: unknown;
  /** Consent state as the tag understood it: "denied" drops the event. */
  c?: unknown;
  n?: unknown;
  p?: unknown;
  r?: unknown;
  h?: unknown;
  v?: unknown;
}

const asStr = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

export const analyticsCollectRoutes = new Hono<AppBindings>()
  .options("/collect", (c) => c.body(null, 204, { ...corsHeaders }))

  .post("/collect", async (c) => {
    const ctx = c.get("ctx");
    const db = { db: ctx.db, dialect: ctx.dialect };
    const meta = requestMeta(c.req.raw);
    const ip = meta.ip ?? "unknown";

    // Refuse on the declared length BEFORE reading. `c.req.text()` buffers the
    // whole body, so checking the size afterwards means an unauthenticated
    // caller can still make us hold an arbitrarily large string first.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.body(null, 204, { ...corsHeaders });
    }

    // Bound the work that happens before the site is even known.
    const ipOk = await rateLimitOk(
      ctx.env,
      `analytics-collect-ip:${ip}`,
      COLLECT_MAX_PER_IP_PER_MINUTE,
      COLLECT_WINDOW_MS,
    );
    if (!ipOk) throw new AppError("RATE_LIMITED", "Too many events from this address.");

    // Read as text: a JSON content-type would make the beacon preflight.
    const raw = await c.req.text();
    if (!raw || raw.length > MAX_BODY_BYTES) {
      return c.body(null, 204, { ...corsHeaders });
    }

    let body: CollectBody;
    try {
      body = JSON.parse(raw) as CollectBody;
    } catch {
      // A malformed beacon is not worth an error response — there is no client
      // on the other end able to act on one.
      return c.body(null, 204, { ...corsHeaders });
    }

    // Consent is enforced HERE as well as in the tag. The client-side check is
    // advice a modified script can decline to follow; this is the part an
    // operator can point at.
    if (asStr(body.c, 16) === "denied") {
      return c.body(null, 204, { ...corsHeaders });
    }

    const siteId = asStr(body.s, 64);
    if (!siteId) return c.body(null, 204, { ...corsHeaders });

    const site = await getSiteById(db, siteId);
    if (!site) {
      // 202 rather than 404: an unknown id must not let a caller enumerate
      // which site ids exist by watching status codes.
      return c.body(null, 202, { ...corsHeaders });
    }

    // The site is what resolves the workspace — the tag carries no other
    // credential — so metering is attributed from here.
    setMeterTenant(c, site.tenantId);

    const ok = await rateLimitOk(
      ctx.env,
      `analytics-collect:${site.id}:${ip}`,
      COLLECT_MAX_PER_MINUTE,
      COLLECT_WINDOW_MS,
    );
    if (!ok) throw new AppError("RATE_LIMITED", "Too many events from this address.");

    // ── Filters, all server-side. A client-side opt-out is advice; this is
    // the part an operator can actually rely on. ──────────────────────────
    if (site.ignoredIps.length && meta.ip && site.ignoredIps.includes(meta.ip)) {
      return c.body(null, 202, { ...corsHeaders });
    }

    const reportedHost = asStr(body.h, 255);
    if (site.requireKnownOrigin) {
      const origin = c.req.header("origin");
      let originHost: string | null = null;
      try {
        originHost = origin ? new URL(origin).hostname : null;
      } catch {
        originHost = null;
      }
      const host = originHost ?? reportedHost;
      if (!host || !hostMatches(site.domain, host)) {
        return c.body(null, 202, { ...corsHeaders });
      }
    }

    const path = asStr(body.p, 1000) ?? "/";
    if (site.excludedPaths.length && pathExcluded(path, site.excludedPaths)) {
      return c.body(null, 202, { ...corsHeaders });
    }

    if (site.filterBots && parseUserAgent(meta.userAgent).deviceType === "bot") {
      return c.body(null, 202, { ...corsHeaders });
    }

    const now = Date.now();
    const distinctId = await dailyVisitorId(
      ctx.env,
      { tenantId: site.tenantId, siteId: site.id, ip: meta.ip, userAgent: meta.userAgent },
      now,
    );

    const ctxFields = enrichmentFromRequest(c.req.raw);
    const props =
      body.v && typeof body.v === "object" && !Array.isArray(body.v)
        ? (body.v as Record<string, unknown>)
        : null;

    // A purchase reports its amount in the event's own props — the tag has one
    // call shape, `backlex("purchase", { revenue, currency })`. Both are lifted
    // into columns so revenue reports never have to read JSON, and both are
    // range-checked here: a caller-supplied number reaches a bigint column, and
    // "unbounded integer from the public internet" is not a thing to store.
    const rawRevenue = Number(props?.revenue);
    const revenue =
      Number.isFinite(rawRevenue) && Math.abs(rawRevenue) <= Number.MAX_SAFE_INTEGER
        ? Math.trunc(rawRevenue)
        : null;
    const currency =
      typeof props?.currency === "string" && /^[A-Za-z]{3}$/.test(props.currency)
        ? props.currency.toUpperCase()
        : null;

    await recordWebEvents(
      db,
      { tenantId: site.tenantId, siteId: site.id, distinctId },
      [
        {
          name: asStr(body.n, 120) ?? "page_view",
          // Overwritten by recordWebEvents; present because the type requires it.
          distinctId,
          path,
          referrer: asStr(body.r, 1000),
          source: "web",
          props,
          deviceType: ctxFields.deviceType,
          browser: ctxFields.browser,
          os: ctxFields.os,
          country: ctxFields.country,
          revenue,
          currency,
        },
      ],
      now,
    );

    // 204 with no body: the tag ignores the response, and an empty one is the
    // cheapest thing to send to a page that may already be unloading.
    return c.body(null, 204, { ...corsHeaders });
  })

  /**
   * The per-site container: the tracker and the tag runtime in one file, with
   * the compiled container inlined as DATA.
   *
   * The snippet is `<script defer src=".../tm/<site-id>.js"></script>` — no
   * `data-site` attribute, because the id is in the URL. That matters for more
   * than tidiness: `document.currentScript` is null for a dynamically injected
   * script, which is exactly the shape of the async snippet operators paste out
   * of habit, so a runtime that read its configuration off the element would
   * simply never start.
   *
   * The container is JSON handed to a fixed interpreter, never generated code.
   * The only operator string that becomes executable is a custom-code tag, and
   * that rides the per-site gate which the compiler re-checks on every publish.
   */
  .get("/tm/:file", async (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".js")) return c.notFound();
    const siteId = file.slice(0, -3);

    const ctx = c.get("ctx");
    const now = Date.now();

    const origin = new URL(c.req.url).origin;
    let hit = getContainerEntry(siteId, origin, now);

    if (!hit) {
      const published = await getPublishedArtifact({ db: ctx.db, dialect: ctx.dialect }, siteId);
      // An unknown or unpublished site gets an empty 200 rather than a 404, for
      // the same reason the collect route answers 202: a status code that
      // differs by whether an id exists is an oracle for enumerating ids.
      if (!published) {
        return c.body("", 200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": `public, max-age=${CONTAINER_MAX_AGE}`,
          "Access-Control-Allow-Origin": "*",
        });
      }
      const endpoint = origin + "/api/analytics/collect";

      // The consent policy travels WITH the container, and the order below is
      // the entire reason prior blocking works.
      //
      // `__backlexTM` arms its triggers synchronously and a pageview trigger
      // fires immediately, so whatever decides which tags may run has to have
      // decided before that call. A banner that fetched `/api/consent/config`
      // could not: a round trip cannot finish first, and every pageview tag
      // would fire while it was in flight. So the artifact is compiled in, the
      // banner boots between the tracker and the container, and by the time
      // the container starts the grant map already says no.
      //
      // Read through the same per-isolate memo the public config route uses,
      // so this costs one query a minute per site rather than one per visitor.
      let consent = getConsentEntry(siteId, now);
      if (!consent) {
        const pub = await getPublishedConsentConfig({ db: ctx.db, dialect: ctx.dialect }, siteId);
        if (pub) {
          consent = { at: now, body: pub.body, hash: pub.hash, tenantId: pub.tenantId };
          setConsentEntry(siteId, consent);
        }
      }

      const body = [
        TRACKER_JS,
        // Only when there is a policy to show. A site with none — or one that
        // is disabled — pays nothing for the banner, and `CONSENT_CONFIG_OFF`
        // is byte-identical across four different situations anyway, so
        // shipping it would embed a document that says nothing.
        consent ? CONSENT_BANNER_JS : "",
        TAG_RUNTIME_JS,
        `;__backlexTrackerInit(${safeJson({ s: siteId, e: endpoint })});`,
        consent
          ? `;__backlexConsentBanner(${safeJson({
              cfg: JSON.parse(consent.body),
              // Bare hex. The public route serves this hash inside an ETag,
              // where it is QUOTED — and `SHA256_HEX_RE` rejects the quotes,
              // which would silently downgrade every record this banner
              // writes to `hashGrade: "unresolved"`.
              hash: consent.hash,
              endpoint: origin + "/api/consent/record",
            })});`
          : "",
        `;__backlexTM(${safeJson(published.artifact)});`,
      ]
        .filter(Boolean)
        .join("\n");
      hit = {
        at: now,
        body,
        // The consent hash joins the container hash in the cache entry, so a
        // policy edit changes the validator below even though the container
        // itself did not move.
        hash: consent ? `${published.hash}:${consent.hash}` : published.hash,
        tenantId: published.tenantId,
      };
      setContainerEntry(siteId, origin, hit);
    }

    // The site resolves the workspace — the tag carries no other credential —
    // so metering is attributed from here. Without this an anonymous fetch
    // bills whichever workspace the tenant middleware happened to resolve,
    // which is the DEFAULT one. That exact defect is pinned as a regression.
    if (hit.tenantId) setMeterTenant(c, hit.tenantId);

    const etag = weakETag([hit.hash, RUNTIME_FINGERPRINT]);
    const headers = {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": `public, max-age=${CONTAINER_MAX_AGE}`,
      ETag: etag,
      "Access-Control-Allow-Origin": "*",
    };
    // `c.body` does no conditional handling of its own, so the 304 is explicit.
    if (ifNoneMatch(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, headers);
    }
    return c.body(hit.body, 200, headers);
  })

  .get("/script.js", (c) =>
    c.body(TRACKER_BOOT_JS, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      // Long enough to stay out of the way, short enough that a fix reaches
      // every visitor within the hour. `must-revalidate` is deliberate: a
      // stale tag pointing at a removed endpoint is worse than a revalidation.
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    }),
  );
