/**
 * Two harnesses must not share a rate-limit bucket — including when a spec
 * drives the app through `h.app.request()` rather than the cookie-jar `fetch`.
 *
 * `withSyntheticIp` exists precisely for this, and its own docblock names the
 * population it is protecting: "~43 specs hand-roll their own `request()`
 * helper ... every one of them sets `Origin` and `Cookie` and nothing else. So
 * they reached the auth limiter as IP `"unknown"`: not one bucket per spec, ONE
 * BUCKET FOR ALL OF THEM."
 *
 * The mitigation wraps `fetch`. Those specs call `request`, and a Proxy `get`
 * trap that returns the real `request` cannot intercept the `this.fetch` it
 * makes internally — so the population the docblock names was never covered.
 */
import { describe, expect, test } from "bun:test";
import { makeHarness } from "./setup";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Origin: "http://localhost:5173",
};

const signUp = (h: ReturnType<typeof makeHarness>, email: string) =>
  h.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "x" }),
  });

describe("harness synthetic IP reaches app.request, not only app.fetch", () => {
  test("one harness exhausting the signup budget does not 429 another", async () => {
    const a = makeHarness();
    const b = makeHarness();
    try {
      // `signup` is max 5 per minute per IP (`lib/auth-rate-limit.ts`). Spend
      // well past it on A. The calls may fail for other reasons (duplicate
      // email, closed signup) — the limiter counts REQUESTS, so that is fine.
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await signUp(a, `flood-${i}@x.test`)).status);
      }
      // Sanity: A really did hit the limiter, or this test proves nothing.
      expect(statuses).toContain(429);

      // B is a different harness with its own synthetic IP, so its budget is
      // untouched. Anything but 429 is a pass — B's own signup may legitimately
      // fail on policy (signup closes after the first user); what must not
      // happen is A's spending deciding it.
      const first = await signUp(b, "fresh@x.test");
      expect(first.status).not.toBe(429);

      // Control, so this cannot pass by the limiter having stopped working.
      // A is still over budget in the same window, and must still be refused.
      // Without it, a test asserting only "B is not 429" would go green if the
      // limiter were disabled entirely — which is the failure this whole file
      // exists to catch a version of.
      const stillLimited = await signUp(a, "flood-after@x.test");
      expect(stillLimited.status).toBe(429);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
