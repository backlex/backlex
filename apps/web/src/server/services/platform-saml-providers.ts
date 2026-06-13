/**
 * Instance-global SAML provider data layer for the CONTROL PLANE (admin
 * dashboard operators). Fork of `services/saml-providers.ts` with tenant
 * scoping removed — admin SSO is not workspace-scoped. Identities provisioned
 * by these providers land in `users` (see `platform-sso-provisioning.ts`).
 *
 * Same conventions as the workspace version: reads degrade to `null`/`[]` when
 * the table isn't migrated yet; the cert PEM is stored as `enc:v1:…` ciphertext
 * and only decrypted inside `resolvePlatformSamlProvider`.
 */

import { AppError } from "@backlex/core";
import type { SamlAdapter, SamlProviderConfig } from "@backlex/core/adapters";
import type { PgDb } from "@backlex/db/pg";
import * as pg from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import * as sqlite from "@backlex/db/sqlite";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { buildSamlAdapter } from "../lib/auth-select";
import { decryptSecret, encryptSecret } from "../lib/crypto";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? pg.schema.platformSamlProviders
    : sqlite.schema.platformSamlProviders;

export interface PlatformSamlProviderRow {
  id: string;
  name: string;
  slug: string;
  idpTemplate: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  idpCertPem: string;
  spEntityId: string;
  attributeMap: Record<string, string>;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, { tenantId: string; roleId: string }> | null;
  signatureAlgorithm: string;
  wantSignedAssertions: boolean;
  linkByVerifiedEmail: boolean;
  nameIdFormat: string;
  domainMatch: string[] | null;
  enabled: boolean;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export interface PlatformSamlProviderInput {
  name: string;
  slug?: string;
  idpTemplate?: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl?: string | null;
  /** Plaintext PEM — stored encrypted. */
  idpCertPem: string;
  spEntityId: string;
  attributeMap?: Record<string, string>;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, { tenantId: string; roleId: string }> | null;
  signatureAlgorithm?: string;
  wantSignedAssertions?: boolean;
  linkByVerifiedEmail?: boolean;
  nameIdFormat?: string;
  domainMatch?: string[] | null;
  enabled?: boolean;
}

export type PlatformSamlProviderPatch = Partial<PlatformSamlProviderInput>;

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const generateSlug = (name: string): string => {
  const s = slugify(name);
  if (s) return s;
  return `idp-${crypto.randomUUID().slice(0, 8)}`;
};

export const sanitizeForResponse = (
  row: PlatformSamlProviderRow,
): Omit<PlatformSamlProviderRow, "idpCertPem"> & { idpCertSet: boolean } => {
  const { idpCertPem, ...rest } = row;
  return { ...rest, idpCertSet: typeof idpCertPem === "string" && idpCertPem.length > 0 };
};

export const listPlatformSamlProviders = async (
  ctx: DbCtx,
): Promise<PlatformSamlProviderRow[]> => {
  const t = tableFor(ctx.dialect);
  try {
    return (await (ctx.db as any).select().from(t)) as PlatformSamlProviderRow[];
  } catch {
    return [];
  }
};

export const loadPlatformSamlProviderBySlug = async (
  ctx: DbCtx,
  slug: string,
): Promise<PlatformSamlProviderRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.slug, slug))
      .limit(1)) as PlatformSamlProviderRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

export const loadPlatformSamlProviderById = async (
  ctx: DbCtx,
  id: string,
): Promise<PlatformSamlProviderRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.id, id))
      .limit(1)) as PlatformSamlProviderRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

export const createPlatformSamlProvider = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET"> },
  input: PlatformSamlProviderInput,
): Promise<PlatformSamlProviderRow> => {
  const t = tableFor(ctx.dialect);
  const id = crypto.randomUUID();
  const slug = input.slug && input.slug.trim() ? slugify(input.slug) : generateSlug(input.name);
  const encryptedCert = await encryptSecret(input.idpCertPem.trim(), ctx.env.AUTH_SECRET);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const values: Record<string, unknown> = {
    id,
    name: input.name,
    slug,
    idpTemplate: input.idpTemplate ?? null,
    entityId: input.entityId,
    ssoUrl: input.ssoUrl,
    sloUrl: input.sloUrl ?? null,
    idpCertPem: encryptedCert,
    spEntityId: input.spEntityId,
    attributeMap: input.attributeMap ?? {},
    defaultRoleId: input.defaultRoleId ?? null,
    groupsToRoles: input.groupsToRoles ?? null,
    signatureAlgorithm: input.signatureAlgorithm ?? "sha256",
    wantSignedAssertions: input.wantSignedAssertions ?? true,
    linkByVerifiedEmail: input.linkByVerifiedEmail ?? false,
    nameIdFormat: input.nameIdFormat ?? "emailAddress",
    domainMatch: input.domainMatch ?? null,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(values);
  const row = await loadPlatformSamlProviderById(ctx, id);
  if (!row) throw new Error("createPlatformSamlProvider: row not found after insert");
  return row;
};

export const updatePlatformSamlProvider = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET"> },
  id: string,
  patch: PlatformSamlProviderPatch,
): Promise<PlatformSamlProviderRow | null> => {
  const t = tableFor(ctx.dialect);
  const set: Record<string, unknown> = {
    updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.slug !== undefined && patch.slug.trim() !== "") set.slug = slugify(patch.slug);
  if (patch.idpTemplate !== undefined) set.idpTemplate = patch.idpTemplate;
  if (patch.entityId !== undefined) set.entityId = patch.entityId;
  if (patch.ssoUrl !== undefined) set.ssoUrl = patch.ssoUrl;
  if (patch.sloUrl !== undefined) set.sloUrl = patch.sloUrl;
  if (typeof patch.idpCertPem === "string" && patch.idpCertPem.trim() !== "") {
    set.idpCertPem = await encryptSecret(patch.idpCertPem.trim(), ctx.env.AUTH_SECRET);
  }
  if (patch.spEntityId !== undefined) set.spEntityId = patch.spEntityId;
  if (patch.attributeMap !== undefined) set.attributeMap = patch.attributeMap;
  if (patch.defaultRoleId !== undefined) set.defaultRoleId = patch.defaultRoleId;
  if (patch.groupsToRoles !== undefined) set.groupsToRoles = patch.groupsToRoles;
  if (patch.signatureAlgorithm !== undefined) set.signatureAlgorithm = patch.signatureAlgorithm;
  if (patch.wantSignedAssertions !== undefined) set.wantSignedAssertions = patch.wantSignedAssertions;
  if (patch.linkByVerifiedEmail !== undefined) set.linkByVerifiedEmail = patch.linkByVerifiedEmail;
  if (patch.nameIdFormat !== undefined) set.nameIdFormat = patch.nameIdFormat;
  if (patch.domainMatch !== undefined) set.domainMatch = patch.domainMatch;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  await (ctx.db as any).update(t).set(set).where(eq(t.id, id));
  return loadPlatformSamlProviderById(ctx, id);
};

export const deletePlatformSamlProvider = async (
  ctx: DbCtx,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};

/** Runtime URL pair the adapter needs — platform plane has no tenant prefix. */
export const buildPlatformAcsAndMetadataUrls = (
  env: Pick<Env, "APP_URL">,
  providerSlug: string,
): { acsUrl: string; metadataUrl: string; sloAcsUrl: string } => {
  const base = env.APP_URL.replace(/\/+$/, "");
  return {
    acsUrl: `${base}/api/auth/saml/${providerSlug}/acs`,
    metadataUrl: `${base}/api/auth/saml/${providerSlug}/metadata`,
    sloAcsUrl: `${base}/api/auth/saml/${providerSlug}/slo`,
  };
};

/** Resolve a {@link SamlProviderConfig} ready for the adapter. `null` when the
 *  provider is missing/disabled or its cert can't be decrypted. Throws
 *  UNAVAILABLE when the runtime can't load samlify (stateless edge). */
export const resolvePlatformSamlProvider = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET" | "APP_URL"> },
  providerSlug: string,
): Promise<
  { adapter: SamlAdapter; cfg: SamlProviderConfig; row: PlatformSamlProviderRow } | null
> => {
  const row = await loadPlatformSamlProviderBySlug(ctx, providerSlug);
  if (!row) return null;
  if (!row.enabled) return null;
  const certPem = await decryptSecret(row.idpCertPem, ctx.env.AUTH_SECRET);
  if (!certPem) return null;
  const { acsUrl, sloAcsUrl } = buildPlatformAcsAndMetadataUrls(ctx.env, providerSlug);
  const sigAlg = (row.signatureAlgorithm ?? "sha256") as "sha1" | "sha256" | "sha512";
  const cfg: SamlProviderConfig = {
    id: row.id,
    entityId: row.entityId,
    ssoUrl: row.ssoUrl,
    sloUrl: row.sloUrl ?? undefined,
    idpCertPem: certPem,
    spEntityId: row.spEntityId,
    acsUrl,
    sloAcsUrl,
    signatureAlgorithm: sigAlg,
    wantSignedAssertions: row.wantSignedAssertions,
    nameIdFormat: row.nameIdFormat,
    attributeMap: row.attributeMap ?? {},
  };
  const adapter = await buildSamlAdapter();
  if (!adapter) {
    throw new AppError(
      "UNAVAILABLE",
      "SAML is not available on this runtime — deploy to Bun or Cloudflare Workers",
    );
  }
  return { adapter, cfg, row };
};
