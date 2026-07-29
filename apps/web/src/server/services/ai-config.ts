import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";
import { getAiProvider, type AiProviderId } from "./ai-providers";

/**
 * Tenant id of the instance-wide `ai_config` row — the fallback used when a
 * workspace hasn't set its own AI key. Mirrors the `_global` sentinel the
 * email/auth config layers already use.
 */
export const GLOBAL_AI_CONFIG_ID = "_global";

/** Providers a workspace can pick. `inherit` means "no pick — use whatever the
 *  next level down resolves to" (the global row, then the deployment env). */
export type AiProvider = "inherit" | AiProviderId;

export {
  AI_PROVIDERS,
  AI_PROVIDER_IDS,
  AI_SECRET_KEYS,
  getAiProvider,
  isAiSecretKey,
  type AiProviderDef,
  type AiProviderId,
} from "./ai-providers";

/** Secret key name, e.g. `gatewayKey`. Kept loose (`string`) because the set is
 *  registry-driven and grows without a type change at every callsite. */
export type AiSecretKey = string;

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.aiConfig : sqlite.schema.aiConfig;

interface AiConfigRow {
  tenantId: string;
  provider: string;
  config: Record<string, unknown> | null;
  secrets: Record<string, string> | null;
  updatedAt: unknown;
}

type Ctx = { db: unknown; dialect: "pg" | "sqlite"; env: Env };

/**
 * Load the stored `ai_config` rows for a workspace, most specific first:
 * the workspace row, then the instance-wide ({@link GLOBAL_AI_CONFIG_ID}) row.
 * Returns `[]` when neither exists or the table isn't migrated yet (callers
 * then keep the deployment default).
 *
 * Returning the CHAIN rather than only the first hit is what makes `inherit`
 * mean what it says: a workspace row that picks no provider (or names one whose
 * key is missing) falls through to the global row instead of dead-ending.
 */
export const loadAiConfigChain = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string | null | undefined,
): Promise<AiConfigRow[]> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_AI_CONFIG_ID
      ? [tenantId, GLOBAL_AI_CONFIG_ID]
      : [GLOBAL_AI_CONFIG_ID];
  const out: AiConfigRow[] = [];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as AiConfigRow[];
      if (rows[0]) out.push(rows[0]);
    } catch {
      return out; // table not migrated yet
    }
  }
  return out;
};

/**
 * The single most specific stored row, or `null`. Kept for callers that want
 * the raw row (the admin GET reads the workspace row directly).
 */
export const loadAiConfigRow = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string | null | undefined,
): Promise<AiConfigRow | null> =>
  (await loadAiConfigChain(ctx, tenantId))[0] ?? null;

/**
 * The decrypted bring-your-own key for a workspace, or `null` when the
 * workspace inherits the deployment default. Only the key matching the chosen
 * provider is returned.
 */
export interface AiOverride {
  provider: AiProviderId;
  key: string;
}

/** Decrypt the secret a row's chosen provider needs. `null` when the row picks
 *  no provider, picks one this build doesn't know, or has no stored secret for
 *  it — every one of those means "keep looking / inherit", never an error. */
const overrideFromRow = async (
  env: Env,
  row: AiConfigRow,
): Promise<AiOverride | null> => {
  const def = getAiProvider(row.provider);
  if (!def) return null; // "inherit", empty, or a provider from a newer build
  const enc = row.secrets?.[def.secretKey];
  if (typeof enc !== "string" || !enc) return null;
  try {
    const key = await decryptSecret(enc, env.AUTH_SECRET);
    if (!key) return null;
    return { provider: def.id, key };
  } catch {
    return null;
  }
};

/**
 * Resolve a workspace's BYO AI key, walking workspace row → global row.
 * Returns `null` (inherit the deployment default) when no row in the chain
 * names a usable provider. Never throws — a read/decrypt failure degrades to
 * inherit so AI generation keeps working.
 */
export const resolveAiOverride = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<AiOverride | null> => {
  for (const row of await loadAiConfigChain(ctx, tenantId)) {
    const override = await overrideFromRow(ctx.env, row);
    if (override) return override;
  }
  return null;
};

/** Read a stored default model id out of a row's non-secret `config` blob. */
const modelFromConfig = (config: Record<string, unknown> | null): string | undefined => {
  const m = config?.model;
  return typeof m === "string" && m.trim() ? m.trim() : undefined;
};

/**
 * Overlay a resolved BYO key onto an `Env` so the shared `callClaude` path uses
 * it. The chosen provider's env key is set, `AI_PROVIDER` pins the pick, and
 * every OTHER provider credential is blanked — so the workspace's explicit
 * choice wins over any ambient deployment key and (via `callClaude`'s
 * direct-key-first ordering) bypasses the managed cloud gateway.
 *
 * Blanking matters twice over: "my key" must mean the workspace's key, never a
 * silent fallback to the operator's identity, and `OPENAI_API_KEY` may be
 * present for embeddings on a deployment whose generation should stay Anthropic.
 */
export const applyAiOverride = (env: Env, override: AiOverride): Env => {
  const def = getAiProvider(override.provider);
  const next: Env = {
    ...env,
    AI_PROVIDER: override.provider,
    AI_GATEWAY_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  };
  // `OPENAI_API_KEY` is deliberately NOT blanked: it doubles as the embeddings
  // credential, and `AI_PROVIDER` already makes the generation pick
  // unambiguous, so clearing it would break vector search as a side effect of
  // choosing an AI model.
  if (def) next[def.envKey] = override.key;
  return next;
};

/**
 * Everything an AI caller needs, resolved once: the env to call with and the
 * model to call. This is the shared config path — Ask AI, the agents runner,
 * auto-translate, the MCP `ai.*` tools and the settings "Test key" action all
 * go through it instead of each hard-coding a provider or a model.
 *
 * Resolution order for BOTH the credential and the model is workspace row →
 * global row → deployment default, resolved per field: a workspace that set
 * only a key still picks up the global default model, and vice versa.
 */
export interface AiRuntime {
  /** `ctx.env` with the resolved BYO key overlaid (or unchanged). */
  env: Env;
  /** Stored default model id, or `undefined` to let the caller's own default
   *  (and ultimately the provider registry's) apply. */
  model?: string;
  /** The provider that will be used, or `"inherit"` when none was configured
   *  and the deployment env decides. */
  provider: AiProvider;
}

export const resolveAiRuntime = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<AiRuntime> => {
  let chain: AiConfigRow[] = [];
  try {
    chain = await loadAiConfigChain(ctx, tenantId);
  } catch {
    chain = []; // never let a config read take AI offline
  }
  let override: AiOverride | null = null;
  let model: string | undefined;
  for (const row of chain) {
    if (!override) override = await overrideFromRow(ctx.env, row);
    if (!model) model = modelFromConfig(row.config);
  }
  return {
    env: override ? applyAiOverride(ctx.env, override) : ctx.env,
    model,
    provider: override?.provider ?? "inherit",
  };
};
