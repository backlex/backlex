import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const putJson = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface AiConfigGet {
  data: {
    provider: string;
    config: Record<string, unknown>;
    secretsSet: { gatewayKey: boolean; anthropicKey: boolean };
    env: { cloud: boolean; hasGatewayKey: boolean; hasAnthropicKey: boolean };
    providerIds: string[];
  };
}

describe("AI provider config (bring-your-own key)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("defaults to inherit with no keys set on a self-host harness", async () => {
    const get = await h.fetch("/api/admin/ai-config");
    expect(get.status).toBe(200);
    const cfg = (await get.json()) as AiConfigGet;
    expect(cfg.data.provider).toBe("inherit");
    expect(cfg.data.secretsSet.gatewayKey).toBe(false);
    expect(cfg.data.secretsSet.anthropicKey).toBe(false);
    expect(cfg.data.env.cloud).toBe(false);
    expect(cfg.data.providerIds).toContain("anthropic");
  });

  test("PUT round-trips and the key ciphertext never surfaces", async () => {
    const put = await h.fetch(
      "/api/admin/ai-config",
      putJson({
        provider: "anthropic",
        config: { model: "claude-haiku-4-5-20251001" },
        secrets: { anthropicKey: "sk-ant-super-secret" },
      }),
    );
    expect(put.status).toBe(200);

    const get = await h.fetch("/api/admin/ai-config");
    const cfg = (await get.json()) as AiConfigGet;
    expect(cfg.data.provider).toBe("anthropic");
    expect(cfg.data.secretsSet.anthropicKey).toBe(true);
    expect(cfg.data.config.model).toBe("claude-haiku-4-5-20251001");
    // ciphertext / plaintext key must never come back
    expect(JSON.stringify(cfg.data)).not.toContain("sk-ant-super-secret");
  });

  test("a stored key is kept when secrets are omitted, and cleared with empty string", async () => {
    await h.fetch(
      "/api/admin/ai-config",
      putJson({ provider: "gateway", secrets: { gatewayKey: "gw-key-123" } }),
    );

    // Omitting secrets on a later PUT must not wipe the stored key.
    await h.fetch("/api/admin/ai-config", putJson({ provider: "gateway" }));
    let cfg = (await (await h.fetch("/api/admin/ai-config")).json()) as AiConfigGet;
    expect(cfg.data.secretsSet.gatewayKey).toBe(true);

    // Explicit empty string clears it.
    await h.fetch(
      "/api/admin/ai-config",
      putJson({ provider: "inherit", secrets: { gatewayKey: "" } }),
    );
    cfg = (await (await h.fetch("/api/admin/ai-config")).json()) as AiConfigGet;
    expect(cfg.data.secretsSet.gatewayKey).toBe(false);
    expect(cfg.data.provider).toBe("inherit");
  });

  test("the config routes require an admin session", async () => {
    const anon = makeHarness();
    try {
      const get = await anon.fetch("/api/admin/ai-config");
      expect(get.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
