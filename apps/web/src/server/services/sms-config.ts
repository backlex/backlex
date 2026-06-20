import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { SMSAdapter } from "@backlex/core/adapters";
import { decryptSecret } from "../lib/crypto";
import { buildSmsAdapter, type SMSSpec } from "../lib/sms-select";

/** Tenant id of the instance-wide override row. Mirrors `push_config`. */
export const GLOBAL_SMS_CONFIG_ID = "_global";

/** Secret keys recognised across providers (twilio: `authToken`; sns:
 *  `secretAccessKey`). A row names one provider, so the keys never collide. */
export const SMS_SECRET_KEYS = ["authToken", "secretAccessKey"] as const;

export interface SmsConfigRow {
  tenantId: string;
  provider: string;
  config: Record<string, unknown> | null;
  secrets: Record<string, string> | null;
  updatedAt: Date | number | null;
}

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.smsConfig : sqlite.schema.smsConfig;

const rowIsActive = (row: SmsConfigRow | undefined): row is SmsConfigRow =>
  !!row && typeof row.provider === "string" && row.provider !== "" && row.provider !== "inherit";

/**
 * Load the active `sms_config` row for a workspace: its own row first, then the
 * instance `_global` row. `inherit`/blank rows defer to the next level. Returns
 * `null` (callers fall back to the deployment env adapter) when neither resolves
 * or the table isn't migrated yet.
 */
export const loadSmsConfigRow = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<SmsConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_SMS_CONFIG_ID
      ? [tenantId, GLOBAL_SMS_CONFIG_ID]
      : [GLOBAL_SMS_CONFIG_ID];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as SmsConfigRow[];
      if (rowIsActive(rows[0])) return rows[0];
    } catch {
      return null;
    }
  }
  return null;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Compile a stored row into a transport spec, decrypting secrets. Returns
 *  `null` when a required field is missing. */
const specFromRow = async (row: SmsConfigRow, appSecret: string): Promise<SMSSpec | null> => {
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
    case "twilio": {
      const authToken = await secret("authToken");
      const accountSid = str(cfg.accountSid);
      const from = str(cfg.from);
      const messagingServiceSid = str(cfg.messagingServiceSid);
      return authToken && accountSid && (from || messagingServiceSid)
        ? { provider: "twilio", accountSid, authToken, from, messagingServiceSid }
        : null;
    }
    case "sns": {
      const secretAccessKey = await secret("secretAccessKey");
      const region = str(cfg.region);
      const accessKeyId = str(cfg.accessKeyId);
      const senderId = str(cfg.senderId);
      return secretAccessKey && region && accessKeyId
        ? { provider: "sns", region, accessKeyId, secretAccessKey, senderId }
        : null;
    }
    default:
      return null;
  }
};

/**
 * Resolve the SMS transport for a workspace: its own `sms_config` row → the
 * instance `_global` row → the supplied `fallback` (the deployment env adapter).
 * An incomplete stored config warns and falls back rather than failing the send.
 */
export const resolveSmsAdapter = async (
  ctx: DbCtx & { env: { AUTH_SECRET: string } },
  fallback: SMSAdapter,
  tenantId: string | null | undefined,
): Promise<SMSAdapter> => {
  const row = await loadSmsConfigRow(ctx, tenantId);
  if (!row) return fallback;
  const spec = await specFromRow(row, ctx.env.AUTH_SECRET);
  if (spec) return buildSmsAdapter(spec);
  console.warn(
    `[sms] sms_config for tenant=${row.tenantId} (provider=${row.provider}) is incomplete — using the deployment default`,
  );
  return fallback;
};
