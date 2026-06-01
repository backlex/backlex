import { afterEach, describe, expect, test } from "bun:test";
import { cloudEmbeddingAdapter } from "../src/server/adapters/embedding.cloud";
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

describe("cloudEmbeddingAdapter", () => {
  test("signs and posts to the gateway, maps the model, returns vectors", async () => {
    let captured: { url: string; body: { model?: string; texts?: string[] }; headers: Record<string, string> } | null =
      null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return jsonResponse({ model: "@cf/baai/bge-m3", dimensions: 1024, data: [new Array(1024).fill(0.1)], neurons: 5 });
    }) as typeof fetch;

    const res = await cloudEmbeddingAdapter(env).embed({ model: "bge-m3", texts: ["hello"] });

    expect(res.model).toBe("bge-m3");
    expect(res.values).toHaveLength(1);
    expect(res.values[0]).toHaveLength(1024);
    expect(captured!.url).toContain("/api/internal/ai/embed");
    // OSS model key → Cloudflare providerModel before crossing the wire.
    expect(captured!.body.model).toBe("@cf/baai/bge-m3");
    expect(captured!.headers["X-Backlex-Project"]).toBe("proj_123");
    expect(captured!.headers["X-Backlex-Signature"]).toBeTruthy();
  });

  test("surfaces a 402 budget-exhausted error", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { code: "BILLING_REQUIRED", message: "monthly AI budget is exhausted" } }, 402)) as typeof fetch;
    await expect(cloudEmbeddingAdapter(env).embed({ model: "bge-m3", texts: ["x"] })).rejects.toThrow(
      /budget is exhausted/,
    );
  });

  test("rejects a dimension mismatch from the gateway", async () => {
    globalThis.fetch = (async () => jsonResponse({ data: [[0.1, 0.2]] })) as typeof fetch;
    await expect(cloudEmbeddingAdapter(env).embed({ model: "bge-m3", texts: ["x"] })).rejects.toThrow(/dimensions/);
  });
});
