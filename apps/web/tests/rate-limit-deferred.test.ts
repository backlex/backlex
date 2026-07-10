/**
 * Non-blocking (deferred) rate limiter — `rateLimitCheckDeferred`.
 *
 * The global API limiter answers from the last Durable Object snapshot and
 * syncs the DO in the background (waitUntil), so these tests drive the
 * function directly with a stubbed `RATE_LIMIT` namespace and a captured
 * `defer` to control exactly when the background sync "lands".
 *
 * Module-level windows/snapshots persist across the bun-test process, so each
 * test uses its own unique key.
 */
import { describe, expect, test } from "bun:test";
import type { Env } from "../src/server/env";
import { rateLimitCheckDeferred } from "../src/server/lib/rate-limit";

interface DoAnswer {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/** Stub DO namespace whose /check always returns the current `answer`. */
const makeNs = (answer: () => DoAnswer): DurableObjectNamespace =>
  ({
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => Response.json(answer()),
    }),
  }) as unknown as DurableObjectNamespace;

const envWith = (ns: DurableObjectNamespace): Env =>
  ({ APP_URL: "http://x", AUTH_SECRET: "s", RATE_LIMIT: ns }) as Env;

/** Collects deferred work so a test can decide when the DO sync completes. */
const captureDefer = () => {
  const work: Promise<unknown>[] = [];
  return {
    defer: (p: Promise<unknown>) => work.push(p),
    flush: () => Promise.all(work),
    count: () => work.length,
  };
};

describe("rateLimitCheckDeferred", () => {
  test("first call is allowed before any snapshot exists (fail open) and schedules a DO sync", () => {
    const ns = makeNs(() => ({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 }));
    const d = captureDefer();
    const r = rateLimitCheckDeferred(envWith(ns), "dfr:first", 600, 60_000, d.defer);
    expect(r.allowed).toBe(true);
    expect(d.count()).toBe(1);
  });

  test("blocks once the landed snapshot says the window is exhausted", async () => {
    const resetAt = Date.now() + 60_000;
    const ns = makeNs(() => ({ allowed: true, remaining: 0, resetAt }));
    const d = captureDefer();
    const env = envWith(ns);

    // Call 1: no snapshot yet → allowed; its sync lands `remaining: 0`.
    expect(rateLimitCheckDeferred(env, "dfr:exhaust", 3, 60_000, d.defer).allowed).toBe(true);
    await d.flush();

    // Call 2: snapshot says 0 remaining → blocked, with the DO's resetAt.
    const r2 = rateLimitCheckDeferred(env, "dfr:exhaust", 3, 60_000, d.defer);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
    expect(r2.resetAt).toBe(resetAt);
  });

  test("an expired snapshot is ignored — the next window opens again", async () => {
    const resetAt = Date.now() - 1_000; // already past: a closed window
    const ns = makeNs(() => ({ allowed: false, remaining: 0, resetAt }));
    const d = captureDefer();
    const env = envWith(ns);

    expect(rateLimitCheckDeferred(env, "dfr:expired", 600, 60_000, d.defer).allowed).toBe(true);
    await d.flush();
    // Snapshot landed but its window is over → verdict falls back to local.
    const r = rateLimitCheckDeferred(env, "dfr:expired", 600, 60_000, d.defer);
    expect(r.allowed).toBe(true);
  });

  test("the per-isolate window still bounds a burst while no snapshot has landed", () => {
    const ns = makeNs(() => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 }));
    const d = captureDefer();
    const env = envWith(ns);
    // Never flush: the DO answer stays in flight for the whole burst.
    expect(rateLimitCheckDeferred(env, "dfr:burst", 2, 60_000, d.defer).allowed).toBe(true);
    expect(rateLimitCheckDeferred(env, "dfr:burst", 2, 60_000, d.defer).allowed).toBe(true);
    expect(rateLimitCheckDeferred(env, "dfr:burst", 2, 60_000, d.defer).allowed).toBe(false);
  });

  test("reports the tighter remaining of snapshot vs local estimate", async () => {
    const ns = makeNs(() => ({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 }));
    const d = captureDefer();
    const env = envWith(ns);
    rateLimitCheckDeferred(env, "dfr:tight", 600, 60_000, d.defer);
    await d.flush();
    // Local window has ~599 left; the DO snapshot says 1 → report 1.
    const r = rateLimitCheckDeferred(env, "dfr:tight", 600, 60_000, d.defer);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  test("without a RATE_LIMIT binding it is the plain local window (no defer)", () => {
    const d = captureDefer();
    const env = { APP_URL: "http://x", AUTH_SECRET: "s" } as Env;
    const r1 = rateLimitCheckDeferred(env, "dfr:local", 2, 60_000, d.defer);
    const r2 = rateLimitCheckDeferred(env, "dfr:local", 2, 60_000, d.defer);
    const r3 = rateLimitCheckDeferred(env, "dfr:local", 2, 60_000, d.defer);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
    expect(r3.allowed).toBe(false);
    expect(d.count()).toBe(0);
  });
});
