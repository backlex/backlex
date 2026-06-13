/**
 * Instance-global LDAP / Active Directory data layer for the CONTROL PLANE
 * (admin dashboard operators). Fork of `services/ldap-config.ts` as a SINGLETON
 * (one row, PK id = `'singleton'`) — admin SSO is not workspace-scoped.
 * Identities provisioned by this config land in `users`.
 *
 * Self-host only: `buildLdapAdapter` returns undefined on Cloudflare Workers and
 * other edge runtimes, so `resolvePlatformLdapAdapter` yields `null` there and
 * the route turns that into a 503 (configure SAML instead).
 */
import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { LdapAdapter } from "@backlex/core/adapters";
import { decryptSecret } from "../lib/crypto";
import { buildLdapAdapter } from "../lib/auth-select";
import type { LdapSpec } from "../adapters/ldap.ldapts";
import type { Env } from "../env";

/** Fixed PK of the singleton platform LDAP config row. */
export const PLATFORM_LDAP_ID = "singleton";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.platformLdapConfig : sqlite.schema.platformLdapConfig;

const DEFAULT_ATTRIBUTE_MAP = {
  email: "mail",
  firstName: "givenName",
  lastName: "sn",
  groups: "memberOf",
} as const;

export interface PlatformLdapConfigRow {
  id: string;
  enabled: boolean;
  url: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  defaultRoleId: string | null;
  groupsToRoles: Record<string, { tenantId: string; roleId: string }> | null;
  tlsOptions: { rejectUnauthorized?: boolean } | null;
  secrets: Record<string, string>;
  domainMatch: string[] | null;
  rateLimitPerMinute: number;
  updatedAt: Date | number | null;
}

/** Load the singleton config. `null` if unset or the table isn't migrated. */
export const loadPlatformLdapConfigRow = async (
  ctx: DbCtx,
): Promise<PlatformLdapConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.id, PLATFORM_LDAP_ID))
      .limit(1)) as PlatformLdapConfigRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

/** Compile a stored row into an {@link LdapSpec}. `null` when unusable. */
export const specFromRow = async (
  row: PlatformLdapConfigRow,
  appSecret: string,
): Promise<LdapSpec | null> => {
  if (!row.url || !row.bindDn || !row.baseDn) return null;
  const enc = row.secrets ?? {};
  const bindPassword = enc.bindPassword
    ? await decryptSecret(enc.bindPassword, appSecret)
    : null;
  if (!bindPassword) return null;
  const caPem = enc.caPem ? await decryptSecret(enc.caPem, appSecret) : null;
  const attributeMap = { ...DEFAULT_ATTRIBUTE_MAP, ...(row.attributeMap ?? {}) };
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

/** Resolve an {@link LdapAdapter} for the platform plane. `null` when not
 *  configured / disabled / unusable on this runtime (Workers). */
export const resolvePlatformLdapAdapter = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET"> },
): Promise<{ adapter: LdapAdapter; config: PlatformLdapConfigRow } | null> => {
  const row = await loadPlatformLdapConfigRow(ctx);
  if (!row) return null;
  if (!row.enabled) return null;
  const spec = await specFromRow(row, ctx.env.AUTH_SECRET);
  if (!spec) return null;
  const adapter = buildLdapAdapter(spec);
  if (!adapter) return null; // Workers — no raw TCP
  return { adapter, config: row };
};

export const sanitizeForResponse = (
  row: PlatformLdapConfigRow,
): Omit<PlatformLdapConfigRow, "secrets"> & {
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
