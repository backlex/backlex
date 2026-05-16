/**
 * Per-tenant LDAP / Active Directory data layer. Mirrors
 * `services/email-config.ts`:
 *
 *   - one row per tenant (PK `tenant_id`), with the `_global` sentinel
 *     used as the instance-wide fallback;
 *   - reads degrade to `null` when the table isn't migrated yet (so a fresh
 *     deployment doesn't 500 the admin page);
 *   - `bind_password` and the optional `ca_pem` are stored as `enc:v1:…`
 *     ciphertext in `secrets` and only ever decrypted inside
 *     {@link resolveLdapAdapter} on the way into the adapter.
 *   - `sanitizeForResponse` strips the encrypted blob entirely and returns
 *     per-key "is it set" flags so the admin UI can render a badge without
 *     learning the ciphertext.
 */
import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import type { LdapAdapter } from "@workeros/core/adapters";
import { decryptSecret } from "../lib/crypto";
import { buildLdapAdapter } from "../lib/auth-select";
import type { LdapSpec } from "../adapters/ldap.ldapts";
import type { Env } from "../env";

/** Sentinel id for the instance-wide LDAP override row. */
export const GLOBAL_LDAP_CONFIG_ID = "_global";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.ldapConfigs : sqlite.schema.ldapConfigs;

const DEFAULT_ATTRIBUTE_MAP = {
  email: "mail",
  firstName: "givenName",
  lastName: "sn",
  groups: "memberOf",
} as const;

/**
 * Raw row shape, as returned from drizzle. `secrets` carries the ciphertexts;
 * plaintext only ever lives inside {@link specFromRow} → {@link resolveLdapAdapter}.
 */
export interface LdapConfigRow {
  tenantId: string;
  enabled: boolean;
  url: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  tlsOptions: { rejectUnauthorized?: boolean } | null;
  secrets: Record<string, string>;
  domainMatch: string[] | null;
  rateLimitPerMinute: number;
  updatedAt: Date | number | null;
}

/**
 * Load the active workspace LDAP config: own row first, then the `_global`
 * sentinel. Returns `null` if neither resolves, or if the table doesn't exist
 * yet (fresh DB pre-migration).
 */
export const loadLdapConfigRow = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<LdapConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_LDAP_CONFIG_ID
      ? [tenantId, GLOBAL_LDAP_CONFIG_ID]
      : [GLOBAL_LDAP_CONFIG_ID];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as LdapConfigRow[];
      if (rows[0]) return rows[0];
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Compile a stored row into an {@link LdapSpec} ready to hand to the adapter.
 * Decrypts `bindPassword` and (optional) `caPem`. Returns `null` when the
 * config is unusable (no URL, missing bind credentials, ciphertext tampered).
 */
export const specFromRow = async (
  row: LdapConfigRow,
  appSecret: string,
): Promise<LdapSpec | null> => {
  if (!row.url || !row.bindDn || !row.baseDn) return null;
  const enc = row.secrets ?? {};
  const bindPassword = enc.bindPassword
    ? await decryptSecret(enc.bindPassword, appSecret)
    : null;
  if (!bindPassword) return null;
  const caPem = enc.caPem ? await decryptSecret(enc.caPem, appSecret) : null;
  const attributeMap = {
    ...DEFAULT_ATTRIBUTE_MAP,
    ...(row.attributeMap ?? {}),
  };
  const tls = row.tlsOptions || caPem
    ? {
        ...(row.tlsOptions?.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: row.tlsOptions.rejectUnauthorized }
          : {}),
        ...(caPem ? { caPem } : {}),
      }
    : undefined;
  return {
    url: row.url,
    bindDn: row.bindDn,
    bindPassword,
    baseDn: row.baseDn,
    userFilter:
      row.userFilter && row.userFilter.trim().length > 0
        ? row.userFilter
        : "(&(objectClass=person)(uid={{username}}))",
    groupFilter: row.groupFilter ?? undefined,
    attributeMap,
    tls,
  };
};

/**
 * Resolve an {@link LdapAdapter} for a workspace. Returns `null` when LDAP
 * isn't configured, isn't enabled, or isn't usable on this runtime
 * (Workers). The route layer turns `null` into 503 "UNAVAILABLE".
 */
export const resolveLdapAdapter = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET"> },
  tenantId: string | null | undefined,
): Promise<{ adapter: LdapAdapter; config: LdapConfigRow } | null> => {
  const row = await loadLdapConfigRow(ctx, tenantId);
  if (!row) return null;
  if (!row.enabled) return null;
  const spec = await specFromRow(row, ctx.env.AUTH_SECRET);
  if (!spec) return null;
  const adapter = buildLdapAdapter(spec);
  if (!adapter) return null; // Workers — no raw TCP
  return { adapter, config: row };
};

/**
 * Strip secrets from a row before handing it to the admin UI. Per-key
 * `secretsSet` flags let the UI show a badge without ever transmitting the
 * ciphertext.
 */
export const sanitizeForResponse = (
  row: LdapConfigRow,
): Omit<LdapConfigRow, "secrets"> & {
  secretsSet: { bindPassword: boolean; caPem: boolean };
} => {
  const { secrets, ...rest } = row;
  const s = secrets ?? {};
  return {
    ...rest,
    secretsSet: {
      bindPassword: typeof s.bindPassword === "string" && s.bindPassword.length > 0,
      caPem: typeof s.caPem === "string" && s.caPem.length > 0,
    },
  };
};
