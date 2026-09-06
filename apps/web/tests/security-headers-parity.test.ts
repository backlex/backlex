/**
 * Phase 10 of the 2026-09 pre-prod audit — the security headers, and the fact
 * that this repo has FOUR deploy targets that apply them four different ways.
 *
 * Two findings, one root: the policy existed in three places and only two of
 * them were real.
 *
 *  · **Vercel shipped the SPA with no security headers at all.** `_headers` is
 *    a Cloudflare-Pages/Netlify format; Vercel reads none of it. The build
 *    script copied it into `.vercel/output/static/`, where it is published as a
 *    text file at `/_headers` and applied to nothing, and the Hono middleware
 *    only runs for paths routed into the function (`/api/*`, `/mcp`, `/health`,
 *    `/.well-known/*`, `/embed/form.js`). So `GET /`, `/collections`,
 *    `/sign-in` and every asset came back with no CSP, no X-Frame-Options, no
 *    nosniff, no Referrer-Policy and no HSTS — on the one target where the
 *    admin dashboard is the whole product.
 *
 *  · **`/embed/*`, `/book/*` and `/b/*` were prefix-matched.** Static Assets is
 *    configured `not_found_handling = "single-page-application"`, so
 *    `ASSETS.fetch` never 404s: `GET /embed/zzz` returned the ADMIN
 *    `index.html` with 200, the header middleware saw the `/embed/` prefix,
 *    stamped `frame-ancestors *`, deleted `X-Frame-Options`, and React Router
 *    fell through to the admin catch-all. `frame-ancestors 'self'` on the admin
 *    app was bypassable from any site with two lines of HTML, on EVERY deploy
 *    target.
 *
 * They had also already drifted where they did exist — `_headers` omitted the
 * `static.cloudflareinsights.com` that `app.ts` allowed — which is the reason
 * this file compares rather than merely asserts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_SECURITY_HEADERS,
  EMBED_CSP,
  isFramablePage,
  isFramablePath,
  renderHeadersFile,
  STRICT_CSP,
  vercelHeaderRoutes,
} from "../src/server/lib/security-headers";

describe("faz10: one policy, three consumers", () => {
  test("`public/_headers` is exactly what the constants render", () => {
    // The file on disk vs. the source of truth. This is the check that would
    // have caught the cloudflareinsights drift.
    const onDisk = readFileSync(join(import.meta.dir, "../public/_headers"), "utf8");
    expect(onDisk).toBe(renderHeadersFile());
  });

  test("the Vercel build output carries the same policy", () => {
    const routes = vercelHeaderRoutes();
    const strict = routes.find((r) => r.src === "/(.*)") as
      | { headers: Record<string, string> }
      | undefined;
    expect(strict).toBeDefined();
    expect(strict!.headers["Content-Security-Policy"]).toBe(STRICT_CSP);
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) {
      expect(strict!.headers[k]).toBe(v);
    }
  });

  test("…and every route decorates rather than terminating", () => {
    // Without `continue: true` the first header route would answer the request
    // instead of falling through to `handle: "filesystem"`, and the SPA would
    // stop being served at all.
    for (const r of vercelHeaderRoutes()) expect(r.continue).toBe(true);
  });

  test("the framable Vercel route drops X-Frame-Options rather than blanking it", () => {
    // XFO has no allow-all value; `SAMEORIGIN` blocks the frame whatever the
    // CSP says, and an empty header value is not a removal.
    const framable = vercelHeaderRoutes()[0] as { headers: Record<string, string> };
    expect(framable.headers["Content-Security-Policy"]).toBe(EMBED_CSP);
    expect("X-Frame-Options" in framable.headers).toBe(false);
    expect(framable.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("the strict policy really is strict", () => {
    // Read as a list of promises the rest of the codebase makes on its behalf —
    // `services/storage/content-type.ts` and `app.ts` both name `script-src
    // 'self'` as THE stored-XSS mitigation.
    expect(STRICT_CSP).toContain("script-src 'self'");
    expect(STRICT_CSP).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(STRICT_CSP).toContain("object-src 'none'");
    expect(STRICT_CSP).toContain("frame-ancestors 'self'");
    expect(EMBED_CSP).toContain("frame-ancestors *");
    // The embed policy differs from the strict one in exactly ONE directive.
    expect(EMBED_CSP.replace("frame-ancestors *", "frame-ancestors 'self'")).toBe(STRICT_CSP);
  });
});

describe("faz10: framable means the four public shapes, not four prefixes", () => {
  test("the real public pages are framable", () => {
    for (const p of [
      "/embed/d/tok123",
      "/embed/f/tok123",
      "/book/tok123",
      "/b/tok123",
      "/book/tok123/", // trailing slash is the same page
    ]) {
      expect(isFramablePath(p)).toBe(true);
      expect(isFramablePage(p)).toBe(true);
    }
  });

  test("an unmatched sub-path is NOT framable — the clickjacking case", () => {
    for (const p of [
      "/embed/zzz",
      "/embed/",
      "/embed/d/a/b",
      "/book/a/b",
      "/b/a/b",
      "/bogus",
      "/", // the admin shell itself
      "/collections",
    ]) {
      expect(isFramablePath(p)).toBe(false);
      expect(isFramablePage(p)).toBe(false);
    }
  });

  test("`/api/public/*` stays a prefix — it is the data, not a page", () => {
    expect(isFramablePath("/api/public/dashboards/x/run")).toBe(true);
    // …but it is not a PAGE, so the SPA-shell handlers must not serve it.
    expect(isFramablePage("/api/public/dashboards/x/run")).toBe(false);
  });

  test("`/embed/form.js` is a script, not a frame", () => {
    // It needs the CORP relaxation in `lib/public-paths.ts`, not
    // `frame-ancestors *` — and it must not be mistaken for a page shell.
    expect(isFramablePath("/embed/form.js")).toBe(false);
    expect(isFramablePage("/embed/form.js")).toBe(false);
  });
});
