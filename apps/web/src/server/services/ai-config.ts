import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";

/**
 * Tenant id of the instance-wide `ai_config` row — the fallback used when a
 * workspace hasn't set its own AI key. Mirrors the `_global` sentinel the
 * email/auth config layers already use.
 */
export const GLOBAL_AI_CONFIG_ID = "_global";

/** Providers a workspace can pick for bring-your-own AI generation. */
export type AiProvider = "inherit" | "gateway" | "anthropic";

/** Secret keys recognised per provider. */
export const AI_SECRET_KEYS = ["gatewayKey", "anthropicKey"] as const;
export type AiSecretKey = (typeof AI_SECRET_KEYS)[number];

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
 * Load the stored `ai_config` row for a workspace, falling back to the
 * instance-wide ({@link GLOBAL_AI_CONFIG_ID}) row. Returns `null` if neither
 * exists or the table isn't migrated yet (callers then keep the deployment
 * default).
 */
export const loadAiConfigRow = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string | null | undefined,
): Promise<AiConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_AI_CONFIG_ID
      ? [tenantId, GLOBAL_AI_CONFIG_ID]
      : [GLOBAL_AI_CONFIG_ID];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as AiConfigRow[];
      if (rows[0]) return rows[0];
    } catch {
      return null; // table not migrated yet
    }
  }
  return null;
};

/**
 * The decrypted bring-your-own key for a workspace, or `null` when the
 * workspace inherits the deployment default. Only the key matching the chosen
 * provider is returned.
 */
export interface AiOverride {
  provider: "gateway" | "anthropic";
  key: string;
}

/**
 * Resolve a workspace's BYO AI key. Returns `null` (inherit the deployment
 * default) when no row exists, the provider is `inherit`, or the chosen
 * provider's secret is missing / undecryptable. Never throws — a read/decrypt
 * failure degrades to inherit so AI generation keeps working.
 */
export const resolveAiOverride = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<AiOverride | null> => {
  const row = await loadAiConfigRow(ctx, tenantId);
  if (!row) return null;
  const provider = row.provider as AiProvider;
  if (provider !== "gateway" && provider !== "anthropic") return null;
  const encKey = provider === "gateway" ? "gatewayKey" : "anthropicKey";
  const enc = row.secrets?.[encKey];
  if (typeof enc !== "string" || !enc) return null;
  try {
    const key = await decryptSecret(enc, ctx.env.AUTH_SECRET);
    if (!key) return null;
    return { provider, key };
  } catch {
    return null;
  }
};

/**
 * Overlay a resolved BYO key onto an `Env` so the shared `callClaude` path uses
 * it. The chosen provider's env key is set and the other is blanked, so the
 * workspace's explicit choice wins over any ambient deployment key (and, via
 * `callClaude`'s direct-key-first ordering, bypasses the managed cloud gateway).
 */
export const applyAiOverride = (env: Env, override: AiOverride): Env =>
  override.provider === "gateway"
    ? {
        ...env,
        AI_GATEWAY_API_KEY: override.key,
        ANTHROPIC_API_KEY: undefined,
        // Also drop the deployment's OAuth token: "my key" must mean the
        // workspace's key, not a silent fallback to the operator's identity.
        ANTHROPIC_AUTH_TOKEN: undefined,
      }
    : {
        ...env,
        ANTHROPIC_API_KEY: override.key,
        AI_GATEWAY_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      };
