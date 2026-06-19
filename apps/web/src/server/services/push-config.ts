import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { PushAdapter } from "@backlex/core/adapters";
import { decryptSecret } from "../lib/crypto";
import { buildPushAdapter, type PushSpec } from "../lib/push-select";

/** Tenant id of the instance-wide override row. Mirrors `email_config`. */
export const GLOBAL_PUSH_CONFIG_ID = "_global";

/** Secret keys recognised across providers (fcm/apns: `privateKey`; web-push:
 *  `vapidPrivateKey`). A row names one provider, so the keys never collide. */
export const PUSH_SECRET_KEYS = ["privateKey", "vapidPrivateKey"] as const;

export interface PushConfigRow {
  tenantId: string;
  provider: string;
  config: Record<string, unknown> | null;
  secrets: Record<string, string> | null;
  updatedAt: Date | number | null;
}

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.pushConfig : sqlite.schema.pushConfig;

const rowIsActive = (row: PushConfigRow | undefined): row is PushConfigRow =>
  !!row && typeof row.provider === "string" && row.provider !== "" && row.provider !== "inherit";

/**
 * Load the active `push_config` row for a workspace: its own row first, then
 * the instance `_global` row. `inherit`/blank rows defer to the next level.
 * Returns `null` (callers fall back to the deployment env adapter) when neither
 * resolves or the table isn't migrated yet.
 */
export const loadPushConfigRow = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<PushConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_PUSH_CONFIG_ID
      ? [tenantId, GLOBAL_PUSH_CONFIG_ID]
      : [GLOBAL_PUSH_CONFIG_ID];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as PushConfigRow[];
      if (rowIsActive(rows[0])) return rows[0];
    } catch {
      return null;
    }
  }
  return null;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Compile a stored row into a transport spec, decrypting secrets. Returns
 *  `null` when a required field is missing. */
const specFromRow = async (row: PushConfigRow, appSecret: string): Promise<PushSpec | null> => {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const enc = (row.secrets ?? {}) as Record<string, string>;
  const secret = async (k: string): Promise<string | undefined> => {
    const v = enc[k];
    if (!v) return undefined;
    return (await decryptSecret(v, appSecret)) ?? undefined;
  };
  switch (row.provider) {
    case "console":
      return { provider: "console" };
    case "fcm": {
      const privateKey = await secret("privateKey");
      const projectId = str(cfg.projectId);
      const clientEmail = str(cfg.clientEmail);
      return privateKey && projectId && clientEmail
        ? { provider: "fcm", projectId, clientEmail, privateKey }
        : null;
    }
    case "apns": {
      const privateKey = await secret("privateKey");
      const keyId = str(cfg.keyId);
      const teamId = str(cfg.teamId);
      const bundleId = str(cfg.bundleId);
      return privateKey && keyId && teamId && bundleId
        ? { provider: "apns", privateKey, keyId, teamId, bundleId, production: bool(cfg.production) }
        : null;
    }
    case "web-push": {
      const vapidPrivateKey = await secret("vapidPrivateKey");
      const subject = str(cfg.subject);
      const vapidPublicKey = str(cfg.vapidPublicKey);
      return vapidPrivateKey && subject && vapidPublicKey
        ? { provider: "web-push", subject, vapidPublicKey, vapidPrivateKey }
        : null;
    }
    default:
      return null;
  }
};

/**
 * Resolve the push transport for a workspace: its own `push_config` row → the
 * instance `_global` row → the supplied `fallback` (the deployment env adapter).
 * An incomplete stored config warns and falls back rather than failing the send.
 */
export const resolvePushAdapter = async (
  ctx: DbCtx & { env: { AUTH_SECRET: string } },
  fallback: PushAdapter,
  tenantId: string | null | undefined,
): Promise<PushAdapter> => {
  const row = await loadPushConfigRow(ctx, tenantId);
  if (!row) return fallback;
  const spec = await specFromRow(row, ctx.env.AUTH_SECRET);
  if (spec) return buildPushAdapter(spec);
  console.warn(
    `[push] push_config for tenant=${row.tenantId} (provider=${row.provider}) is incomplete — using the deployment default`,
  );
  return fallback;
};
