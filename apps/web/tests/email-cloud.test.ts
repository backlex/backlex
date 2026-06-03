import { afterEach, describe, expect, test } from "bun:test";
import { cloudEmailAdapter } from "../src/server/adapters/email.cloud";
import type { Env } from "../src/server/env";

// Managed-cloud env: HTTP delivery channel (no service binding) so the adapter
// uses global fetch, which we stub per-test.
const env = {
  CLOUD_REPORT_SECRET: "test-secret",
  CLOUD_PROJECT_ID: "proj_123",
  CLOUD_REPORT_URL: "https://cloud.test",
} as unknown as Env;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("cloudEmailAdapter", () => {
  test("signs and posts the message to the gateway", async () => {
    let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    await cloudEmailAdapter(env).send({
      to: "user@example.com",
      subject: "Hi",
      text: "Body",
      html: "<p>Body</p>",
    });

    expect(captured!.url).toContain("/api/internal/email/send");
    expect(captured!.body.to).toBe("user@example.com");
    expect(captured!.body.subject).toBe("Hi");
    expect(captured!.body.text).toBe("Body");
    expect(captured!.headers["X-Backlex-Project"]).toBe("proj_123");
    expect(captured!.headers["X-Backlex-Signature"]).toBeTruthy();
  });

  test("maps a 429 throttle to a validation error", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { code: "RATE_LIMITED", message: "Email send rate limit exceeded" } }, 429)) as typeof fetch;
    await expect(
      cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/rate limit/i);
  });

  test("throws on a gateway 500", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "boom" } }, 500)) as typeof fetch;
    await expect(
      cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/boom/);
  });
});
