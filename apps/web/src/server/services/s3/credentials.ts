/**
 * Credentials for the S3-compatible endpoint.
 *
 * A SigV4 request carries no workspace header and no session — the access key
 * id is the ONLY thing that can name the workspace, which is why it is unique
 * instance-wide and why resolution starts here rather than in the tenant
 * middleware.
 *
 * The secret is stored encrypted rather than hashed. See the schema comment for
 * why that is forced (SigV4 derives a signing key from the secret; a digest
 * cannot), what it protects (a database dump) and what it does not (anyone with
 * the application's environment).
 */
import { and, asc, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import type { Ctx } from "../../context";
import type { Env } from "../../env";

type AnyDb = any;

const table = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.s3Credentials
    : sqlite.schema.s3Credentials) as typeof pg.schema.s3Credentials;

/** Access key ids look like AWS's so a tool's validation does not reject them,
 *  and start with a marker so one is recognisable in a log. */
const AKID_PREFIX = "BLX";
const AKID_BODY = 17;
const SECRET_BYTES = 32;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const randomAkid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(AKID_BODY));
  let out = AKID_PREFIX;
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
};

const randomSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

export interface S3CredentialRow {
  id: string;
  tenantId: string;
  name: string;
  accessKeyId: string;
  secretKey: string;
  prefix: string | null;
  readOnly: boolean;
  enabled: boolean;
  expiresAt: Date | number | null;
  lastUsedAt: Date | number | null;
  createdAt: Date | number | null;
}

/** What a caller may read back. The secret is shown ONCE, at creation. */
export interface S3CredentialView {
  id: string;
  name: string;
  accessKeyId: string;
  prefix: string | null;
  readOnly: boolean;
  enabled: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number | null;
}

const ms = (v: Date | number | null): number | null =>
  v === null ? null : v instanceof Date ? v.getTime() : v;

export const toView = (row: S3CredentialRow): S3CredentialView => ({
  id: row.id,
  name: row.name,
  accessKeyId: row.accessKeyId,
  prefix: row.prefix,
  readOnly: Boolean(row.readOnly),
  enabled: Boolean(row.enabled),
  expiresAt: ms(row.expiresAt),
  lastUsedAt: ms(row.lastUsedAt),
  createdAt: ms(row.createdAt),
});

export const listS3Credentials = async (
  ctx: Ctx,
  tenantId: string,
): Promise<S3CredentialView[]> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(asc(t.createdAt))) as S3CredentialRow[];
  return rows.map(toView);
};

export interface CreateS3CredentialInput {
  name: string;
  prefix?: string | null;
  readOnly?: boolean;
  expiresAt?: Date | null;
}

export const createS3Credential = async (
  ctx: Ctx,
  tenantId: string,
  input: CreateS3CredentialInput,
): Promise<{ credential: S3CredentialView; secretAccessKey: string }> => {
  if (!input.name || input.name.length > 120) {
    throw new AppError("VALIDATION", "`name` must be 1–120 characters");
  }
  const prefix = input.prefix?.trim() || null;
  if (prefix && (prefix.startsWith("/") || prefix.includes(".."))) {
    // A prefix is a scope, so a value that could climb out of it is refused
    // rather than normalized — normalizing would silently widen the scope.
    throw new AppError("VALIDATION", "`prefix` must be a plain key prefix");
  }
  const secret = randomSecret();
  const t = table(ctx.dialect);
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    name: input.name,
    accessKeyId: randomAkid(),
    secretKey: await encryptSecret(secret, ctx.env.AUTH_SECRET),
    prefix,
    readOnly: input.readOnly ?? false,
    enabled: true,
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await (ctx.db as AnyDb).insert(t).values(row);
  return {
    credential: toView(row as unknown as S3CredentialRow),
    // Returned once. There is no read-back endpoint, and the docs say to store
    // it now — the encryption is at rest, not a retrieval channel.
    secretAccessKey: secret,
  };
};

export const updateS3Credential = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: { name?: string; prefix?: string | null; readOnly?: boolean; enabled?: boolean },
): Promise<S3CredentialView> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as S3CredentialRow[];
  const existing = rows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Credential not found");
  const next = {
    name: patch.name ?? existing.name,
    prefix: patch.prefix === undefined ? existing.prefix : (patch.prefix?.trim() || null),
    readOnly: patch.readOnly ?? Boolean(existing.readOnly),
    enabled: patch.enabled ?? Boolean(existing.enabled),
    updatedAt: new Date(),
  };
  await (ctx.db as AnyDb)
    .update(t)
    .set(next)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return toView({ ...existing, ...next } as S3CredentialRow);
};

export const deleteS3Credential = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Credential not found");
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

export interface ResolvedCredential {
  row: S3CredentialRow;
  secret: string;
}

/**
 * Find the credential behind an access key id and decrypt its secret.
 *
 * Returns `null` for absent, disabled, expired AND undecryptable — four
 * conditions with one answer, because the endpoint must not tell a caller
 * which of them applies. An undecryptable secret in particular means the
 * deployment's `AUTH_SECRET` changed; refusing is the only safe reading, since
 * the alternative would be to accept any signature.
 */
export const resolveS3Credential = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite"; env: Env },
  accessKeyId: string,
  now: number = Date.now(),
): Promise<ResolvedCredential | null> => {
  if (!accessKeyId) return null;
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.accessKeyId, accessKeyId))
    .limit(1)) as S3CredentialRow[];
  const row = rows[0];
  if (!row || !row.enabled) return null;
  const expires = ms(row.expiresAt);
  if (expires !== null && expires <= now) return null;
  const secret = await decryptSecret(row.secretKey, ctx.env.AUTH_SECRET);
  if (!secret) return null;
  return { row, secret };
};

/** Stamp `last_used_at`. Best-effort: a failure here must not fail the
 *  request the caller actually made. */
export const touchS3Credential = async (ctx: Ctx, id: string): Promise<void> => {
  try {
    const t = table(ctx.dialect);
    await (ctx.db as AnyDb)
      .update(t)
      .set({ lastUsedAt: new Date() })
      .where(eq(t.id, id));
  } catch {
    // ignore
  }
};

/** Does this credential's prefix scope cover `key`? */
export const withinPrefix = (row: S3CredentialRow, key: string): boolean =>
  !row.prefix || key === row.prefix || key.startsWith(row.prefix);
