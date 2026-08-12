/**
 * The one place a stored connection turns into credentials a provider can call
 * with.
 *
 * Two steps have to happen, in this order, on every path that reaches a
 * provider: decrypt the secret config fields, and — for the providers connected
 * over OAuth — renew the access token before it is handed over. They were
 * hand-written at each call site instead, which produced three copies of the
 * decrypt half and four of the pair, and the fifth surface to arrive (listings)
 * had neither. The failure that shape produces is the expensive kind: a listing
 * connection works for the length of one access token and then answers 401 for
 * ever, with nothing in the logs naming a token.
 *
 * So the pair lives here and every caller asks for the finished config.
 * `SECRET_KEYS` — which keys are secret at all — is the other thing worth
 * having exactly one reading of, so the encrypt/decrypt pair moved here too.
 */
import { AppError } from "@backlex/core";
import { type IntegrationKind, OAUTH_ACCESS_TOKEN_KEY, providerFor, SECRET_KEYS } from "@backlex/integrations";
import type { Ctx } from "../context";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import { ensureAccessToken } from "./integrations-oauth";

const secretKeys = (kind: string) => new Set<string>(SECRET_KEYS[kind as IntegrationKind] ?? []);

/** Encrypt this kind's secret config fields, leaving already-encrypted ones. */
export async function encryptConfig(
  kind: string,
  config: Record<string, unknown>,
  secret: string,
): Promise<Record<string, unknown>> {
  const keys = secretKeys(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = keys.has(k) && typeof v === "string" && v && !isEncryptedSecret(v) ? await encryptSecret(v, secret) : v;
  }
  return out;
}

/** Decrypt this kind's secret config fields. */
export async function decryptConfig(
  kind: string,
  config: Record<string, unknown>,
  secret: string,
): Promise<Record<string, unknown>> {
  const keys = secretKeys(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = keys.has(k) && typeof v === "string" && isEncryptedSecret(v) ? ((await decryptSecret(v, secret)) ?? "") : v;
  }
  return out;
}

/**
 * The stored connection, as every caller of {@link connectionConfigFor} must
 * present it.
 *
 * `updatedAt` is required, and that is the point rather than an oversight: the
 * refresh writes the new token pair with a compare-and-set on it, so a caller
 * that hand-builds a partial row silently drops the guard that stops a
 * concurrent refresh from restoring a refresh token the provider has already
 * killed. Requiring it here means a call site has to have SELECTed the row —
 * which is the only way it could hold a real value to compare against.
 */
export interface ConnectionRow {
  id: string;
  kind: string;
  tenantId: string | null;
  config: Record<string, unknown> | null;
  updatedAt: Date | number | null;
}

/** A context that may or may not carry `env` — the inline delivery fallback
 *  and the test seams build the narrow one. */
type MaybeCtx = { db: unknown; dialect: "pg" | "sqlite"; env?: unknown };

/**
 * Decrypt a connection's config and, for an OAuth provider, put a live access
 * token in it under {@link OAUTH_ACCESS_TOKEN_KEY}.
 *
 * Throws `UNAUTHORIZED` when the grant is gone: a refresh that fails means
 * revoked or rotated-out, which no retry fixes. Callers that keep their own
 * failure bookkeeping (a delivery log, a sync run's outcome) catch it and
 * record their own verdict.
 */
export async function connectionConfigFor(
  ctx: MaybeCtx,
  row: ConnectionRow,
  secret: string,
): Promise<Record<string, unknown>> {
  const config = await decryptConfig(row.kind, (row.config ?? {}) as Record<string, unknown>, secret);
  if (!providerFor(row.kind)?.oauth) return config;
  // No `env` means no outbound fetch and no APP_URL — the inline, best-effort
  // delivery path. Hand over the stored token and let the provider be the one
  // to reject it; refusing here would break a path that works today for every
  // provider whose token has not expired.
  if (!("env" in ctx) || !ctx.env) return config;

  // The RAW row, never the decrypted config: a refresh merges the new tokens
  // into what it was given and writes that back, so handing it plaintext would
  // store every secret on the row unencrypted.
  const token = await ensureAccessToken(ctx as Ctx, { ...row, config: (row.config ?? {}) as Record<string, unknown> }, secret);
  if (!token) throw new AppError("UNAUTHORIZED", "OAuth connection needs re-authorizing");
  return { ...config, [OAUTH_ACCESS_TOKEN_KEY]: token };
}
