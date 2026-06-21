import { describe, expect, test } from "bun:test";
import { apiRateLimitConfig } from "../src/server/lib/api-rate-limit";
import type { Env } from "../src/server/env";
import { makeHarness } from "./setup";

const baseEnv = (over: Partial<Env> = {}): Env =>
  ({ APP_URL: "http://x", AUTH_SECRET: "s", ...over }) as Env;

describe("apiRateLimitConfig", () => {
  test("off by default on self-host (no flags)", () => {
    const cfg = apiRateLimitConfig(baseEnv());
    expect(cfg.enabled).toBe(false);
  });

  test("auto-enables on managed cloud (CLOUD_PROJECT_ID) with default budget", () => {
    const cfg = apiRateLimitConfig(baseEnv({ CLOUD_PROJECT_ID: "proj_1" }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.max).toBe(600);
    expect(cfg.windowMs).toBe(60_000);
  });

  test("setting API_RATE_LIMIT_MAX enables it anywhere + overrides the budget", () => {
    const cfg = apiRateLimitConfig(baseEnv({ API_RATE_LIMIT_MAX: "120" }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.max).toBe(120);
  });

  test("API_RATE_LIMIT_DISABLED forces off even on cloud", () => {
    const cfg = apiRateLimitConfig(
      baseEnv({ CLOUD_PROJECT_ID: "proj_1", API_RATE_LIMIT_DISABLED: "true" }),
    );
    expect(cfg.enabled).toBe(false);
  });

  test("non-positive / garbage values fall back to defaults", () => {
    const cfg = apiRateLimitConfig(
      baseEnv({ API_RATE_LIMIT_MAX: "0", API_RATE_LIMIT_WINDOW_MS: "nope" }),
    );
    // max=0 still enables (the key was explicitly set) but clamps to default.
    expect(cfg.enabled).toBe(true);
    expect(cfg.max).toBe(600);
    expect(cfg.windowMs).toBe(60_000);
  });
});

describe("global API rate limit middleware", () => {
  test("does nothing when disabled (no RateLimit headers, never 429s)", async () => {
    const h = makeHarness();
    try {
      for (let i = 0; i < 5; i++) {
        const res = await h.fetch("/api/collections");
        expect(res.status).toBe(200);
        expect(res.headers.get("RateLimit-Limit")).toBeNull();
      }
    } finally {
      h.cleanup();
    }
  });

  test("emits RateLimit-* headers and 429s past the budget", async () => {
    const h = makeHarness({ API_RATE_LIMIT_MAX: "3" });
    try {
      const r1 = await h.fetch("/api/collections");
      expect(r1.status).toBe(200);
      expect(r1.headers.get("RateLimit-Limit")).toBe("3");
      expect(r1.headers.get("RateLimit-Remaining")).toBe("2");

      const r2 = await h.fetch("/api/collections");
      expect(r2.status).toBe(200);
      expect(r2.headers.get("RateLimit-Remaining")).toBe("1");

      const r3 = await h.fetch("/api/collections");
      expect(r3.status).toBe(200);
      expect(r3.headers.get("RateLimit-Remaining")).toBe("0");

      // 4th call exhausts the window → 429 with Retry-After + error envelope.
      const r4 = await h.fetch("/api/collections", {
        headers: { "x-request-id": "rl-trace-1" },
      });
      expect(r4.status).toBe(429);
      expect(r4.headers.get("RateLimit-Remaining")).toBe("0");
      expect(Number(r4.headers.get("Retry-After"))).toBeGreaterThanOrEqual(0);
      const body = (await r4.json()) as {
        error?: { code?: string };
        requestId?: string;
      };
      expect(body.error?.code).toBe("RATE_LIMITED");
      expect(body.requestId).toBe("rl-trace-1");
      expect(r4.headers.get("x-request-id")).toBe("rl-trace-1");
    } finally {
      h.cleanup();
    }
  });

  test("auto-enabled on cloud surfaces the default 600 budget on a normal call", async () => {
    const h = makeHarness({ CLOUD_PROJECT_ID: "proj_smoke" });
    try {
      const res = await h.fetch("/api/collections");
      expect(res.status).toBe(200);
      expect(res.headers.get("RateLimit-Limit")).toBe("600");
    } finally {
      h.cleanup();
    }
  });

  test("health checks are never gated by the API limiter", async () => {
    // A tiny budget that an /api/* path would blow past immediately must not
    // affect /health (it lives outside /api/*).
    const h = makeHarness({ API_RATE_LIMIT_MAX: "1" });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await h.fetch("/health");
        expect(res.status).toBe(200);
        expect(res.headers.get("RateLimit-Limit")).toBeNull();
      }
    } finally {
      h.cleanup();
    }
  });
});
