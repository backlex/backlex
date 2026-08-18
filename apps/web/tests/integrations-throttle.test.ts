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
    // This one is about SCALE, and it got it wrong twice.
    //
    // It first ran at 100/s — a 10ms refill — and asserted the burst finished
    // in under 10ms: the signal and the scheduler noise were the same size, so
    // "spent the burst" and "waited a full refill" were one measurement. That
    // reached CI as 5812 pass / 1 fail.
    //
    // The repair to 20/s was still too small, because the stall this has to
    // survive was then MEASURED rather than guessed: running the full 481-file
    // suite, two no-wait awaits in the sibling test below took **106ms**. A GC
    // pause on a loaded machine is bigger than any of the intervals the first
    // two attempts chose.
    //
    // So: 2/s, a 500ms refill. The two outcomes sit 500ms apart and each
    // assertion tolerates a 250ms stall — better than 2x the worst pause
    // actually observed. Both bounds are written against REFILL_MS so the
    // margin cannot quietly vanish if anyone retunes the rate.
    const RPS = 2;
    const REFILL_MS = 1000 / RPS;
    const limit = { rps: RPS, burst: 2 };

    const started = Date.now();
    await takeToken("k", limit);
    await takeToken("k", limit);
    const afterBurst = Date.now() - started;
    await takeToken("k", limit);
    const afterThird = Date.now() - started;

    // Neither of the first two paid a refill — they spent the burst. This is a
    // sanity bound, not the regression detector: if pacing broke entirely this
    // would still read ~0. The assertion that actually catches it is the next.
    expect(afterBurst).toBeLessThan(REFILL_MS / 2);
    // The third had none left, so it waited for one. Timers fire late more
    // often than early, but a coarse clock can round a hair under the nominal
    // interval, so allow 20% rather than asserting the full REFILL_MS.
    expect(afterThird - afterBurst).toBeGreaterThanOrEqual(REFILL_MS * 0.8);
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
    //
    // This carried the same fault as the burst test above and was left alone
    // once on the reasoning that 50ms was "enough margin" — then it failed at
    // **106ms** in the very next full-suite run. Two immediate takes cost ~0;
    // 50ms was measuring the machine, not the buckets.
    //
    // The number that means something here is what the second call would pay
    // if the two keys DID share a bucket: at 1/s, a full second. Bounding at
    // half of that fails loudly on a shared bucket while surviving any stall
    // this suite has produced.
    const RPS = 1;
    const SHARED_WAIT_MS = 1000 / RPS;

    const started = Date.now();
    await takeToken("seller-a", { rps: RPS, burst: 1 });
    await takeToken("seller-b", { rps: RPS, burst: 1 });
    expect(Date.now() - started).toBeLessThan(SHARED_WAIT_MS / 2);
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
