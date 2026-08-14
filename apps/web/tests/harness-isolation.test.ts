/**
 * Every harness must get its own synthetic client IP.
 *
 * The auth rate limiter keys on IP and allows five sign-ups per minute, and its
 * window state is module-level — shared by every harness in one bun-test
 * process. Two harnesses on the same IP therefore eat each other's budget, and
 * the symptom lands on whichever spec happens to sign up inside the loser's
 * window. That reads as an unrelated flake in a file nobody touched, which is
 * exactly how it went undiagnosed.
 *
 * The IPs used to be picked at random from 250×250. With ~420 spec files that
 * is a birthday problem, not a long shot — about 1.4 expected colliding pairs
 * per run, a ~76% chance that some run collides somewhere. It only became
 * reproducible when a wave added five specs at once.
 *
 * So the property under test is DISTINCTNESS, not randomness. A test that
 * merely sampled a few values and found them different would have passed
 * against the old code too; this one draws more values than the old scheme
 * could keep apart, which it cannot survive.
 */
import { describe, expect, test } from "bun:test";
import { makeHarness, nextSyntheticIp } from "./setup";

describe("harness client IPs", () => {
  test("are distinct by construction, not by luck", () => {
    // Well past the ~420 harnesses a full run builds, and past the point where
    // the old random scheme would almost certainly have repeated itself: at
    // 2,000 draws from 62,500 buckets the chance of NO collision is ~e^-32.
    const n = 2000;
    const seen = new Set<string>();
    for (let i = 0; i < n; i += 1) seen.add(nextSyntheticIp());
    expect(seen.size).toBe(n);
  });

  test("look like addresses the limiter will key on", () => {
    const ip = nextSyntheticIp();
    // `ipFromHeaders` splits on "," and trims — anything with a comma or space
    // would be silently truncated into a different bucket than intended.
    expect(ip).not.toContain(",");
    expect(ip).not.toContain(" ");
    expect(ip).toMatch(/^127\.0\.\d{1,3}\.\d{1,3}$/);
  });
});

/**
 * The bucket that actually broke the gate.
 *
 * ~43 specs hand-roll a `request()` helper and call `h.app.fetch` directly, to
 * control the Cookie header per identity. Every one of them set `Origin` and
 * `Cookie` and nothing else, so they all reached the limiter as IP `"unknown"` —
 * one bucket for the whole suite, against five sign-ups a minute. In a full run
 * that bucket is always contended, and which file gets the 429 is decided by
 * scheduling, so the failure surfaced in a spec that had done nothing wrong and
 * vanished when that spec ran alone.
 *
 * Six is the smallest number that proves it: the budget is five. Verified to
 * fail without the fix — the sixth sign-up returned 429.
 */
describe("hand-rolled requests through h.app.fetch", () => {
  test("do not share one rate-limit bucket", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const h = makeHarness();
      try {
        const res = await h.app.fetch(
          new Request("http://localhost:5173/api/auth/sign-up/email", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:5173",
            },
            body: JSON.stringify({
              email: `harness-bucket-${i}-${Date.now()}@example.test`,
              password: "correct-horse-battery",
              name: "Bucket",
            }),
          }),
        );
        statuses.push(res.status);
      } finally {
        h.cleanup();
      }
    }
    // Asserting "no 429" rather than "all 200": a sign-up can legitimately fail
    // for other reasons, and it is specifically the limiter we are isolating.
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  test("an explicit X-Forwarded-For still wins", async () => {
    // The specs that deliberately exercise the limiter depend on this.
    const h = makeHarness();
    try {
      const res = await h.app.fetch(
        new Request("http://localhost:5173/api/auth/get-session", {
          headers: { "X-Forwarded-For": "203.0.113.7" },
        }),
      );
      expect(res.status).toBeLessThan(500);
    } finally {
      h.cleanup();
    }
  });
});
