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
import { nextSyntheticIp } from "./setup";

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
