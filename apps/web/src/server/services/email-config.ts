import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { EmailAdapter } from "@backlex/core/adapters";
import { decryptSecret } from "../lib/crypto";
import { buildEmailAdapter, type EmailSpec } from "../lib/email-select";

/** Tenant id of the instance-wide override row — the level below a workspace's
 *  own row and above the deployment env adapter. Mirrors `auth_config`. */
export const GLOBAL_EMAIL_CONFIG_ID = "_global";

export interface EmailConfigRow {
  tenantId: string;
  provider: string;
  fromAddress: string | null;
  /** Non-secret provider params (mailgun: domain/host; ses: region/accessKeyId;
   *  smtp: host/port/secure/user). */
  config: Record<string, unknown> | null;
  /** Same keys as `config` would imply, but AES-256-GCM ciphertext per value
   *  (resend/sendgrid/mailgun: `apiKey`; ses: `secretAccessKey`; smtp: `pass`). */
  secrets: Record<string, string> | null;
  updatedAt: Date | number | null;
}

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.emailConfig : sqlite.schema.emailConfig;

/** A row counts as "active" only when it names a real provider — an `inherit`
 *  row (or a blank provider) means "ask the next level down". */
const rowIsActive = (row: EmailConfigRow | undefined): row is EmailConfigRow =>
  !!row && typeof row.provider === "string" && row.provider !== "" && row.provider !== "inherit";

/**
 * Load the active `email_config` row for a workspace: the tenant's own row
 * first, then the instance-wide `_global` row. Rows whose provider is
 * `inherit`/blank are skipped (they defer to the next level). Returns `null`
 * if neither resolves — callers fall back to the deployment env adapter.
 * Read failures (table not migrated yet, transient error) also degrade to
 * `null` rather than throwing on a request path.
 */
export const loadEmailConfigRow = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<EmailConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_EMAIL_CONFIG_ID
      ? [tenantId, GLOBAL_EMAIL_CONFIG_ID]
      : [GLOBAL_EMAIL_CONFIG_ID];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as EmailConfigRow[];
      if (rowIsActive(rows[0])) return rows[0];
    } catch {
      return null;
    }
  }
  return null;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Compile a stored row into a transport spec, decrypting secrets along the
 *  way. Returns `null` when a required field is missing. */
const specFromRow = async (
  row: EmailConfigRow,
  appSecret: string,
): Promise<EmailSpec | null> => {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const enc = (row.secrets ?? {}) as Record<string, string>;
  const secret = async (k: string): Promise<string | undefined> => {
    const v = enc[k];
    if (!v) return undefined;
    return (await decryptSecret(v, appSecret)) ?? undefined;
  };
  const from = str(row.fromAddress);
  switch (row.provider) {
    case "console":
      return { provider: "console" };
    case "resend": {
      const apiKey = await secret("apiKey");
      return from && apiKey ? { provider: "resend", from, apiKey } : null;
    }
    case "sendgrid": {
      const apiKey = await secret("apiKey");
      return from && apiKey ? { provider: "sendgrid", from, apiKey } : null;
    }
    case "mailgun": {
      const apiKey = await secret("apiKey");
      const domain = str(cfg.domain);
      return from && apiKey && domain
        ? { provider: "mailgun", from, apiKey, domain, host: str(cfg.host) }
        : null;
    }
    case "ses": {
      const secretAccessKey = await secret("secretAccessKey");
      const accessKeyId = str(cfg.accessKeyId);
      const region = str(cfg.region);
      return from && secretAccessKey && accessKeyId && region
        ? { provider: "ses", from, accessKeyId, secretAccessKey, region }
        : null;
    }
    case "smtp": {
      const pass = await secret("pass");
      const host = str(cfg.host);
      return from && host
        ? {
            provider: "smtp",
            from,
            host,
            port: num(cfg.port),
            secure: bool(cfg.secure),
            user: str(cfg.user),
            pass,
          }
        : null;
    }
    default:
      return null;
  }
};

/**
 * Resolve the email transport for a workspace: its own `email_config` row →
 * the instance `_global` row → the supplied `fallback` (the deployment
 * env-derived adapter). An incomplete or here-unsupported stored config warns
 * and falls back rather than failing the send.
 */
export const resolveEmailAdapter = async (
  ctx: DbCtx & { env: { AUTH_SECRET: string } },
  fallback: EmailAdapter,
  tenantId: string | null | undefined,
): Promise<EmailAdapter> => {
  const row = await loadEmailConfigRow(ctx, tenantId);
  if (!row) return fallback;
  const spec = await specFromRow(row, ctx.env.AUTH_SECRET);
  const adapter = spec ? buildEmailAdapter(spec) : undefined;
  if (adapter) return adapter;
  console.warn(
    `[email] email_config for tenant=${row.tenantId} (provider=${row.provider}) is incomplete or unsupported here — using the deployment default`,
  );
  return fallback;
};
