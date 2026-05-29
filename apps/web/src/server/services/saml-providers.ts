/**
 * Per-tenant SAML provider data layer. Mirrors `services/email-config.ts`:
 *
 *   - reads degrade to `null` when the table isn't migrated yet (so a fresh
 *     deployment doesn't 500 the admin page);
 *   - secrets (`idpCertPem`) are stored as `enc:v1:…` ciphertext and never
 *     leave the service except via `resolveSamlProvider` which decrypts to
 *     pass to the adapter;
 *   - `sanitizeForResponse` strips the ciphertext + flags whether it's set,
 *     so the admin UI can show "configured" without exposing the value.
 */
import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { SamlAdapter, SamlProviderConfig } from "@backlex/core/adapters";
import { AppError } from "@backlex/core";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { buildSamlAdapter } from "../lib/auth-select";
import type { Env } from "../env";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.samlProviders : sqlite.schema.samlProviders;

/**
 * Raw row shape, as returned from drizzle. `idpCertPem` is the ciphertext;
 * the plaintext only ever lives inside `resolveSamlProvider`.
 */
export interface SamlProviderRow {
  id: string;
  tenantId: string;
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
  groupsToRoles: Record<string, string> | null;
  signatureAlgorithm: string;
  wantSignedAssertions: boolean;
  linkByVerifiedEmail: boolean;
  nameIdFormat: string;
  enabled: boolean;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export interface SamlProviderInput {
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
  groupsToRoles?: Record<string, string> | null;
  signatureAlgorithm?: string;
  wantSignedAssertions?: boolean;
  linkByVerifiedEmail?: boolean;
  nameIdFormat?: string;
  enabled?: boolean;
}

export type SamlProviderPatch = Partial<SamlProviderInput>;

/** URL-safe slug. Mirrors the rest of the codebase. */
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

/** Drop the encrypted cert and any other write-only material before
 *  returning a row to the admin UI. */
export const sanitizeForResponse = (
  row: SamlProviderRow,
): Omit<SamlProviderRow, "idpCertPem"> & { idpCertSet: boolean } => {
  const { idpCertPem, ...rest } = row;
  return { ...rest, idpCertSet: typeof idpCertPem === "string" && idpCertPem.length > 0 };
};

/**
 * List every provider configured for a workspace. Returns `[]` when the
 * `saml_providers` table isn't migrated yet (or any read failure) so the
 * admin page renders an empty state instead of 500ing on a fresh DB.
 */
export const listSamlProviders = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<SamlProviderRow[]> => {
  const t = tableFor(ctx.dialect);
  try {
    return (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))) as SamlProviderRow[];
  } catch {
    return [];
  }
};

export const loadSamlProviderBySlug = async (
  ctx: DbCtx,
  tenantId: string,
  slug: string,
): Promise<SamlProviderRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1)) as SamlProviderRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

export const loadSamlProviderById = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<SamlProviderRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
      .limit(1)) as SamlProviderRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

/** Insert a new provider. The cert PEM is encrypted before storage. */
export const createSamlProvider = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET"> },
  tenantId: string,
  input: SamlProviderInput,
): Promise<SamlProviderRow> => {
  const t = tableFor(ctx.dialect);
  const id = crypto.randomUUID();
  const slug = input.slug && input.slug.trim() ? slugify(input.slug) : generateSlug(input.name);
  const encryptedCert = await encryptSecret(input.idpCertPem.trim(), ctx.env.AUTH_SECRET);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const values: Record<string, unknown> = {
    id,
    tenantId,
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
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(values);
  const row = await loadSamlProviderById(ctx, tenantId, id);
  if (!row) throw new Error("createSamlProvider: row not found after insert");
  return row;
};

/** Patch an existing provider. Omitted `idpCertPem` leaves the stored
 *  ciphertext intact; an empty-string `idpCertPem` would re-encrypt empty
 *  (callers should validate non-empty before calling). */
export const updateSamlProvider = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET"> },
  tenantId: string,
  id: string,
  patch: SamlProviderPatch,
): Promise<SamlProviderRow | null> => {
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
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  await (ctx.db as any)
    .update(t)
    .set(set)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
  return loadSamlProviderById(ctx, tenantId, id);
};

/**
 * Delete a provider. `external_identities` rows are intentionally NOT
 * cascade-deleted — they're kept as an audit trail (no FK from
 * `external_identities` to `saml_providers`). The provisioner skips
 * identities whose provider has gone away.
 */
export const deleteSamlProvider = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
};

/** Compose the runtime URL pair the adapter needs from the request env. */
export const buildAcsAndMetadataUrls = (
  env: Pick<Env, "APP_URL">,
  tenantSlug: string,
  providerSlug: string,
): { acsUrl: string; metadataUrl: string; sloAcsUrl: string } => {
  const base = env.APP_URL.replace(/\/+$/, "");
  return {
    acsUrl: `${base}/api/t/${tenantSlug}/auth/saml/${providerSlug}/acs`,
    metadataUrl: `${base}/api/t/${tenantSlug}/auth/saml/${providerSlug}/metadata`,
    sloAcsUrl: `${base}/api/t/${tenantSlug}/auth/saml/${providerSlug}/slo`,
  };
};

/**
 * Resolve a {@link SamlProviderConfig} ready to hand to the adapter. Returns
 * `null` when the provider is missing, disabled, or its stored cert can't
 * be decrypted (cert PEM tampered with, or AUTH_SECRET rotated and the
 * workspace hasn't re-entered the cert yet).
 */
export const resolveSamlProvider = async (
  ctx: DbCtx & { env: Pick<Env, "AUTH_SECRET" | "APP_URL"> },
  tenantId: string,
  tenantSlug: string,
  providerSlug: string,
): Promise<{ adapter: SamlAdapter; cfg: SamlProviderConfig; row: SamlProviderRow } | null> => {
  const row = await loadSamlProviderBySlug(ctx, tenantId, providerSlug);
  if (!row) return null;
  if (!row.enabled) return null;
  const certPem = await decryptSecret(row.idpCertPem, ctx.env.AUTH_SECRET);
  if (!certPem) return null;
  const { acsUrl, sloAcsUrl } = buildAcsAndMetadataUrls(ctx.env, tenantSlug, providerSlug);
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
  const adapter = buildSamlAdapter();
  if (!adapter) {
    // Vercel Edge / Netlify Edge can't load samlify (its xml-crypto
    // dependency relies on a `node:crypto` surface neither runtime exposes).
    // Surface a clear 503 instead of letting the route blow up on
    // `resolved.adapter.buildAuthnRequest`.
    throw new AppError(
      "UNAVAILABLE",
      "SAML is not available on this runtime — deploy to Bun or Cloudflare Workers",
    );
  }
  return { adapter, cfg, row };
};
