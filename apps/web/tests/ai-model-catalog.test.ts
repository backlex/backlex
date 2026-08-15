/**
 * AI provider registry + model catalog.
 *
 * Covers the edges the two-provider union used to hide:
 *  - the resolution order (workspace row → global row → deployment default),
 *    resolved PER FIELD so a workspace that set only a key still inherits the
 *    global default model
 *  - an unknown / absent provider degrading to the next level down instead of
 *    throwing and taking every AI feature offline
 *  - bare (unprefixed) model ids from pre-catalog settings still normalizing
 *    correctly in gateway mode, and a cross-vendor id NOT being forwarded to a
 *    direct provider that cannot run it
 *  - no stored secret — plaintext or ciphertext — appearing in any response
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  GLOBAL_AI_CONFIG_ID,
  resolveAiRuntime,
} from "../src/server/services/ai-config";
import {
  AI_MODELS,
  AI_PROVIDERS,
  getAiProvider,
  isAiSecretKey,
  modelsForProvider,
} from "../src/server/services/ai-providers";
import { resolveModelId, resolveAiCredential } from "../src/server/mcp/ai-client";
import { encryptSecret } from "../src/server/lib/crypto";
import type { Env } from "../src/server/env";

const putJson = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface AiConfigGet {
  data: {
    tenantId: string;
    provider: string;
    config: Record<string, unknown>;
    secretsSet: Record<string, boolean>;
    providerIds: string[];
    providers: {
      id: string;
      label: string;
      secretKey: string;
      secretLabel: string;
      envKey: string;
      transport: string;
      defaultModel: string;
      docsUrl: string;
    }[];
    models: { id: string; label: string; namespace: string; hint: string; tier: string }[];
    modelsByProvider: Record<string, string[]>;
  };
}

const getCfg = async (h: TestHarness): Promise<AiConfigGet["data"]> =>
  ((await (await h.fetch("/api/admin/ai-config")).json()) as AiConfigGet).data;

/** Write an `ai_config` row straight into the temp SQLite, which is the only
 *  way to create the instance-wide `_global` row (the admin PUT always scopes
 *  to the caller's tenant) or a provider id the PUT enum would reject. */
const writeConfigRow = async (
  h: TestHarness,
  tenantId: string,
  provider: string,
  opts: { model?: string; secrets?: Record<string, string> } = {},
) => {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.secrets ?? {})) {
    secrets[k] = await encryptSecret(v, h.env.AUTH_SECRET as string);
  }
  const raw = new Database(h.env.SQLITE_PATH as string, { readwrite: true });
  try {
    raw
      .query(
        `INSERT INTO ai_config (tenant_id, provider, config, secrets, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           provider = excluded.provider,
           config = excluded.config,
           secrets = excluded.secrets`,
      )
      .run(
        tenantId,
        provider,
        JSON.stringify(opts.model ? { model: opts.model } : {}),
        JSON.stringify(secrets),
        Date.now(),
      );
  } finally {
    raw.close();
  }
};

/** The active workspace id, as the routes see it. */
const tenantIdOf = async (h: TestHarness): Promise<string> =>
  (await getCfg(h)).tenantId;

describe("AI provider registry (pure)", () => {
  test("every provider declares a distinct id, secret key and env key", () => {
    const ids = AI_PROVIDERS.map((p) => p.id);
    const secretKeys = AI_PROVIDERS.map((p) => p.secretKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(secretKeys).size).toBe(secretKeys.length);
    expect(ids).toEqual(["gateway", "anthropic", "openai", "google"]);
    for (const p of AI_PROVIDERS) {
      expect(p.secretLabel.length).toBeGreaterThan(0);
      expect(p.defaultModel).toContain("/");
    }
  });

  test("getAiProvider treats inherit / empty / unknown as 'no provider', never a throw", () => {
    expect(getAiProvider("inherit")).toBeUndefined();
    expect(getAiProvider("")).toBeUndefined();
    expect(getAiProvider(null)).toBeUndefined();
    expect(getAiProvider(undefined)).toBeUndefined();
    // A provider id written by a NEWER build than the one reading it.
    expect(getAiProvider("bedrock")).toBeUndefined();
  });

  test("isAiSecretKey gates the PUT merge to registry keys only", () => {
    expect(isAiSecretKey("openaiKey")).toBe(true);
    expect(isAiSecretKey("googleKey")).toBe(true);
    expect(isAiSecretKey("__proto__")).toBe(false);
    expect(isAiSecretKey("AUTH_SECRET")).toBe(false);
  });

  test("a direct provider only offers its own namespace; the gateway offers all", () => {
    const anthropicOnly = modelsForProvider("anthropic");
    expect(anthropicOnly.length).toBeGreaterThan(0);
    expect(anthropicOnly.every((m) => m.namespace === "anthropic")).toBe(true);

    expect(modelsForProvider("openai").every((m) => m.namespace === "openai")).toBe(true);
    expect(modelsForProvider("google").every((m) => m.namespace === "google")).toBe(true);

    expect(modelsForProvider("gateway").length).toBe(AI_MODELS.length);
    // Unknown / inherit must not narrow to an empty list — the deployment
    // default could be any vendor, so hiding options there would be a lie.
    expect(modelsForProvider("inherit").length).toBe(AI_MODELS.length);
    expect(modelsForProvider("bedrock").length).toBe(AI_MODELS.length);
  });

  test("every catalog id is prefixed with its declared namespace", () => {
    for (const m of AI_MODELS) {
      expect(m.id.startsWith(`${m.namespace}/`)).toBe(true);
      expect(m.hint.length).toBeGreaterThan(0);
    }
  });

  test("every provider's default model is a row the picker can actually show", () => {
    // The admin picker filters the catalog by the chosen provider and preselects
    // that provider's `defaultModel`. A default missing from the catalog renders
    // as a blank selection that silently disagrees with what the server runs, so
    // the two lists have to be refreshed together when models are bumped.
    const catalogIds = new Set(AI_MODELS.map((m) => m.id));
    for (const p of AI_PROVIDERS) {
      expect(catalogIds.has(p.defaultModel)).toBe(true);
      if (p.transport === "direct")
        expect(modelsForProvider(p.id).map((m) => m.id)).toContain(p.defaultModel);
    }
  });
});

describe("model id normalization", () => {
  test("gateway mode still auto-prefixes a BARE id (pre-catalog stored settings)", () => {
    expect(resolveModelId("gateway", "claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(resolveModelId("gateway", "claude-haiku-4-5-20251001")).toBe(
      "anthropic/claude-haiku-4-5-20251001",
    );
  });

  test("gateway mode passes an already-prefixed id through untouched", () => {
    expect(resolveModelId("gateway", "openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(resolveModelId("gateway", "google/gemini-3.7-flash")).toBe(
      "google/gemini-3.7-flash",
    );
    expect(resolveModelId("gateway", undefined)).toBe("anthropic/claude-haiku-4-5");
  });

  test("a direct provider strips its OWN prefix and keeps its historic default", () => {
    expect(resolveModelId("anthropic", "anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
    expect(resolveModelId("anthropic", "claude-sonnet-5")).toBe("claude-sonnet-5");
    // The dated id the direct Anthropic path has always defaulted to.
    expect(resolveModelId("anthropic", undefined)).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelId("openai", "openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(resolveModelId("openai", undefined)).toBe("gpt-5.6-terra");
    expect(resolveModelId("google", "google/gemini-3.1-pro-preview")).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(resolveModelId("google", undefined)).toBe("gemini-3.7-flash");
  });

  test("a CROSS-vendor id is not forwarded to a direct provider that can't run it", () => {
    // Stale config: workspace was on the gateway with a GPT model, then moved
    // to a direct Anthropic key. Forwarding `openai/gpt-5.6-sol` would be a
    // guaranteed 404; falling back keeps generation alive.
    expect(resolveModelId("anthropic", "openai/gpt-5.6-sol")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveModelId("google", "anthropic/claude-sonnet-5")).toBe("gemini-3.7-flash");
  });
});

describe("credential resolution", () => {
  const base = { AUTH_SECRET: "x" } as unknown as Env;

  test("no credential at all resolves to null rather than throwing", () => {
    expect(resolveAiCredential(base)).toBeNull();
  });

  test("the historical auto-detect order is preserved", () => {
    expect(
      resolveAiCredential({ ...base, AI_GATEWAY_API_KEY: "gw", ANTHROPIC_API_KEY: "an" }),
    ).toEqual({ kind: "gateway", key: "gw" });
    expect(
      resolveAiCredential({ ...base, ANTHROPIC_API_KEY: "an", ANTHROPIC_AUTH_TOKEN: "tok" }),
    ).toEqual({ kind: "anthropic", key: "an" });
    expect(resolveAiCredential({ ...base, ANTHROPIC_AUTH_TOKEN: "tok" })).toEqual({
      kind: "anthropic",
      key: "tok",
      oauth: true,
    });
  });

  test("OPENAI_API_KEY alone is NOT promoted to the generation credential", () => {
    // It is already set on plenty of deployments purely for embeddings;
    // sniffing it would silently reroute (and re-bill) every AI feature and, on
    // managed cloud, bypass the metered platform gateway.
    expect(resolveAiCredential({ ...base, OPENAI_API_KEY: "sk-embeddings" })).toBeNull();
    expect(
      resolveAiCredential({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: "g" }),
    ).toBeNull();
  });

  test("AI_PROVIDER is the explicit opt-in for the direct openai / google paths", () => {
    expect(
      resolveAiCredential({ ...base, AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-gen" }),
    ).toEqual({ kind: "openai", key: "sk-gen" });
    expect(
      resolveAiCredential({
        ...base,
        AI_PROVIDER: "google",
        GOOGLE_GENERATIVE_AI_API_KEY: "g-key",
      }),
    ).toEqual({ kind: "google", key: "g-key" });
  });

  test("an unknown AI_PROVIDER, or one whose key is missing, falls back safely", () => {
    expect(
      resolveAiCredential({ ...base, AI_PROVIDER: "bedrock", ANTHROPIC_API_KEY: "an" }),
    ).toEqual({ kind: "anthropic", key: "an" });
    // Named provider, no key for it → keep looking rather than dying.
    expect(
      resolveAiCredential({ ...base, AI_PROVIDER: "google", AI_GATEWAY_API_KEY: "gw" }),
    ).toEqual({ kind: "gateway", key: "gw" });
    expect(resolveAiCredential({ ...base, AI_PROVIDER: "openai" })).toBeNull();
  });
});

describe("GET /api/admin/ai-config exposes the registry + catalog", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("providers, models and the per-provider model filter all ship", async () => {
    const d = await getCfg(h);
    expect(d.providerIds).toEqual(["inherit", "gateway", "anthropic", "openai", "google"]);
    expect(d.providers.map((p) => p.id)).toEqual([
      "gateway",
      "anthropic",
      "openai",
      "google",
    ]);
    const openai = d.providers.find((p) => p.id === "openai");
    expect(openai?.transport).toBe("direct");
    expect(openai?.envKey).toBe("OPENAI_API_KEY");
    expect(openai?.secretKey).toBe("openaiKey");

    expect(d.models.length).toBeGreaterThan(5);
    for (const m of d.models) {
      expect(typeof m.label).toBe("string");
      expect(typeof m.hint).toBe("string"); // the cost/speed tier line
    }
    expect(d.modelsByProvider.anthropic?.every((id) => id.startsWith("anthropic/"))).toBe(
      true,
    );
    expect(d.modelsByProvider.gateway?.length).toBe(d.models.length);
    expect(d.secretsSet).toMatchObject({
      gatewayKey: false,
      anthropicKey: false,
      openaiKey: false,
      googleKey: false,
    });
  });

  test("the new providers round-trip through PUT and never echo their keys", async () => {
    const put = await h.fetch(
      "/api/admin/ai-config",
      putJson({
        provider: "openai",
        config: { model: "openai/gpt-5.6-terra" },
        secrets: {
          openaiKey: "sk-openai-super-secret",
          googleKey: "goog-super-secret",
          // Not a registry key — must be silently dropped, not stored.
          bogusKey: "attacker-controlled",
        },
      }),
    );
    expect(put.status).toBe(200);

    const d = await getCfg(h);
    expect(d.provider).toBe("openai");
    expect(d.config.model).toBe("openai/gpt-5.6-terra");
    expect(d.secretsSet.openaiKey).toBe(true);
    expect(d.secretsSet.googleKey).toBe(true);
    expect("bogusKey" in d.secretsSet).toBe(false);

    // …and it must not have been WRITTEN either. `secretsSet` only reports
    // registry keys, so asserting on the response alone would pass even if the
    // merge loop happily persisted arbitrary caller-chosen keys into the
    // encrypted blob — read the stored row to actually prove the gate.
    const db = new Database(h.env.SQLITE_PATH as string, { readonly: true });
    try {
      const row = db
        .query("SELECT secrets FROM ai_config WHERE tenant_id = ?")
        .get(d.tenantId) as { secrets: string } | null;
      const storedKeys = Object.keys(JSON.parse(row?.secrets ?? "{}"));
      expect(storedKeys.sort()).toEqual(["googleKey", "openaiKey"]);
    } finally {
      db.close();
    }

    // Neither plaintext nor ciphertext may cross the wire, on ANY endpoint.
    const raw = JSON.stringify(d);
    expect(raw).not.toContain("sk-openai-super-secret");
    expect(raw).not.toContain("goog-super-secret");
    expect(raw).not.toContain("attacker-controlled");

    // …including the error body of the test endpoint, which touches the key.
    const testRes = await h.fetch("/api/admin/ai-config/test", { method: "POST" });
    const testBody = await testRes.text();
    expect(testBody).not.toContain("sk-openai-super-secret");
    expect(testBody).not.toContain("goog-super-secret");
  });

  test("an unknown provider id is rejected by the PUT enum", async () => {
    const put = await h.fetch(
      "/api/admin/ai-config",
      putJson({ provider: "bedrock", secrets: {} }),
    );
    expect(put.status).toBe(422);
  });
});

describe("resolveAiRuntime — workspace row → global row → deployment default", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness({ ANTHROPIC_API_KEY: "env-deployment-key" });
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const runtimeFor = async (tenantId: string | null) => {
    const ctx = await buildContext(h.env);
    return resolveAiRuntime(
      { db: ctx.db, dialect: ctx.dialect, env: h.env },
      tenantId ?? GLOBAL_AI_CONFIG_ID,
    );
  };

  test("with no rows at all, the deployment default is kept untouched", async () => {
    const rt = await runtimeFor(await tenantIdOf(h));
    expect(rt.provider).toBe("inherit");
    expect(rt.model).toBeUndefined();
    expect(rt.env).toBe(h.env); // no copy, no blanking
    expect(rt.env.ANTHROPIC_API_KEY).toBe("env-deployment-key");
  });

  test("the workspace row wins over the global row", async () => {
    const tenantId = await tenantIdOf(h);
    await writeConfigRow(h, GLOBAL_AI_CONFIG_ID, "anthropic", {
      model: "anthropic/claude-opus-5",
      secrets: { anthropicKey: "global-key" },
    });
    await writeConfigRow(h, tenantId, "openai", {
      model: "openai/gpt-5.6-terra",
      secrets: { openaiKey: "workspace-key" },
    });

    const rt = await runtimeFor(tenantId);
    expect(rt.provider).toBe("openai");
    expect(rt.model).toBe("openai/gpt-5.6-terra");
    expect(rt.env.OPENAI_API_KEY).toBe("workspace-key");
    expect(rt.env.AI_PROVIDER).toBe("openai");
    // The deployment's Anthropic key must NOT remain reachable — "my key" means
    // the workspace's key, never a silent fallback to the operator's identity.
    expect(rt.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(rt.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("a workspace row that picks NO provider falls through to the global row", async () => {
    const tenantId = await tenantIdOf(h);
    await writeConfigRow(h, GLOBAL_AI_CONFIG_ID, "gateway", {
      model: "google/gemini-3.7-flash",
      secrets: { gatewayKey: "global-gateway-key" },
    });
    // The workspace exists but explicitly inherits — the whole point of the
    // sentinel. The old first-row-wins read dead-ended here and silently
    // ignored the instance-wide key.
    await writeConfigRow(h, tenantId, "inherit");

    const rt = await runtimeFor(tenantId);
    expect(rt.provider).toBe("gateway");
    expect(rt.env.AI_GATEWAY_API_KEY).toBe("global-gateway-key");
    expect(rt.model).toBe("google/gemini-3.7-flash");
  });

  test("model and credential resolve per-field down the same chain", async () => {
    const tenantId = await tenantIdOf(h);
    await writeConfigRow(h, GLOBAL_AI_CONFIG_ID, "inherit", {
      model: "anthropic/claude-sonnet-5",
    });
    // Workspace brings a key but no model → it inherits the global model.
    await writeConfigRow(h, tenantId, "anthropic", {
      secrets: { anthropicKey: "workspace-anthropic" },
    });

    const rt = await runtimeFor(tenantId);
    expect(rt.provider).toBe("anthropic");
    expect(rt.env.ANTHROPIC_API_KEY).toBe("workspace-anthropic");
    expect(rt.model).toBe("anthropic/claude-sonnet-5");
  });

  test("a provider this build doesn't know degrades to the next level, not a throw", async () => {
    const tenantId = await tenantIdOf(h);
    await writeConfigRow(h, GLOBAL_AI_CONFIG_ID, "anthropic", {
      secrets: { anthropicKey: "global-anthropic" },
    });
    // Written by a newer build that shipped a provider this one lacks.
    await writeConfigRow(h, tenantId, "bedrock", {
      model: "bedrock/claude-x",
      secrets: { bedrockKey: "unusable" },
    });

    const rt = await runtimeFor(tenantId);
    expect(rt.provider).toBe("anthropic");
    expect(rt.env.ANTHROPIC_API_KEY).toBe("global-anthropic");
    // The model still comes from the most specific row: an id this build can't
    // classify is passed through, and `resolveModelId` guards the transport.
    expect(rt.model).toBe("bedrock/claude-x");
    expect(resolveModelId("anthropic", rt.model)).toBe("claude-haiku-4-5-20251001");
  });

  test("a stored secret that can't be decrypted degrades to inherit", async () => {
    const tenantId = await tenantIdOf(h);
    const raw = new Database(h.env.SQLITE_PATH as string, { readwrite: true });
    try {
      raw
        .query(
          `INSERT INTO ai_config (tenant_id, provider, config, secrets, updated_at)
           VALUES (?, 'anthropic', '{}', ?, ?)`,
        )
        .run(tenantId, JSON.stringify({ anthropicKey: "not-valid-ciphertext" }), Date.now());
    } finally {
      raw.close();
    }

    const rt = await runtimeFor(tenantId);
    expect(rt.provider).toBe("inherit");
    expect(rt.env.ANTHROPIC_API_KEY).toBe("env-deployment-key");
  });
});
