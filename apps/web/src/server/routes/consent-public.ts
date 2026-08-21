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
 *
 * It does READ one header, though: the `ETag` carries the artifact hash and is
 * named in `Access-Control-Expose-Headers`, because a response header is
 * invisible to cross-origin script unless it is. That is how a recorded consent
 * gets something immutable to point at.
 */
import { Hono } from "hono";
import type { AppBindings } from "../app";
import { ifNoneMatch } from "../lib/etag";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { assertWorkspaceRequestQuota } from "../lib/usage-meter";
import { countryFromRequest } from "../services/analytics-enrich";
import {
  CONSENT_CONFIG_OFF,
  OPTIONAL_CATEGORIES,
  getPublishedConsentConfig,
  type OptionalCategory,
} from "../services/consent";
import { getConsentEntry, setConsentEntry } from "../services/consent-config-cache";
import {
  CONSENT_RECORD_SOURCES,
  SUBJECT_ID_RE,
  consentIpHash,
  deleteSubjectRecords,
  recordConsent,
  type ConsentRecordSource,
} from "../services/consent-records";
import { recordActivity } from "../services/activity";

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
  // Response headers are NOT readable cross-origin unless they are named here —
  // only the CORS-safelisted set is, and `ETag` is not in it. Without this the
  // banner can see the artifact but not the hash that identifies it, which is
  // the one thing a consent record has to store.
  "Access-Control-Expose-Headers": "ETag",
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

/**
 * ── The ingest's budgets ──────────────────────────────────────────────────
 * Four ceilings rather than one, because they bound different things. The
 * per-IP one bounds a single caller; the per-(site, IP) one stops one address
 * concentrating on one victim; the per-(site, subject) one stops a single
 * browser looping; and the per-SITE day ceiling is the only one that bounds a
 * BOTNET, where every request comes from a different address and every other
 * limiter sees one hit. The collect route next door has neither of the last
 * two and is the outlier, not the model.
 */
const RECORD_MAX_BODY_BYTES = 4_096;
const RECORD_MAX_PER_IP_PER_MINUTE = 300;
const RECORD_MAX_PER_SITE_IP_PER_MINUTE = 60;
const RECORD_MAX_PER_SUBJECT_PER_MINUTE = 10;
const RECORD_MAX_PER_SITE_PER_DAY = 50_000;
const DAY_MS = 86_400_000;

/** The one thing a caller may learn: back off. It learns nothing about whether
 *  a row landed — see the `ok` doctrine below. */
const throttled = (c: any, code: "RATE_LIMITED" | "QUOTA_EXCEEDED") =>
  c.json({ error: { code, message: "Too many requests." } }, 429, CORS);

/**
 * Accepted, or deliberately dropped. One status, one body, every case.
 *
 * An oversize body, malformed JSON, an unknown or disabled site, a malformed
 * subject id and the operator's own day ceiling all answer identically to a
 * successful write. That is the `CONSENT_CONFIG_OFF` doctrine applied to a
 * write: site ids are public, so a response that varies by whether an id is
 * real — or by whether a row landed — is an oracle. The collect route's
 * 202-vs-204 split is the thing being avoided here, not copied.
 */
const accepted = (c: any) => c.json({ ok: true }, 202, CORS);

const asStr = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

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

  // A STRONG ETag carrying the artifact hash verbatim, not `weakETag(hash)`.
  //
  // Two reasons, and the first is load-bearing rather than tidy. A consent
  // record has to name the artifact the visitor was actually shown, and this
  // header is the ONLY way the banner can learn it: the hash cannot go in the
  // body, because the body is what is hashed, and `weakETag` runs FNV-1a over
  // the digest and returns something else entirely (`W/"993x44"` for a hash
  // beginning `62af6b12…`). Hashing a hash also buys nothing — the input is
  // already a uniformly distributed 256-bit digest, so the weak variant only
  // discards 224 bits of it.
  //
  // `ifNoneMatch` compares with the `W/` prefix stripped, so conditional
  // requests behave identically either way.
  const etag = `"${hit.hash}"`;
  const headers = { ...HEADERS, ETag: etag };
  // `c.body` does no conditional handling of its own, so the 304 is explicit.
  if (ifNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, headers);
  }
  return c.body(hit.body, 200, headers);
})

  // The DELETE below always preflights (a method outside the CORS-safelisted
  // set does), so it needs an answer. The POST deliberately does NOT: it takes
  // `text/plain` precisely so `navigator.sendBeacon` can fire it during page
  // unload, where there is no second round-trip to be had.
  .options("/record", (c) =>
    c.body(null, 204, {
      ...CORS,
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    }),
  )

  /**
   * Record a visitor's decision.
   *
   * Anonymous, from a foreign origin, with a public site id and no credential —
   * so the ordering below is the security design, not boilerplate. Read it as a
   * funnel: each step bounds the work the next one is allowed to do.
   */
  .post("/record", async (c) => {
    const ctx = c.get("ctx");
    const ip = requestMeta(c.req.raw).ip ?? "unknown";

    // Refuse on the DECLARED length before reading. `c.req.text()` buffers the
    // whole body, so checking afterwards still lets an unauthenticated caller
    // make us hold an arbitrarily large string first.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > RECORD_MAX_BODY_BYTES) return accepted(c);

    // Bounds the work done before the site is even known — otherwise random
    // site ids drive one database read per request.
    if (
      !(await rateLimitOk(
        ctx.env,
        `consent-record-ip:${ip}`,
        RECORD_MAX_PER_IP_PER_MINUTE,
        WINDOW_MS,
      ))
    ) {
      return throttled(c, "RATE_LIMITED");
    }

    const raw = await c.req.text();
    if (!raw || raw.length > RECORD_MAX_BODY_BYTES) return accepted(c);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return accepted(c);
    }

    const siteId = asStr(body.s, 64);
    if (!siteId) return accepted(c);

    // **The gate that makes this endpoint safe to ship before the banner.** It
    // returns null for an unknown site, a site with no policy, a policy that is
    // switched off, an orphaned policy and a blob that is malformed at rest —
    // so the writable set is exactly the set of sites whose operator
    // deliberately published a consent policy, which is the set about to run a
    // banner. It also yields the tenant and the live artifact in one read.
    const published = await getPublishedConsentConfig(
      { db: ctx.db, dialect: ctx.dialect },
      siteId,
    );
    if (!published) return accepted(c);

    // The site is the only credential this request carries, so the workspace
    // that owns the traffic is billed for it — on this path as on /config.
    if (published.tenantId) setMeterTenant(c, published.tenantId);

    // Per-(site, IP): stops one address concentrating on one victim, which the
    // per-IP ceiling above cannot see.
    if (
      !(await rateLimitOk(
        ctx.env,
        `consent-record:${siteId}:${ip}`,
        RECORD_MAX_PER_SITE_IP_PER_MINUTE,
        WINDOW_MS,
      ))
    ) {
      return throttled(c, "RATE_LIMITED");
    }

    // Per-SITE per DAY: the only ceiling that bounds a BOTNET, where every
    // request comes from a fresh address and every per-IP limiter sees one hit.
    // A drop here is the operator's own capacity, not a fact about the caller,
    // so it answers `ok` like every other deliberate drop.
    if (
      !(await rateLimitOk(
        ctx.env,
        `consent-record-day:${siteId}`,
        RECORD_MAX_PER_SITE_PER_DAY,
        DAY_MS,
      ))
    ) {
      return accepted(c);
    }

    // The workspace's own monthly cap. CAUGHT rather than allowed to throw:
    // it raises an AppError, and the error middleware sets no CORS headers, so
    // a thrown 429 reaches the banner as an opaque CORS failure instead of a
    // throttle it can act on.
    if (published.tenantId) {
      try {
        await assertWorkspaceRequestQuota(ctx, published.tenantId);
      } catch {
        return throttled(c, "QUOTA_EXCEEDED");
      }
    }

    const subjectId = asStr(body.u, 64);
    if (!subjectId || !SUBJECT_ID_RE.test(subjectId)) return accepted(c);

    // Per-(site, subject): bounds one browser looping, which the two ceilings
    // above would only see as ordinary traffic from a busy address.
    if (
      !(await rateLimitOk(
        ctx.env,
        `consent-record-subj:${siteId}:${subjectId}`,
        RECORD_MAX_PER_SUBJECT_PER_MINUTE,
        WINDOW_MS,
      ))
    ) {
      return throttled(c, "RATE_LIMITED");
    }

    // The categories the LIVE artifact offers, which is what `grants` is
    // clamped to. Parsed from the served body rather than re-queried: it is the
    // same document the visitor was answering.
    let offered: readonly OptionalCategory[] = OPTIONAL_CATEGORIES;
    try {
      const cfg = JSON.parse(published.body) as { categories?: unknown };
      if (Array.isArray(cfg.categories)) {
        offered = cfg.categories.filter((x): x is OptionalCategory =>
          (OPTIONAL_CATEGORIES as readonly string[]).includes(x as string),
        );
      }
    } catch {
      // Leave the full list — the clamp still bounds the record to real
      // categories, which is what it is for.
    }

    const src = asStr(body.src, 20);
    const source: ConsentRecordSource =
      src && (CONSENT_RECORD_SOURCES as readonly string[]).includes(src)
        ? (src as ConsentRecordSource)
        : "banner";

    try {
      await recordConsent({ db: ctx.db, dialect: ctx.dialect }, {
        siteId,
        tenantId: published.tenantId,
        subjectId,
        policyHash: asStr(body.h, 64),
        currentHash: published.hash,
        offered,
        grants: body.g,
        source,
        locale: asStr(body.l, 20),
        country: countryFromRequest(c.req.raw),
        ipHash: await consentIpHash(ctx.env, published.tenantId, ip),
        userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null,
      });
    } catch (e) {
      // A driver failure is not a deliberate drop, and must not be dressed up
      // as one: the banner would record success for evidence that never landed.
      console.error("[consent-record] insert failed", e);
      return c.json({ error: { code: "INTERNAL", message: "Could not record." } }, 500, CORS);
    }

    return accepted(c);
  })

  /**
   * A visitor withdrawing everything they have recorded on this site.
   *
   * Until the preference centre exists this is the ONLY erasure path that can
   * reach an anonymous visitor, because their id lives nowhere but their own
   * browser. Always answers `{ cleared: true }`, row or no row — whether one
   * existed is the caller's own business, and a count would say whether a given
   * subject id is real.
   */
  .delete("/record", async (c) => {
    const ctx = c.get("ctx");
    const ip = requestMeta(c.req.raw).ip ?? "unknown";
    if (
      !(await rateLimitOk(
        ctx.env,
        `consent-forget-ip:${ip}`,
        RECORD_MAX_PER_SITE_IP_PER_MINUTE,
        WINDOW_MS,
      ))
    ) {
      return throttled(c, "RATE_LIMITED");
    }

    const siteId = asStr(c.req.query("s"), 64);
    const subjectId = asStr(c.req.query("u"), 64);
    const cleared = c.json({ cleared: true }, 200, CORS);
    if (!siteId || !subjectId || !SUBJECT_ID_RE.test(subjectId)) return cleared;

    const published = await getPublishedConsentConfig(
      { db: ctx.db, dialect: ctx.dialect },
      siteId,
    );
    if (!published) return cleared;
    if (published.tenantId) setMeterTenant(c, published.tenantId);

    const count = await deleteSubjectRecords(
      { db: ctx.db, dialect: ctx.dialect },
      published.tenantId,
      subjectId,
      siteId,
    );

    // Audited as an operator-visible event, with a COUNT and no subject id:
    // an audit row naming the visitor would re-create the identifier the
    // withdrawal just removed.
    if (count > 0) {
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: null,
          tenantId: published.tenantId,
          action: "consent.record.erased",
          collection: "consent",
          itemId: siteId,
          payload: { count },
          ip: null,
          userAgent: null,
        },
      );
    }
    return cleared;
  });
