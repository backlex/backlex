/**
 * The non-`/api` paths, and the three configs that have to agree about them.
 *
 * Almost everything the Hono app serves lives under `/api/*`, which every
 * target funnels wholesale. A handful of paths do not — `/mcp`, `/health`,
 * `/.well-known/*`, `/embed/form.js` — and each target reaches those through
 * its OWN allow-list: Cloudflare's `run_worker_first`, Vercel's `routes`,
 * Netlify's `[[redirects]]`. Three lists, no shared source, and a path missing
 * from one is served by that platform's SPA fallback instead: `index.html`,
 * as `text/html`, with a 200.
 *
 * ── Why the suite could not see this ──────────────────────────────────────
 * `/embed/form.js` shipped in Cloudflare's list and in neither of the other
 * two. It was broken on Vercel and Netlify for as long as those targets have
 * existed, while `forms.test.ts` asserted it was served and passed — because
 * that assertion calls `h.app.fetch`, the in-process Hono app, where the route
 * always exists. The platform routing layer is upstream of everything the
 * harness can see, and the runtime-smoke matrix boots each server directly,
 * so it does not exercise the routing configs either.
 *
 * A 200 carrying the wrong content-type is the worst shape this can take: no
 * error anywhere, the `<script>` tag simply does nothing, and the URL is one
 * the admin hands customers verbatim (`share-tab.tsx`).
 *
 * So this reads the three config FILES and compares them to each other. It
 * cannot boot Vercel's or Netlify's router, and does not pretend to — what it
 * pins is agreement, which is the property that was actually violated.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

const wrangler = read("apps/web/wrangler.toml");
const vercel = read("scripts/build-vercel-output.ts");
const netlify = read("netlify.toml");

/**
 * Paths the app serves ITSELF on every runtime, outside `/api/*`.
 *
 * Deliberately NOT derived from `run_worker_first`: that list also carries
 * `/embed/*`, `/f/*`, `/book/*` and `/b/*`, which are Cloudflare-only by
 * construction — they sit inside `if (env.ASSETS)` and exist so the worker can
 * stamp a framable CSP on a shell that Static Assets would otherwise serve
 * under the strict `_headers` policy. There is no ASSETS binding on Vercel or
 * Netlify, so routing those in would turn a working SPA fallback into a 404.
 * Only paths with a real handler on every target belong here.
 */
const SHARED_NON_API_PATHS = [
  { path: "/mcp", cf: '"/mcp"', vercel: "^/mcp", netlify: 'from = "/mcp"' },
  { path: "/health", cf: '"/health"', vercel: "^/health", netlify: 'from = "/health"' },
  {
    path: "/.well-known/*",
    cf: '"/.well-known/*"',
    vercel: "\\\\.well-known",
    netlify: 'from = "/.well-known/*"',
  },
  {
    path: "/embed/form.js",
    cf: '"/embed/*"',
    vercel: "embed/form",
    netlify: 'from = "/embed/form.js"',
  },
] as const;

describe("the non-/api paths reach the app on every target", () => {
  test("Cloudflare routes each of them to the worker", () => {
    for (const p of SHARED_NON_API_PATHS) {
      expect(`${p.path} in run_worker_first: ${wrangler.includes(p.cf)}`).toBe(
        `${p.path} in run_worker_first: true`,
      );
    }
  });

  test("Vercel routes each of them to the function", () => {
    // The failure this catches is silent: without a route, Vercel's
    // `^/(?!api/|assets/).*$` fallback answers index.html with a 200.
    for (const p of SHARED_NON_API_PATHS) {
      expect(`${p.path} in vercel routes: ${vercel.includes(p.vercel)}`).toBe(
        `${p.path} in vercel routes: true`,
      );
    }
  });

  test("Netlify routes each of them to the function", () => {
    for (const p of SHARED_NON_API_PATHS) {
      expect(`${p.path} in netlify redirects: ${netlify.includes(p.netlify)}`).toBe(
        `${p.path} in netlify redirects: true`,
      );
    }
  });

  test("and the SPA fallback that made the failure silent is still there", () => {
    // The premise of all three tests above. If either fallback were removed a
    // missing route would 404 loudly instead, and this file would be pinning a
    // hazard that no longer exists — which is worth knowing rather than
    // quietly passing.
    expect(vercel).toContain('src: "^/(?!api/|assets/).*$"');
    expect(netlify).toContain('from = "/*"');
  });
});

describe("the Cloudflare-only shell routes stay Cloudflare-only", () => {
  test("they are not routed on Vercel or Netlify, where there is no ASSETS binding", () => {
    // The inverse guard, and the reason SHARED_NON_API_PATHS is hand-written
    // rather than parsed out of `run_worker_first`. These four are registered
    // only under `if (env.ASSETS)`; routing them to the function on a target
    // without that binding replaces a working SPA fallback with a 404.
    for (const prefix of ["/f/", "/book/", "/b/"]) {
      expect(`${prefix} routed on vercel: ${vercel.includes(`^${prefix}`)}`).toBe(
        `${prefix} routed on vercel: false`,
      );
      expect(`${prefix} routed on netlify: ${netlify.includes(`from = "${prefix}*"`)}`).toBe(
        `${prefix} routed on netlify: false`,
      );
    }
    // `/embed/*` as a WILDCARD, specifically — the exact-path entry for
    // `/embed/form.js` above is required and must not be widened into one.
    expect(netlify).not.toContain('from = "/embed/*"');
    expect(vercel).not.toContain('"^/embed/(.*)$"');
  });

  test("the handlers really are ASSETS-gated, which is what makes that correct", () => {
    const app = read("apps/web/src/server/app.ts");
    const gate = app.indexOf("if (env.ASSETS) {");
    expect(gate).toBeGreaterThan(-1);
    // `/embed/form.js` is registered BEFORE the gate — it needs no binding,
    // which is why it is the one path of the five that every target can serve.
    expect(app.indexOf('app.get("/embed/form.js"')).toBeLessThan(gate);
    for (const route of ['app.get("/f/*"', 'app.get("/book/*"', 'app.get("/b/*"', 'app.get("/embed/*"']) {
      expect(`${route} is ASSETS-gated: ${app.indexOf(route) > gate}`).toBe(
        `${route} is ASSETS-gated: true`,
      );
    }
  });
});
