/**
 * Server-side enrichment of an analytics event: the dimensions a website
 * analytics tool reports on that the client either cannot be trusted for or
 * should not have to send.
 *
 * Three sources, all read at ingest and none stored raw:
 *
 * - **User-agent → device / browser / OS.** The UA string itself is never
 *   written to a column. It is read, reduced to three short labels, and
 *   dropped. That is deliberate: a raw UA is high-entropy enough to be a
 *   fingerprint, and nothing downstream needs it.
 * - **Request headers → country.** Every serverless platform puts the
 *   geo-resolved country on a header of its own name; we read whichever is
 *   present. The IP is never stored either (see `dailyDistinctId` in phase 2).
 * - **Landing URL query → UTM.** Campaign tagging lives in the query string of
 *   the page the visitor arrived on, so it is parsed off `path` when the caller
 *   sent one with a query.
 *
 * No dependency is added for any of this. A UA-parsing library is a large,
 * frequently-updated table for a job where ~90% accuracy on four device
 * buckets is the whole requirement — see `parseUserAgent` for the accuracy
 * this actually claims.
 */

/** What one event gains from its request context. */
export interface EventEnrichment {
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  country: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

export const EMPTY_ENRICHMENT: EventEnrichment = {
  deviceType: null,
  browser: null,
  os: null,
  country: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
};

/* ── User-agent ───────────────────────────────────────────────────────── */

/**
 * Bot tokens, checked before anything else.
 *
 * This list is short on purpose. It catches the declared, well-behaved
 * crawlers that make up the bulk of non-human traffic and announce themselves;
 * it does not attempt to catch a scraper that is actively lying, because that
 * is an arms race a regex table loses. Bot traffic is labelled rather than
 * dropped here — dropping is a per-site setting (phase 2), so an operator who
 * wants the rows can keep them.
 */
const BOT_RE =
  /bot|crawler|spider|crawling|slurp|mediapartners|facebookexternalhit|ia_archiver|curl\/|wget\/|python-requests|headlesschrome|phantomjs|lighthouse|pingdom|uptimerobot|semrush|ahrefs|dataprovider|petalbot|bytespider/i;

/**
 * Browser detection, ORDER-SENSITIVE — this is the whole subtlety of UA
 * parsing. Every Chromium browser carries `Safari` in its UA, and most carry
 * `Chrome` too, so the specific tokens must be tested before the generic ones.
 * Reordering this array silently reclassifies traffic.
 */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/edg(?:e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/samsungbrowser\//i, "Samsung Internet"],
  [/ucbrowser\//i, "UC Browser"],
  [/yabrowser\//i, "Yandex"],
  [/firefox\/|fxios\//i, "Firefox"],
  // CriOS is Chrome on iOS, which reports neither `Chrome` nor a Blink engine.
  [/chrome\/|crios\//i, "Chrome"],
  [/safari\//i, "Safari"],
  [/msie |trident\//i, "Internet Explorer"],
];

/**
 * OS detection, also order-sensitive: an iPad reports `Mac OS X` in recent
 * iPadOS, and Android reports `Linux`. Specific before generic, always.
 */
const OSES: readonly (readonly [RegExp, string])[] = [
  [/windows phone/i, "Windows Phone"],
  [/windows nt|win64|win32/i, "Windows"],
  [/android/i, "Android"],
  [/iphone|ipad|ipod|ios/i, "iOS"],
  [/cros/i, "ChromeOS"],
  [/mac os x|macintosh/i, "macOS"],
  [/linux|x11/i, "Linux"],
];

/** Longest user-agent we will scan. Chrome caps its own UA far below this;
 *  anything longer is not a browser telling us about itself. */
const UA_MAX = 512;

/** Tablets must be tested before phones: an Android tablet says `Android` too. */
const TABLET_RE = /ipad|tablet|playbook|silk|(android(?!.*mobile))/i;
const MOBILE_RE = /mobi|iphone|ipod|android|blackberry|iemobile|opera mini/i;

/**
 * Reduce a user-agent to `{ deviceType, browser, os }`.
 *
 * Accuracy claim, so nobody over-trusts the output: this classifies mainstream
 * traffic correctly and returns `null` rather than guessing on anything it does
 * not recognize. `null` means "not identified", which is a different and more
 * honest claim than a category. Reports render NULL as its own row.
 *
 * **`desktop` is a conclusion, not a fallback.** `mobile` and `tablet` come
 * from positive matches, so the tempting shape is `else desktop` — and that is
 * wrong in a way that shows up in the one number an operator acts on. Every
 * server-side SDK call, monitoring probe, preview-link unfurler and
 * undeclared scraper carries some UA that matches no phone token, and an
 * `else` would file all of it under desktop, inflating the bucket with traffic
 * that is not a person at a computer. So desktop is claimed only when
 * something was actually recognized — an OS or a browser. An agent we know
 * nothing about is reported as nothing.
 */
export const parseUserAgent = (
  raw: string | null | undefined,
): { deviceType: string | null; browser: string | null; os: string | null } => {
  if (!raw) return { deviceType: null, browser: null, os: null };

  // Truncate before any regex touches it. This value is an attacker-controlled
  // header on a PUBLICLY reachable ingest endpoint (a publishable key is
  // designed to ship in a browser bundle), and `TABLET_RE` carries a `.*`
  // inside a negative lookahead — linear per start position, so an unbounded
  // subject makes the scan quadratic. No real agent string is anywhere near
  // this long, and the cap turns a whole class of question into a non-question.
  const ua = raw.length > UA_MAX ? raw.slice(0, UA_MAX) : raw;

  if (BOT_RE.test(ua)) return { deviceType: "bot", browser: null, os: null };

  let browser: string | null = null;
  for (const entry of BROWSERS) {
    if (entry[0].test(ua)) {
      browser = entry[1];
      break;
    }
  }

  let os: string | null = null;
  for (const entry of OSES) {
    if (entry[0].test(ua)) {
      os = entry[1];
      break;
    }
  }

  const deviceType = TABLET_RE.test(ua)
    ? "tablet"
    : MOBILE_RE.test(ua)
      ? "mobile"
      : browser || os
        ? "desktop"
        : null;

  return { deviceType, browser, os };
};

/* ── Geo ──────────────────────────────────────────────────────────────── */

/**
 * Two-letter country for the request, or null.
 *
 * Every deploy target this repo builds for resolves geo at the edge and hands
 * it over on a header of its own naming, so this is a lookup rather than an
 * IP database:
 *
 * | Target   | Source                                                    |
 * |----------|-----------------------------------------------------------|
 * | Workers  | `request.cf.country`, falling back to `cf-ipcountry`       |
 * | Vercel   | `x-vercel-ip-country`                                     |
 * | Netlify  | `x-nf-geo` (base64 JSON)                                   |
 * | Bun/Node | none — self-hosted, so `x-backlex-country` from your proxy |
 *
 * The Bun target genuinely has no geo source: it is the self-hosted build with
 * no edge in front of it that we control. `x-backlex-country` is the documented
 * hook for an operator whose own proxy resolves geo; without it, `country`
 * stays NULL, which reports render as "Unknown" rather than inventing a value.
 *
 * `cf-ipcountry` uses `T1` for Tor exit nodes and `XX` when it cannot resolve;
 * both are normalized to null so they never appear as countries in a report.
 */
export const countryFromRequest = (req: Request): string | null => {
  const cf = (req as Request & { cf?: { country?: unknown } }).cf;
  const fromCf = typeof cf?.country === "string" ? cf.country : null;

  const raw =
    fromCf ??
    req.headers.get("cf-ipcountry") ??
    req.headers.get("x-vercel-ip-country") ??
    req.headers.get("x-backlex-country") ??
    netlifyCountry(req.headers.get("x-nf-geo"));

  return normalizeCountry(raw);
};

/** Netlify ships geo as base64-encoded JSON rather than a bare header.
 *
 *  On every OTHER runtime this header is simply whatever a caller chose to
 *  send, so it is bounded before being decoded and parsed — the result is
 *  discarded unless it yields a two-letter code anyway. */
const NF_GEO_MAX = 2048;
const netlifyCountry = (header: string | null): string | null => {
  if (!header || header.length > NF_GEO_MAX) return null;
  try {
    const json = JSON.parse(atob(header)) as { country?: { code?: unknown } };
    const code = json?.country?.code;
    return typeof code === "string" ? code : null;
  } catch {
    // A malformed header is not worth failing ingest over.
    return null;
  }
};

const normalizeCountry = (raw: string | null): string | null => {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  // `XX` = unresolved, `T1` = Tor. Both are "unknown" wearing a country's shape.
  if (c.length !== 2 || c === "XX" || c === "T1") return null;
  return c;
};

/* ── UTM ──────────────────────────────────────────────────────────────── */

/** Longest value we keep for a campaign field. */
const UTM_MAX = 200;

const clip = (v: string | null): string | null => {
  if (v == null) return null;
  const t = v.trim().slice(0, UTM_MAX);
  return t.length ? t : null;
};

/**
 * Pull `utm_source` / `utm_medium` / `utm_campaign` out of a path or URL.
 *
 * Accepts either a bare path with a query (`/pricing?utm_source=x`) or an
 * absolute URL, because the SDK sends the former and the phase-2 tag sends the
 * latter. Only these three are extracted: `utm_term` and `utm_content` stay in
 * `props`, because no report groups by them and every column is paid for on
 * every write (see `PARAM_BUDGET` in `analytics.ts`).
 */
export const parseUtm = (
  pathOrUrl: string | null | undefined,
): Pick<EventEnrichment, "utmSource" | "utmMedium" | "utmCampaign"> => {
  const none = { utmSource: null, utmMedium: null, utmCampaign: null };
  if (!pathOrUrl) return none;

  const q = pathOrUrl.indexOf("?");
  if (q === -1) return none;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(pathOrUrl.slice(q + 1));
  } catch {
    return none;
  }

  return {
    utmSource: clip(params.get("utm_source")),
    utmMedium: clip(params.get("utm_medium")),
    utmCampaign: clip(params.get("utm_campaign")),
  };
};

/* ── Composition ──────────────────────────────────────────────────────── */

/**
 * Everything one request contributes to every event in its batch.
 *
 * Per-event fields (UTM, which comes off each event's own path) are layered on
 * top by the caller — this is the part that is constant for the whole request.
 */
export const enrichmentFromRequest = (
  req: Request,
): Pick<EventEnrichment, "deviceType" | "browser" | "os" | "country"> => {
  const { deviceType, browser, os } = parseUserAgent(req.headers.get("user-agent"));
  return { deviceType, browser, os, country: countryFromRequest(req) };
};
