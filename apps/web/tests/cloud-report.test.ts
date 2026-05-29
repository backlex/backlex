import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reportToCloud } from "../src/server/lib/cloud-report";
import type { Env } from "../src/server/env";

const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("reportToCloud — opt-in", () => {
  test("no-op when env is undefined", async () => {
    expect(reportToCloud(undefined, { kind: "error", message: "x" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("no-op when CLOUD_REPORT_* are unset (self-hosted)", async () => {
    const env = {} as Env;
    expect(reportToCloud(env, { kind: "ai_usage", tokensIn: 1, tokensOut: 2 })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("no-op when only some vars are set", async () => {
    const env = { CLOUD_REPORT_URL: "https://cloud.example.com" } as Env;
    expect(reportToCloud(env, { kind: "error", message: "x" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("sends an HMAC-signed POST when fully provisioned", async () => {
    const env = {
      CLOUD_REPORT_URL: "https://cloud.example.com/",
      CLOUD_REPORT_SECRET: "rs_secret",
      CLOUD_PROJECT_ID: "proj_123",
    } as Env;
    const p = reportToCloud(env, { kind: "error", message: "boom", route: "GET /x", status: 500 });
    expect(p).toBeDefined();
    await p;
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("https://cloud.example.com/api/webhooks/tenant-report");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Backlex-Project")).toBe("proj_123");
    expect(headers.get("X-Backlex-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(init?.body).toBe(JSON.stringify({ kind: "error", message: "boom", route: "GET /x", status: 500 }));
  });

  test("prefers the service binding over HTTP when both are present", async () => {
    const serviceCalls: { url: string; init?: RequestInit }[] = [];
    const env = {
      CLOUD_REPORT_URL: "https://cloud.example.com",
      CLOUD_REPORT_SECRET: "rs_secret",
      CLOUD_PROJECT_ID: "proj_123",
      CLOUD_REPORT_SERVICE: {
        fetch: async (req: Request) => {
          serviceCalls.push({ url: req.url, init: { method: req.method } });
          return new Response(null, { status: 202 });
        },
      },
    } as unknown as Env;
    const p = reportToCloud(env, { kind: "error", message: "via binding" });
    expect(p).toBeDefined();
    await p;
    // Service binding used; global fetch untouched.
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]?.url).toBe("https://cloud-report.internal/api/webhooks/tenant-report");
    expect(calls).toHaveLength(0);
  });

  test("no-op when secret/project present but neither service nor URL is set", async () => {
    const env = { CLOUD_REPORT_SECRET: "s", CLOUD_PROJECT_ID: "p" } as Env;
    expect(reportToCloud(env, { kind: "error", message: "x" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("swallows fetch failures (fire-and-forget)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const env = {
      CLOUD_REPORT_URL: "https://cloud.example.com",
      CLOUD_REPORT_SECRET: "rs_secret",
      CLOUD_PROJECT_ID: "proj_123",
    } as Env;
    await expect(reportToCloud(env, { kind: "ai_usage", tokensIn: 10 })).resolves.toBeUndefined();
  });
});
