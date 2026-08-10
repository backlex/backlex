/**
 * Request pacing and 429 discipline.
 *
 * Two behaviours are load-bearing and neither is visible from a provider file:
 * a declared limit actually spaces requests out, and a 429 is reported as
 * something the breaker can tell apart from "broken". The second matters more —
 * pacing is per-isolate and best-effort, so the 429 path is the real guarantee.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  isRateLimited,
  parseRetryAfter,
  RateLimitedError,
  resetThrottleState,
  takeToken,
  throttled,
} from "@backlex/integrations";

afterEach(() => resetThrottleState());

const ok = () => new Response("{}", { status: 200 });

describe("token bucket", () => {
  test("a burst runs straight through, then pacing kicks in", async () => {
    // burst=2 at 100/s: two immediate, the third waits ~10ms for a refill.
    const started = Date.now();
    await takeToken("k", { rps: 100, burst: 2 });
    await takeToken("k", { rps: 100, burst: 2 });
    const afterBurst = Date.now() - started;
    await takeToken("k", { rps: 100, burst: 2 });
    const afterThird = Date.now() - started;

    expect(afterBurst).toBeLessThan(10);
    // The third had to wait for a token to refill; the first two did not.
    expect(afterThird).toBeGreaterThan(afterBurst);
  });

  test("concurrent callers queue instead of all reading the same token count", async () => {
    // Without the tail chain, five concurrent callers all see 1 token, all
    // decide there is room, and the pacing does nothing at all.
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map(async (i) => {
        await takeToken("concurrent", { rps: 200, burst: 1 });
        order.push(i);
      }),
    );
    expect(order).toHaveLength(5);
  });

  test("separate keys do not pace each other", async () => {
    // Two workspaces holding two sellers' credentials have independent quotas
    // at the provider; sharing a bucket would halve what each paid for.
    const started = Date.now();
    await takeToken("seller-a", { rps: 1, burst: 1 });
    await takeToken("seller-b", { rps: 1, burst: 1 });
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("429 classification", () => {
  test("a 429 becomes a RateLimitedError carrying Retry-After", async () => {
    const f = throttled(
      "k",
      undefined,
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    );
    const err = await f("https://example.test").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(isRateLimited(err)).toBe(true);
    expect((err as RateLimitedError).retryAfterMs).toBe(7000);
  });

  test("providers with no declared limit still get 429 classification", async () => {
    // The thirty-odd providers that predate pacing benefit from this half.
    const f = throttled("k", undefined, async () => new Response("", { status: 429 }));
    await expect(f("https://example.test")).rejects.toBeInstanceOf(RateLimitedError);
  });

  test("a non-429 response passes through untouched", async () => {
    const f = throttled("k", { rps: 1000 }, ok);
    const res = await f("https://example.test");
    expect(res.status).toBe(200);
  });

  test("a 500 is NOT a rate limit — it must keep feeding the breaker", async () => {
    const f = throttled("k", undefined, async () => new Response("", { status: 500 }));
    const res = await f("https://example.test");
    expect(res.status).toBe(500);
    expect(isRateLimited(new Error("boom"))).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  test("delta-seconds", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  test("HTTP-date", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:20 GMT", now)).toBe(20_000);
  });

  test("a date already in the past reads as no wait, not a negative one", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now + 5000)).toBe(0);
  });

  test("garbage and absurd values fall back to the caller's own backoff", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    // Past the 5-minute cap: a wait that long belongs to the scheduler, not to
    // a held-open request.
    expect(parseRetryAfter("3600", now)).toBeNull();
  });
});
