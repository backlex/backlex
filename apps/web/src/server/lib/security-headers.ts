/**
 * The response security headers, in ONE place, because this repo ships four
 * deploy targets and each one applies them by a different mechanism.
 *
 * Cloudflare serves the SPA from Static Assets and reads `public/_headers`.
 * Netlify reads the same file. Vercel reads NEITHER — `_headers` is a
 * Cloudflare-Pages/Netlify convention, and copying it into
 * `.vercel/output/static/` publishes it as a text file at `/_headers` that
 * applies to nothing. Only requests that reach the Hono function get anything
 * from `app.ts`, and on Vercel that is `/api/*`, `/mcp`, `/health`,
 * `/.well-known/*` and `/embed/form.js` — so every HTML document on that target
 * shipped with no CSP, no X-Frame-Options, no nosniff, no Referrer-Policy and
 * no HSTS. The admin dashboard was framable by any site, and `script-src
 * 'self'` — which `services/storage/content-type.ts` and `app.ts` both name as
 * THE mitigation for a stored-XSS sink — was simply absent.
 *
 * They had also already drifted where they did exist: `_headers` omitted the
 * `https://static.cloudflareinsights.com` that `app.ts` allows, so the two
 * halves of the same deployment disagreed about the policy. One constant, three
 * consumers, and `apps/web/tests/security-headers-parity.test.ts` fails if any
 * of them stops agreeing.
 */

/**
 * The policy every same-origin document gets.
 *
 * `script-src 'self'` with no `'unsafe-inline'` is the core of it: an injected
 * inline script does not execute. Styles keep `'unsafe-inline'` because React
 * and Tailwind set style attributes; `img`/`connect` stay broad for R2 assets,
 * same-origin API + SSE/WS, and cross-origin `VITE_API_URL` setups.
 *
 * `static.cloudflareinsights.com` is Cloudflare Web Analytics, auto-injected at
 * the zone proxy on Cloudflare-fronted deploys. Without the allowance the
 * beacon is blocked and every page logs CSP errors. The origin serves only CF's
 * own beacon script, so the stored-XSS posture of `'self'`-only is unchanged,
 * and it is inert on the other three targets.
 */
export const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * The same policy, framable.
 *
 * Embedded dashboards, public forms and booking pages are meant to be iframed
 * on the operator's own site, so they need `frame-ancestors *` AND the
 * `X-Frame-Options` header dropped — XFO has no allow-all value, so its mere
 * presence as `SAMEORIGIN` blocks the frame regardless of the CSP.
 */
export const EMBED_CSP = STRICT_CSP.replace(
  "frame-ancestors 'self'",
  "frame-ancestors *",
);

/** The non-CSP headers, identical on every target. */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
};

/**
 * Exactly which paths are meant to be framed, ANCHORED to the four public
 * shapes the client router actually declares.
 *
 * It used to be four `startsWith` prefixes, and that was a clickjacking hole on
 * every deploy target: `GET /embed/zzz` matched `/embed/`, the SPA-shell
 * handler answered the ADMIN `index.html` with 200 (Static Assets is configured
 * `not_found_handling = "single-page-application"`), the header middleware then
 * stamped `frame-ancestors *` and deleted `X-Frame-Options`, and React Router
 * — finding no match for `/embed/zzz` among the public routes — fell through to
 * the admin catch-all. Two lines of HTML on any site framed a logged-in
 * operator's real dashboard, or a pixel-perfect copy of the genuine sign-in
 * screen served from the genuine origin.
 *
 * The shapes come from `client/app.tsx`: `/embed/d/:token`, `/embed/f/:token`,
 * `/book/:token`, `/b/:token`. `/api/public/*` stays a prefix — it is the data
 * those pages fetch once framed, and it has many legitimate sub-paths.
 *
 * `/embed/form.js` is deliberately NOT here: it is a `<script src>`, not a
 * frame, and what it needs is the CORP relaxation in `lib/public-paths.ts`.
 */
const FRAMABLE_PAGE = /^\/(?:embed\/[df]|book|b)\/[^/]+\/?$/;

export const isFramablePath = (path: string): boolean =>
  FRAMABLE_PAGE.test(path) || path.startsWith("/api/public/");

/** Does this path name one of the framable PAGES (not the public API)? Used by
 *  the SPA-shell handlers to refuse a sub-path rather than serve the admin app
 *  under a framable prefix. */
export const isFramablePage = (path: string): boolean => FRAMABLE_PAGE.test(path);

/**
 * `public/_headers` (Cloudflare Pages / Netlify), rendered from the constants
 * above. `apps/web/tests/security-headers-parity.test.ts` compares this to the
 * file on disk, so the two cannot drift the way they already had.
 */
export const renderHeadersFile = (): string =>
  [
    "# Security headers for the statically-served admin SPA. The Worker's",
    "# `run_worker_first` is limited to /api/*, /health, /mcp, so the SPA HTML +",
    "# assets are served by Cloudflare Static Assets and never pass through the Hono",
    "# secureHeaders()/CSP middleware. This file applies the same protections at the",
    "# asset layer. (GraphiQL lives at /api/graphql — a worker path — and gets its",
    "# own relaxed CSP from the middleware, so the strict policy here is safe.)",
    "#",
    "# GENERATED SHAPE: the values below come from",
    "# `src/server/lib/security-headers.ts`. Edit that file, not this one —",
    "# `security-headers-parity.test.ts` compares them.",
    "/*",
    `  Content-Security-Policy: ${STRICT_CSP}`,
    ...Object.entries(BASE_SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`),
    "",
    "# NOTE: the public dashboard embed (`/embed/*`) is intentionally NOT served by",
    "# Static Assets — it's in `run_worker_first`, so the Worker serves the SPA shell",
    "# and sets a framable CSP (frame-ancestors *) itself. CF `_headers` only ever",
    "# APPENDS across matching rules (a `/embed/*` override here would leave the",
    "# strict `/*` CSP in place too, and browsers enforce the most restrictive of",
    "# duplicate CSPs), which is why the worker path is used instead.",
    "",
  ].join("\n");

/**
 * Build Output API v3 header routes for the Vercel target.
 *
 * `continue: true` so they decorate and fall through to `handle: "filesystem"`
 * rather than terminating the match. The framable variant comes FIRST because
 * the first match wins and the strict one would otherwise claim `/embed/d/x`.
 */
export const vercelHeaderRoutes = (): Array<Record<string, unknown>> => {
  // XFO has no allow-all value, so a framable page must not carry the header at
  // ALL — `SAMEORIGIN` blocks the frame whatever the CSP says, and an empty
  // value is not a removal. Omit the key rather than blanking it.
  const { "X-Frame-Options": _xfo, ...framableBase } = BASE_SECURITY_HEADERS;
  return [
    {
      src: "^/(?:embed/[df]|book|b)/[^/]+/?$",
      headers: { "Content-Security-Policy": EMBED_CSP, ...framableBase },
      continue: true,
    },
    {
      src: "/(.*)",
      headers: { "Content-Security-Policy": STRICT_CSP, ...BASE_SECURITY_HEADERS },
      continue: true,
    },
  ];
};
