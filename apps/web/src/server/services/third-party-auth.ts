/**
 * Third-party issuer configuration + the request-path resolution that turns a
 * verified external token into an `app_users` row.
 *
 * Data layer mirrors `services/saml-providers.ts`: reads degrade to empty when
 * the table isn't migrated yet, so a fresh deployment renders an empty admin
 * page instead of 500ing. There is no secret to encrypt here — verifying a
 * third-party token needs only public keys, which is precisely what makes this
 * cheaper to operate than the OAuth-client path in `oidc_providers`.
 */

import { AppError } from "@backlex/core";
import type { PgDb } from "@backlex/db/pg";
import * as pg from "@backlex/db/pg";
import { slugify as slugifySlug } from "@backlex/db/slug";
import type { SqliteDb } from "@backlex/db/sqlite";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, ne } from "drizzle-orm";
import { clearJwksCache, type JwksFetchEnv, resolveJwksUrl } from "../lib/jwks-cache";
import { log } from "../lib/log";
import type { ThirdPartyIdentity, ThirdPartyProvider } from "../lib/third-party-jwt";
import { provisionAppUser } from "./sso-provisioning";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite"; env: JwksFetchEnv };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? pg.schema.thirdPartyAuthProviders
    : sqlite.schema.thirdPartyAuthProviders;

const identityTables = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? { externalIdentities: pg.schema.externalIdentities, appUsers: pg.schema.appUsers }
    : {
        externalIdentities: sqlite.schema.externalIdentities,
        appUsers: sqlite.schema.appUsers,
      };

export interface ThirdPartyProviderRow extends ThirdPartyProvider {
  discoveryUrl: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export interface ThirdPartyProviderInput {
  name: string;
  slug?: string;
  issuer: string;
  /** Either this or `discoveryUrl` must be given; discovery wins when both are. */
  jwksUrl?: string;
  discoveryUrl?: string | null;
  audience?: string | null;
  subjectClaim?: string;
  emailClaim?: string;
  nameClaim?: string | null;
  groupsClaim?: string | null;
  groupsToRoles?: Record<string, string> | null;
  defaultRoleId?: string | null;
  linkByVerifiedEmail?: boolean;
  autoProvision?: boolean;
  enabled?: boolean;
}

export type ThirdPartyProviderPatch = Partial<ThirdPartyProviderInput>;

const slugify = (s: string): string => slugifySlug(s, 60);

const generateSlug = (name: string): string =>
  slugify(name) || `idp-${crypto.randomUUID().slice(0, 8)}`;

/** Trailing slashes are the classic `iss` mismatch: Auth0 publishes
 *  `https://x.auth0.com/` **with** one, Clerk publishes without. Comparing the
 *  claim to a hand-typed value that differs only there fails in a way nobody
 *  can see, so normalise on the way in — and never at compare time, where it
 *  would loosen the check. */
const normalizeIssuer = (raw: string): string => raw.trim();

/** Resolve the JWKS endpoint an input describes, preferring discovery.
 *  Throws a VALIDATION error rather than storing an unusable row — a provider
 *  that cannot be verified is worse than one that was refused. */
const resolveKeysUrl = async (
  env: JwksFetchEnv,
  input: { jwksUrl?: string; discoveryUrl?: string | null },
  existing?: string,
): Promise<string> => {
  const discovery = input.discoveryUrl?.trim();
  if (discovery) {
    const resolved = await resolveJwksUrl(env, discovery);
    if (!resolved) {
      throw new AppError(
        "VALIDATION",
        "Could not read jwks_uri from the discovery document",
        { discoveryUrl: discovery },
      );
    }
    return resolved;
  }
  const explicit = input.jwksUrl?.trim();
  if (explicit) return explicit;
  if (existing) return existing;
  throw new AppError("VALIDATION", "Either jwksUrl or discoveryUrl is required");
};

const assertIssuerFree = async (
  ctx: DbCtx,
  issuer: string,
  exceptId?: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const where = exceptId
    ? and(eq(t.issuer, issuer), ne(t.id, exceptId))
    : eq(t.issuer, issuer);
  const rows = (await (ctx.db as any)
    .select({ id: t.id, tenantId: t.tenantId })
    .from(t)
    .where(where)
    .limit(1)) as { id: string; tenantId: string }[];
  if (rows.length > 0) {
    // Deliberately does not say which workspace holds it — that would leak the
    // existence of another tenant's configuration to whoever probes issuers.
    throw new AppError(
      "VALIDATION",
      "That issuer is already registered on this instance",
      { issuer },
    );
  }
};

export const listThirdPartyProviders = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<ThirdPartyProviderRow[]> => {
  const t = tableFor(ctx.dialect);
  try {
    return (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))) as ThirdPartyProviderRow[];
  } catch {
    return [];
  }
};

export const loadThirdPartyProviderById = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<ThirdPartyProviderRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
      .limit(1)) as ThirdPartyProviderRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

export const createThirdPartyProvider = async (
  ctx: DbCtx,
  tenantId: string,
  input: ThirdPartyProviderInput,
): Promise<ThirdPartyProviderRow> => {
  const t = tableFor(ctx.dialect);
  const issuer = normalizeIssuer(input.issuer);
  if (!issuer) throw new AppError("VALIDATION", "issuer is required");
  await assertIssuerFree(ctx, issuer);
  const jwksUrl = await resolveKeysUrl(ctx.env, input);

  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any).insert(t).values({
    id,
    tenantId,
    name: input.name,
    slug: input.slug?.trim() ? slugify(input.slug) : generateSlug(input.name),
    issuer,
    jwksUrl,
    discoveryUrl: input.discoveryUrl?.trim() || null,
    audience: input.audience?.trim() || null,
    subjectClaim: input.subjectClaim?.trim() || "sub",
    emailClaim: input.emailClaim?.trim() || "email",
    nameClaim: input.nameClaim?.trim() || null,
    groupsClaim: input.groupsClaim?.trim() || null,
    groupsToRoles: input.groupsToRoles ?? null,
    defaultRoleId: input.defaultRoleId ?? null,
    linkByVerifiedEmail: input.linkByVerifiedEmail ?? false,
    autoProvision: input.autoProvision ?? true,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  });
  clearJwksCache();
  const row = await loadThirdPartyProviderById(ctx, tenantId, id);
  if (!row) throw new Error("createThirdPartyProvider: row not found after insert");
  return row;
};

export const updateThirdPartyProvider = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
  patch: ThirdPartyProviderPatch,
): Promise<ThirdPartyProviderRow | null> => {
  const current = await loadThirdPartyProviderById(ctx, tenantId, id);
  if (!current) return null;
  const t = tableFor(ctx.dialect);

  const values: Record<string, unknown> = {
    updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
  };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.slug !== undefined) values.slug = slugify(patch.slug ?? "") || current.slug;
  if (patch.issuer !== undefined) {
    const issuer = normalizeIssuer(patch.issuer);
    if (!issuer) throw new AppError("VALIDATION", "issuer cannot be empty");
    if (issuer !== current.issuer) await assertIssuerFree(ctx, issuer, id);
    values.issuer = issuer;
  }
  if (patch.jwksUrl !== undefined || patch.discoveryUrl !== undefined) {
    values.jwksUrl = await resolveKeysUrl(
      ctx.env,
      {
        jwksUrl: patch.jwksUrl ?? undefined,
        discoveryUrl:
          patch.discoveryUrl !== undefined ? patch.discoveryUrl : current.discoveryUrl,
      },
      current.jwksUrl,
    );
    if (patch.discoveryUrl !== undefined) {
      values.discoveryUrl = patch.discoveryUrl?.trim() || null;
    }
  }
  if (patch.audience !== undefined) values.audience = patch.audience?.trim() || null;
  if (patch.subjectClaim !== undefined) {
    values.subjectClaim = patch.subjectClaim?.trim() || "sub";
  }
  if (patch.emailClaim !== undefined) {
    values.emailClaim = patch.emailClaim?.trim() || "email";
  }
  if (patch.nameClaim !== undefined) values.nameClaim = patch.nameClaim?.trim() || null;
  if (patch.groupsClaim !== undefined) {
    values.groupsClaim = patch.groupsClaim?.trim() || null;
  }
  if (patch.groupsToRoles !== undefined) values.groupsToRoles = patch.groupsToRoles;
  if (patch.defaultRoleId !== undefined) values.defaultRoleId = patch.defaultRoleId;
  if (patch.linkByVerifiedEmail !== undefined) {
    values.linkByVerifiedEmail = patch.linkByVerifiedEmail;
  }
  if (patch.autoProvision !== undefined) values.autoProvision = patch.autoProvision;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;

  await (ctx.db as any)
    .update(t)
    .set(values)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
  clearJwksCache();
  return loadThirdPartyProviderById(ctx, tenantId, id);
};

export const deleteThirdPartyProvider = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<boolean> => {
  const t = tableFor(ctx.dialect);
  const existing = await loadThirdPartyProviderById(ctx, tenantId, id);
  if (!existing) return false;
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
  clearJwksCache();
  return true;
};

// ── request-path resolution ────────────────────────────────────────────────

/**
 * How often a still-valid identity is re-run through `provisionAppUser`.
 *
 * These tokens carry no session row, so every request arrives as a fresh
 * identity assertion — provisioning on each one would mean five or six indexed
 * queries per API call. Skipping it entirely is the other extreme: a group
 * removed at the IdP would never reach us. `external_identities.last_login_at`
 * already exists and is touched by the provisioner, so it doubles as the
 * throttle stamp with no new column: role changes land within this window and
 * the steady-state cost is one query.
 */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

const findLinkedUser = async (
  ctx: DbCtx,
  tenantId: string,
  providerId: string,
  subject: string,
): Promise<{ userId: string; status: string; lastLoginAt: number } | null> => {
  const t = identityTables(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select({
        userId: t.externalIdentities.userId,
        status: t.appUsers.status,
        lastLoginAt: t.externalIdentities.lastLoginAt,
      })
      .from(t.externalIdentities)
      .innerJoin(t.appUsers, eq(t.externalIdentities.userId, t.appUsers.id))
      .where(
        and(
          eq(t.externalIdentities.tenantId, tenantId),
          eq(t.externalIdentities.providerType, "jwt"),
          eq(t.externalIdentities.providerId, providerId),
          eq(t.externalIdentities.subject, subject),
        ),
      )
      .limit(1)) as {
      userId: string;
      status: string;
      lastLoginAt: Date | number | null;
    }[];
    const row = rows[0];
    if (!row) return null;
    const last =
      row.lastLoginAt instanceof Date
        ? row.lastLoginAt.getTime()
        : Number(row.lastLoginAt ?? 0);
    return {
      userId: row.userId,
      status: row.status,
      lastLoginAt: Number.isFinite(last) ? last : 0,
    };
  } catch {
    return null;
  }
};

export interface ResolvedThirdPartyUser {
  appUserId: string;
  tenantId: string;
}

/**
 * Turn a verified third-party identity into the `app_users` row it acts as.
 * `null` means the token was genuine but names nobody this workspace will let
 * in — an unknown subject under `autoProvision: false`, a suspended account, or
 * a first sight with no email to provision from.
 */
export const resolveThirdPartyUser = async (
  ctx: DbCtx,
  identity: ThirdPartyIdentity,
  ipAddress?: string,
): Promise<ResolvedThirdPartyUser | null> => {
  const { provider, subject } = identity;
  const linked = await findLinkedUser(ctx, provider.tenantId, provider.id, subject);

  if (linked) {
    // A suspended end-user keeps a perfectly valid IdP token; the block has to
    // be ours, not theirs.
    if (linked.status !== "active") return null;
    if (Date.now() - linked.lastLoginAt < RECONCILE_INTERVAL_MS) {
      return { appUserId: linked.userId, tenantId: provider.tenantId };
    }
  } else if (!provider.autoProvision) {
    return null;
  }

  // `app_users.email` is NOT NULL, so a first sight without one cannot be
  // provisioned. Refusing beats inventing a placeholder address that would
  // later collide or be emailed.
  if (!linked && !identity.email) {
    log.warn("third-party token has no email claim; cannot provision", {
      provider: provider.slug,
      tenantId: provider.tenantId,
      emailClaim: provider.emailClaim,
    });
    return null;
  }

  try {
    const result = await provisionAppUser({
      ctx,
      tenantId: provider.tenantId,
      providerType: "jwt",
      providerId: provider.id,
      subject,
      email: identity.email ?? "",
      firstName: identity.name ?? undefined,
      groups: identity.groups ?? undefined,
      defaultRoleId: provider.defaultRoleId,
      groupsToRoles: provider.groupsToRoles,
      linkByVerifiedEmail: provider.linkByVerifiedEmail,
      ipAddress,
      authnContext: `jwt:${provider.slug}`,
    });
    return { appUserId: result.appUserId, tenantId: provider.tenantId };
  } catch (err) {
    log.error("third-party provisioning failed", {
      provider: provider.slug,
      tenantId: provider.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};
