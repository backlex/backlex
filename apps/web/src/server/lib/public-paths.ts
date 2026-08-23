/**
 * The documents backlex serves to browsers on OTHER people's domains.
 *
 * One list, two consumers, because they are answers to the same question and
 * drifted apart once already:
 *
 *  - `app.ts` relaxes `Cross-Origin-Resource-Policy` to `cross-origin` on these,
 *    because a `<script src>` or a `sendBeacon` is a no-cors request and the
 *    default `same-origin` blocks it outright. `/api/consent/record` was
 *    missing from that list for a whole phase — the same omission twice, since
 *    `/api/analytics/collect` had already been relaxed for the same reason.
 *  - `middleware/tenant.ts` refuses to pin the `backlex-tenant` cookie on them.
 *
 * ── Why the cookie matters here ───────────────────────────────────────────
 * Every one of these is fetched by an anonymous visitor of a CUSTOMER's site,
 * and the middleware resolved a default workspace for them and pinned it for
 * 30 days. Three things wrong with that, in ascending order of seriousness:
 *
 *  1. It is dead. `SameSite=Lax` means the cookie is never SENT on a cross-site
 *     subresource request, so it can never route anything for these callers —
 *     and it would not be consulted anyway, since the site id in the path
 *     resolves the workspace (see `setMeterTenant` in the container handler).
 *  2. It suppresses caching. A `Set-Cookie` on a `public, max-age=900` response
 *     is exactly what makes a shared cache refuse to store it.
 *  3. It is device storage set without consent, by the very file that delivers
 *     the consent banner. The whole feature's claim is that nothing optional
 *     touches the device before the visitor answers; a workspace-routing cookie
 *     that is not strictly necessary for the visitor is not an exception to
 *     that, it is a counter-example to it.
 *
 * ── The CORP half was a live bug, and it was invisible from every test ────
 * Kept from the comment this replaced, because it is the reason the list must
 * not be trimmed by anyone who cannot reproduce a cross-origin load.
 * `secureHeaders()` stamps `Cross-Origin-Resource-Policy: same-origin` on every
 * response. CORP is enforced on **no-cors** requests, which is exactly what a
 * classic `<script src>` is — so the analytics tag, the tag-manager container
 * and the form embed loader were all served with a header telling the browser
 * to throw them away. Nothing caught it because CORP has no effect same-origin:
 * the in-process harness has no origin at all, and a local browser pass against
 * localhost loads the tag from the page's own host. An `ACAO: *` looks like the
 * cross-origin story is handled, and for `fetch()` it is — CORP does not apply
 * to CORS-mode requests, which is why the consent config endpoint worked
 * either way. It took two real origins to see, and the deployed worker to
 * confirm.
 *
 * Each path is public for a reason written down where it is served. Nothing
 * else belongs here: `same-origin` is the right default, and it is what stops a
 * hostile page pulling an authenticated JSON response in as a no-cors
 * subresource.
 *
 * ── Narrower than `isFramable`, deliberately ──────────────────────────────
 * The framable set is NOT reused, even though it looks like the same list. CORP
 * governs subresource loads; it does not block a cross-origin IFRAME unless the
 * embedder sets COEP, which is why the form, booking and dashboard embeds work
 * today with `same-origin` on them. And `/api/public/*` is fetched from INSIDE
 * those iframes, where the document's own origin is ours — same-origin, so CORP
 * never applies. Relaxing either would widen the hole without fixing anything.
 */
/**
 * The per-site script file, at BOTH of its paths.
 *
 * `/api/site/` is canonical. `/api/analytics/tm/` is permanent — not
 * deprecated, not sunset — because it is inside a `<script>` tag on every
 * already-deployed customer page and there is no version negotiation: a
 * removed path stops collection everywhere, silently.
 *
 * One predicate because THREE middlewares match on it — the CORS bypass, the
 * CORP relaxation and the workspace-cookie skip — and three copies of a prefix
 * drift. Adding a second route under `/api/site/` would make that route public
 * by accident; there is exactly one, and it is this file.
 */
export const isPerSiteScript = (path: string): boolean =>
  path.startsWith("/api/site/") || path.startsWith("/api/analytics/tm/");

export const isPublicSubresource = (path: string): boolean =>
  // The drop-in analytics tag and the per-site tag-manager container, both
  // `<script src>` on a customer's own domain.
  path === "/api/analytics/script.js" ||
  isPerSiteScript(path) ||
  // The form embed loader — a `<script src>` that injects the iframe.
  path === "/embed/form.js" ||
  // `sendBeacon` is a no-cors request, so CORP is in scope for its response
  // even though the beacon discards it.
  path === "/api/analytics/collect" ||
  // Read with `fetch()` today, so CORP does not currently bite — but it is
  // public by the same argument, and the banner that loads beside it is a
  // subresource.
  path === "/api/consent/config" ||
  // Its sibling, and the one that WAS missing. The POST takes `text/plain`
  // specifically so `navigator.sendBeacon` can fire it during page unload —
  // and a beacon is a no-cors request, which is the exact shape CORP bites.
  // The DELETE beside it is the visitor withdrawing.
  path === "/api/consent/record";
