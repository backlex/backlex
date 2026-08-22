/**
 * Cross-Origin-Resource-Policy on the surfaces a foreign page loads as a
 * `<script src>`.
 *
 * ── The bug this pins was LIVE, on three shipped features ─────────────────
 * `secureHeaders()` stamps `Cross-Origin-Resource-Policy: same-origin` on every
 * response. CORP is enforced on **no-cors** requests, and a classic
 * `<script src>` is exactly that — so the web-analytics tag, the tag-manager
 * container and the form embed loader were each served with a header
 * instructing the browser to discard them. Verified in a real browser across
 * two real origins (`127.0.0.1:5174` loading `localhost:5173`):
 * `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. Verified again against the
 * deployed worker, so it was not a local artifact.
 *
 * ── Why nothing caught it, which is the reusable part ─────────────────────
 * CORP has NO effect same-origin, and every check those features had was
 * same-origin. The in-process harness has no origin at all; a puppeteer pass
 * against localhost loads the tag from the page's own host. And the response
 * carries `Access-Control-Allow-Origin: *`, which looks like the cross-origin
 * story is handled — it is, for `fetch()`, because CORP does not apply to
 * CORS-mode requests. The gap is precisely the no-cors subresource, and an
 * assertion on the header is the only thing that reaches it from a unit test.
 *
 * So this file asserts the header directly, in both directions: relaxed where a
 * document is public by design, and left at `same-origin` everywhere else —
 * because a blanket relaxation is what would let a hostile page pull an
 * authenticated JSON response into itself as a no-cors subresource.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let SITE = "";

const anonFetch = (path: string): Promise<Response> =>
  h.app.fetch(
    new Request(`${h.env.APP_URL}${path}`, {
      headers: { Origin: "https://customer.example" },
    }),
  );

const corpOf = async (path: string): Promise<string | null> =>
  (await anonFetch(path)).headers.get("cross-origin-resource-policy");

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const res = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "corp", domain: "corp.example" }),
  });
  SITE = ((await res.json()) as any).data.id;
});

afterAll(() => h.cleanup());

test("the header is set at all, so neither assertion below is vacuous", async () => {
  // If `secureHeaders()` ever stops emitting CORP, every "is cross-origin"
  // assertion would still pass on a `null` that means something else entirely.
  // This is the premise, asserted rather than assumed.
  expect(await corpOf("/api/admin/analytics/sites")).toBe("same-origin");
});

test("every surface a foreign page loads as a subresource is cross-origin", async () => {
  const paths = [
    // The drop-in web-analytics tag, on the customer's own domain.
    "/api/analytics/script.js",
    // The tag-manager container for one site — a path PARAMETER, so it is
    // matched by prefix and a per-path entry would have missed it.
    `/api/analytics/tm/${SITE}.js`,
    // The consent config document. This one is read by `fetch()` and so was
    // never actually broken, but it is public by the same argument and a
    // banner loader may yet reach it as a subresource.
    "/api/consent/config",
    // Where a banner posts a decision. It takes `text/plain` precisely so
    // `navigator.sendBeacon` can fire it during unload, and a beacon is
    // no-cors — the same argument that relaxed `/api/analytics/collect`. It
    // was missed when this list was first written.
    "/api/consent/record",
    // The embeddable form loader — a `<script src>` that injects the iframe.
    "/embed/form.js",
  ];
  for (const path of paths) {
    expect(`${path} → ${await corpOf(path)}`).toBe(`${path} → cross-origin`);
  }
});

test("nothing else is relaxed", async () => {
  // The half that keeps the fix honest. Relaxing CORP globally would have made
  // the test above pass while removing the protection that stops a hostile page
  // pulling an authenticated response in as a no-cors subresource.
  const paths = [
    "/api/admin/consent/policies",
    "/api/admin/analytics/sites",
    "/api/collections",
    "/health",
    // Framable surfaces are deliberately NOT relaxed. CORP does not block a
    // cross-origin iframe unless the embedder sets COEP — which is why these
    // work today — and `/api/public/*` is fetched from inside an iframe whose
    // document origin is ours, so CORP never applies to it either. Widening the
    // predicate to `isFramable` would trade real protection for nothing.
    "/api/public/forms/does-not-exist",
  ];
  for (const path of paths) {
    expect(`${path} → ${await corpOf(path)}`).toBe(`${path} → same-origin`);
  }
});
