/**
 * Workspace OIDC / OAuth2 identity providers.
 *
 * The generic twin of `saml-providers.ts`. One stored row per IdP, fed to
 * better-auth's `genericOAuth` plugin — so Okta, Auth0, Keycloak, Entra,
 * Authentik, GitLab, Discord and LinkedIn are configuration rather than one
 * hand-written provider each.
 *
 * Client secrets are encrypted at rest with AUTH_SECRET (like SAML certs and
 * integration config) and never returned. The service is the only place that
 * decrypts them, and only to hand them to the auth instance.
 */
import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { GenericOidcProvider } from "@backlex/auth";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Env } from "../env";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import { fetchOutbound } from "./storage/hosts";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };
type AnyDb = any;

const tableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.oidcProviders
    : sqlite.schema.oidcProviders) as typeof pg.schema.oidcProviders;

export interface OidcProviderRow {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  clientId: string;
  clientSecretEnc: string;
  discoveryUrl: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userInfoUrl: string | null;
  scopes: string[];
  pkce: boolean | number;
  emailClaim: string | null;
  groupsClaim: string | null;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  linkByVerifiedEmail: boolean | number;
  enabled: boolean | number;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface OidcProviderInput {
  name: string;
  slug: string;
  clientId: string;
  /** Plaintext; encrypted before it touches the database. */
  clientSecret?: string;
  discoveryUrl?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userInfoUrl?: string | null;
  scopes?: string[];
  pkce?: boolean;
  emailClaim?: string | null;
  groupsClaim?: string | null;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  linkByVerifiedEmail?: boolean;
  enabled?: boolean;
}

/** Public view — the client secret is never included in any shape. */
export const toPublic = (row: OidcProviderRow) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  clientId: row.clientId,
  /** Presence only. There is no read-back path for the secret itself. */
  hasClientSecret: Boolean(row.clientSecretEnc),
  discoveryUrl: row.discoveryUrl,
  authorizationUrl: row.authorizationUrl,
  tokenUrl: row.tokenUrl,
  userInfoUrl: row.userInfoUrl,
  scopes: row.scopes ?? [],
  pkce: Boolean(row.pkce),
  emailClaim: row.emailClaim,
  groupsClaim: row.groupsClaim,
  defaultRoleId: row.defaultRoleId,
  groupsToRoles: row.groupsToRoles,
  linkByVerifiedEmail: Boolean(row.linkByVerifiedEmail),
  enabled: Boolean(row.enabled),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export interface DiscoveryResult {
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopesSupported?: string[];
}

/**
 * Resolve an IdP's endpoints from its OpenID discovery document.
 *
 * Accepts either the document URL or a bare issuer origin (the common
 * copy-paste), appending the well-known path when it's missing.
 *
 * Two guards, both because the URL is caller-supplied: https only, since
 * discovery over http would let a network attacker point sign-in at their own
 * authorize endpoint; and the request goes through `fetchOutbound`, which
 * applies the deployment's SSRF policy — without it this endpoint would be a
 * probe for internal services reachable from the worker.
 */
export async function discoverOidcEndpoints(
  env: Pick<Env, "BLOCK_PRIVATE_FETCH_HOSTS" | "CLOUD_PROJECT_ID">,
  rawUrl: string,
  fetchImpl?: typeof fetch,
): Promise<DiscoveryResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AppError("VALIDATION", "Discovery URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new AppError("VALIDATION", "Discovery URL must use https");
  }
  if (!url.pathname.includes("/.well-known/")) {
    url = new URL(
      `${url.pathname.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      url.origin,
    );
  }
  let res: Response;
  try {
    res = fetchImpl
      ? await fetchImpl(url.toString(), { headers: { accept: "application/json" } })
      : await fetchOutbound(env, url.toString(), { headers: { accept: "application/json" } });
  } catch (e) {
    throw new AppError("VALIDATION", `Could not reach the discovery URL: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new AppError("VALIDATION", `Discovery URL responded ${res.status}`);
  }
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") {
    throw new AppError("VALIDATION", "Discovery URL did not return a JSON document");
  }
  const str = (k: string) => (typeof doc[k] === "string" ? (doc[k] as string) : undefined);
  const out: DiscoveryResult = {
    issuer: str("issuer"),
    authorizationUrl: str("authorization_endpoint"),
    tokenUrl: str("token_endpoint"),
    userInfoUrl: str("userinfo_endpoint"),
    scopesSupported: Array.isArray(doc.scopes_supported)
      ? (doc.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined,
  };
  if (!out.authorizationUrl || !out.tokenUrl) {
    throw new AppError(
      "VALIDATION",
      "Discovery document is missing authorization_endpoint or token_endpoint",
    );
  }
  return out;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Reject slugs that would shadow a built-in provider id or a route segment. */
const RESERVED_SLUGS = new Set(["google", "github", "apple", "email", "credential", "mcp"]);

const normalizeInput = (input: OidcProviderInput) => {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new AppError(
      "VALIDATION",
      "slug must be 2-40 chars, lowercase letters/digits/hyphens, not starting or ending with a hyphen",
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new AppError("VALIDATION", `slug "${slug}" is reserved`);
  }
  if (!input.name.trim()) throw new AppError("VALIDATION", "name is required");
  if (!input.clientId.trim()) throw new AppError("VALIDATION", "clientId is required");
  return { slug, name: input.name.trim(), clientId: input.clientId.trim() };
};

/** An IdP needs either a discovery URL or an explicit authorize+token pair. */
const requireEndpoints = (row: {
  discoveryUrl?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
}) => {
  if (row.discoveryUrl) return;
  if (row.authorizationUrl && row.tokenUrl) return;
  throw new AppError(
    "VALIDATION",
    "Provide a discoveryUrl, or both authorizationUrl and tokenUrl",
  );
};

export async function listOidcProviders(ctx: DbCtx, tenantId: string) {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(desc(t.createdAt))) as OidcProviderRow[];
  return rows.map(toPublic);
}

export async function createOidcProvider(
  ctx: DbCtx,
  tenantId: string,
  input: OidcProviderInput,
  authSecret: string,
): Promise<ReturnType<typeof toPublic>> {
  const { slug, name, clientId } = normalizeInput(input);
  if (!input.clientSecret?.trim()) {
    throw new AppError("VALIDATION", "clientSecret is required");
  }
  requireEndpoints(input);
  const t = tableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  const clash = (await db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))) as OidcProviderRow[];
  if (clash[0]) throw new AppError("CONFLICT", `A provider with slug "${slug}" already exists`);

  const id = crypto.randomUUID();
  await db.insert(t).values({
    id,
    tenantId,
    name,
    slug,
    clientId,
    clientSecretEnc: await encryptSecret(input.clientSecret.trim(), authSecret),
    discoveryUrl: input.discoveryUrl ?? null,
    authorizationUrl: input.authorizationUrl ?? null,
    tokenUrl: input.tokenUrl ?? null,
    userInfoUrl: input.userInfoUrl ?? null,
    scopes: input.scopes?.length ? input.scopes : ["openid", "profile", "email"],
    pkce: input.pkce ?? true,
    emailClaim: input.emailClaim ?? null,
    groupsClaim: input.groupsClaim ?? null,
    defaultRoleId: input.defaultRoleId ?? null,
    groupsToRoles: input.groupsToRoles ?? null,
    linkByVerifiedEmail: input.linkByVerifiedEmail ?? false,
    enabled: input.enabled ?? true,
  });
  const [row] = (await db.select().from(t).where(eq(t.id, id))) as OidcProviderRow[];
  if (!row) throw new AppError("INTERNAL", "provider row missing after insert");
  return toPublic(row);
}

export async function updateOidcProvider(
  ctx: DbCtx,
  tenantId: string,
  id: string,
  patch: Partial<OidcProviderInput>,
  authSecret: string,
): Promise<ReturnType<typeof toPublic>> {
  const t = tableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  const [existing] = (await db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as OidcProviderRow[];
  if (!existing) throw new AppError("NOT_FOUND", "Provider not found");

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new AppError("VALIDATION", "name cannot be empty");
    set.name = patch.name.trim();
  }
  if (patch.slug !== undefined) {
    const { slug } = normalizeInput({ ...existing, ...patch, slug: patch.slug } as OidcProviderInput);
    if (slug !== existing.slug) {
      const clash = (await db
        .select()
        .from(t)
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))) as OidcProviderRow[];
      if (clash[0]) throw new AppError("CONFLICT", `A provider with slug "${slug}" already exists`);
    }
    set.slug = slug;
  }
  if (patch.clientId !== undefined) {
    if (!patch.clientId.trim()) throw new AppError("VALIDATION", "clientId cannot be empty");
    set.clientId = patch.clientId.trim();
  }
  // An empty/absent clientSecret means "keep the stored one" — the UI cannot
  // read it back, so a blank field must never blank the credential.
  if (patch.clientSecret?.trim()) {
    set.clientSecretEnc = await encryptSecret(patch.clientSecret.trim(), authSecret);
  }
  for (const k of ["discoveryUrl", "authorizationUrl", "tokenUrl", "userInfoUrl", "emailClaim", "groupsClaim", "defaultRoleId"] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.scopes !== undefined) set.scopes = patch.scopes.length ? patch.scopes : ["openid", "profile", "email"];
  if (patch.pkce !== undefined) set.pkce = patch.pkce;
  if (patch.groupsToRoles !== undefined) set.groupsToRoles = patch.groupsToRoles;
  if (patch.linkByVerifiedEmail !== undefined) set.linkByVerifiedEmail = patch.linkByVerifiedEmail;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  requireEndpoints({
    discoveryUrl: (set.discoveryUrl ?? existing.discoveryUrl) as string | null,
    authorizationUrl: (set.authorizationUrl ?? existing.authorizationUrl) as string | null,
    tokenUrl: (set.tokenUrl ?? existing.tokenUrl) as string | null,
  });

  await db.update(t).set(set).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
  const [row] = (await db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as OidcProviderRow[];
  if (!row) throw new AppError("INTERNAL", "provider row missing after update");
  return toPublic(row);
}

export async function deleteOidcProvider(ctx: DbCtx, tenantId: string, id: string): Promise<void> {
  const t = tableFor(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
}

/**
 * Load a workspace's enabled providers in the shape `createTenantAuth` /
 * `createAuth` want, decrypting each client secret. A row whose secret cannot
 * be decrypted (rotated AUTH_SECRET, corrupt ciphertext) is DROPPED rather
 * than passed through with an empty secret — a provider configured with a
 * blank secret would fail the token exchange in a way that looks like an IdP
 * outage instead of a config problem.
 */
export async function loadOidcProvidersForAuth(
  ctx: DbCtx,
  env: Env,
  tenantId: string,
): Promise<GenericOidcProvider[]> {
  const t = tableFor(ctx.dialect);
  let rows: OidcProviderRow[];
  try {
    rows = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.enabled, true)))) as OidcProviderRow[];
  } catch {
    // Table not migrated yet — behave as "no SSO configured".
    return [];
  }
  const out: GenericOidcProvider[] = [];
  for (const row of rows) {
    const secret = isEncryptedSecret(row.clientSecretEnc)
      ? await decryptSecret(row.clientSecretEnc, env.AUTH_SECRET)
      : null;
    if (!secret) {
      console.error(`[oidc] provider ${row.slug} skipped — client secret could not be decrypted`);
      continue;
    }
    out.push({
      providerId: row.slug,
      clientId: row.clientId,
      clientSecret: secret,
      discoveryUrl: row.discoveryUrl ?? undefined,
      authorizationUrl: row.authorizationUrl ?? undefined,
      tokenUrl: row.tokenUrl ?? undefined,
      userInfoUrl: row.userInfoUrl ?? undefined,
      scopes: row.scopes ?? undefined,
      pkce: Boolean(row.pkce),
    });
  }
  return out;
}
