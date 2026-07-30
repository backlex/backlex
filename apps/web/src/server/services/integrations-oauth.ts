/**
 * OAuth 2.0 authorization-code connect flow for workspace integrations.
 *
 * backlex is self-hostable, so there is no platform OAuth client to fall back
 * on. The workspace admin registers their own app with the provider and stores
 * `clientId` / `clientSecret` as ordinary config fields; this module drives the
 * redirect, the exchange, and the refresh on top of that.
 *
 * The security shape, in one place because it is the whole point of the file:
 *
 *   - The `state` value is random and never stored. Only its SHA-256 lands in
 *     the DB, so reading the table cannot complete a pending authorization.
 *   - The state row is consumed with a `DELETE … RETURNING`, which makes it
 *     genuinely single-use rather than single-use-unless-two-callbacks-race.
 *   - The row pins the tenant AND the admin who started the flow. A callback
 *     carrying a valid code but a different session is refused, so one
 *     workspace admin cannot graft their authorization onto another's row.
 *   - `redirect_uri` is derived from APP_URL, never from the request host, and
 *     is replayed at exchange time as RFC 6749 requires.
 *   - Every endpoint contacted comes from the provider descriptor. No URL on
 *     either leg is caller-supplied, so there is no SSRF surface to guard.
 *   - Tokens are written only from here, under reserved `_oauth*` config keys
 *     that admin writes are stripped of, and they are encrypted at rest and
 *     masked on read by the same machinery as any other provider secret.
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import {
  OAUTH_ACCESS_TOKEN_KEY,
  OAUTH_CONNECTED_AT_KEY,
  OAUTH_EXPIRES_AT_KEY,
  OAUTH_REFRESH_TOKEN_KEY,
  OAUTH_SCOPE_KEY,
  providerFor,
  type IntegrationOAuth,
} from "@backlex/integrations";
import type { Ctx } from "../context";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import { fetchOutbound } from "./storage/hosts";

type AnyDb = any;

const statesTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationOauthStates
    : sqlite.schema.integrationOauthStates) as typeof pg.schema.integrationOauthStates;

const integrationsTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;

/** How long an admin has to finish the consent screen. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Refresh this far ahead of expiry so a token cannot die mid-request. */
const REFRESH_SKEW_MS = 60 * 1000;

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomB64Url = (bytes: number): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const sha256B64Url = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
};

/** The one redirect URI this instance ever registers or replays. */
export const oauthRedirectUri = (appUrl: string): string =>
  `${appUrl.replace(/\/+$/, "")}/api/admin/integrations/oauth/callback`;

interface IntegrationRowish {
  id: string;
  kind: string;
  tenantId: string | null;
  config: Record<string, unknown>;
  /** Required, not optional: it is the compare-and-set key the refresh path
   *  writes against, and an optional field would let a caller silently drop
   *  that guard by passing a row it never selected. */
  updatedAt: Date | number | null;
}

const loadOwned = async (ctx: Ctx, tenantId: string, id: string): Promise<IntegrationRowish> => {
  const t = integrationsTableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as IntegrationRowish[];
  if (!row) throw new AppError("NOT_FOUND", "Integration not found");
  return row;
};

const oauthOf = (kind: string): IntegrationOAuth => {
  const provider = providerFor(kind);
  if (!provider?.oauth) {
    throw new AppError("BAD_REQUEST", `${kind} is connected with an API key, not OAuth`);
  }
  return provider.oauth;
};

/** Read one config value, decrypting it when it was stored encrypted. */
const readConfig = async (
  config: Record<string, unknown>,
  key: string,
  authSecret: string,
): Promise<string | null> => {
  const v = config[key];
  if (typeof v !== "string" || !v) return null;
  return isEncryptedSecret(v) ? await decryptSecret(v, authSecret) : v;
};

// ── Leg 1: build the authorize URL ───────────────────────────────────────────

export interface BeginResult {
  url: string;
}

/**
 * Start a connect flow and return the provider URL to send the admin to.
 *
 * Nothing about the returned URL is caller-influenced beyond which integration
 * row was named — host, path and scopes all come from the descriptor.
 */
export async function beginOAuth(
  ctx: Ctx,
  args: { tenantId: string; userId: string; integrationId: string },
): Promise<BeginResult> {
  const row = await loadOwned(ctx, args.tenantId, args.integrationId);
  const oauth = oauthOf(row.kind);

  const clientId = await readConfig(row.config ?? {}, "clientId", ctx.env.AUTH_SECRET);
  if (!clientId) {
    throw new AppError("BAD_REQUEST", "Set the OAuth client ID and secret before connecting");
  }

  const state = randomB64Url(32);
  const codeVerifier = oauth.pkce ? randomB64Url(48) : null;
  const redirectUri = oauthRedirectUri(ctx.env.APP_URL);

  const t = statesTableFor(ctx.dialect);
  // Sweep whatever has aged out before adding another. Abandoned flows (the
  // admin closes the consent screen) leave a row behind and nothing else ever
  // deletes it, so without this the table only grows. Indexed on expires_at.
  await (ctx.db as AnyDb).delete(t).where(lt(t.expiresAt, new Date()));
  await (ctx.db as AnyDb).insert(t).values({
    id: await sha256Hex(state),
    integrationId: row.id,
    tenantId: args.tenantId,
    userId: args.userId,
    codeVerifier,
    redirectUri,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (oauth.scopes.length > 0) url.searchParams.set("scope", oauth.scopes.join(" "));
  if (codeVerifier) {
    url.searchParams.set("code_challenge", await sha256B64Url(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(oauth.authorizeParams ?? {})) url.searchParams.set(k, v);

  return { url: url.toString() };
}

// ── Leg 2: exchange the code ─────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [k: string]: unknown;
}

/** POST the token endpoint, in whichever of the two shapes this provider takes. */
const callTokenEndpoint = async (
  ctx: Ctx,
  oauth: IntegrationOAuth,
  clientId: string,
  clientSecret: string,
  params: Record<string, string>,
): Promise<TokenResponse> => {
  const headers: Record<string, string> = { Accept: "application/json" };
  const body: Record<string, string> = { ...params };

  if (oauth.tokenAuth === "basic") {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else {
    body.client_id = clientId;
    body.client_secret = clientSecret;
  }

  let payload: string;
  if (oauth.tokenAuth === "basic") {
    // Notion is the one provider taking JSON here; everyone else takes a form.
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  }

  const res = await fetchOutbound(ctx.env, oauth.tokenUrl, { method: "POST", headers, body: payload });
  const text = await res.text();
  if (!res.ok) {
    // The provider's error body routinely echoes the client_secret back on a
    // bad-credentials response, so only the status is safe to surface.
    throw new AppError("BAD_REQUEST", `Token endpoint returned ${res.status}`);
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new AppError("BAD_REQUEST", "Token endpoint returned a non-JSON body");
  }
};

/** Merge freshly issued tokens into the stored config, encrypting the two
 *  bearer values. Non-token keys the provider asked us to keep ride along. */
const tokensIntoConfig = async (
  existing: Record<string, unknown>,
  token: TokenResponse,
  oauth: IntegrationOAuth,
  authSecret: string,
): Promise<Record<string, unknown>> => {
  const next: Record<string, unknown> = { ...existing };
  if (token.access_token) {
    next[OAUTH_ACCESS_TOKEN_KEY] = await encryptSecret(token.access_token, authSecret);
  }
  if (token.refresh_token) {
    // Absent on a refresh from a non-rotating provider — keeping the stored one
    // is the difference between a connection that survives and one that dies at
    // the second refresh.
    next[OAUTH_REFRESH_TOKEN_KEY] = await encryptSecret(token.refresh_token, authSecret);
  }
  next[OAUTH_EXPIRES_AT_KEY] =
    typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : null;
  if (typeof token.scope === "string") next[OAUTH_SCOPE_KEY] = token.scope;
  next[OAUTH_CONNECTED_AT_KEY] = Date.now();
  for (const key of oauth.keepFromTokenResponse ?? []) {
    const v = token[key];
    if (typeof v === "string" || typeof v === "number") next[key] = v;
  }
  return next;
};

export interface CompleteResult {
  integrationId: string;
  kind: string;
}

/**
 * Finish a connect flow.
 *
 * `tenantId` / `userId` come from the session, never from the query string —
 * they are checked against what the state row recorded, which is what stops a
 * code from one admin's flow being redeemed inside another's workspace.
 */
export async function completeOAuth(
  ctx: Ctx,
  args: { state: string; code: string; tenantId: string; userId: string },
): Promise<CompleteResult> {
  const t = statesTableFor(ctx.dialect);
  const stateId = await sha256Hex(args.state);

  // Consume and read in one statement: two callbacks racing on the same state
  // cannot both come away with a row.
  const [pending] = (await (ctx.db as AnyDb).delete(t).where(eq(t.id, stateId)).returning()) as {
    integrationId: string;
    tenantId: string;
    userId: string;
    codeVerifier: string | null;
    redirectUri: string;
    expiresAt: Date | number;
  }[];
  // Unknown, already used and expired are deliberately one answer — telling
  // them apart would confirm to a prober that a state value was ever real.
  if (!pending) throw new AppError("BAD_REQUEST", "This authorization link is no longer valid");

  const expiresAt = pending.expiresAt instanceof Date ? pending.expiresAt.getTime() : Number(pending.expiresAt);
  if (Date.now() > expiresAt) {
    throw new AppError("BAD_REQUEST", "This authorization link is no longer valid");
  }
  if (pending.tenantId !== args.tenantId || pending.userId !== args.userId) {
    throw new AppError("FORBIDDEN", "Finish the connection in the session that started it");
  }

  const row = await loadOwned(ctx, args.tenantId, pending.integrationId);
  const oauth = oauthOf(row.kind);
  const config = (row.config ?? {}) as Record<string, unknown>;
  const clientId = await readConfig(config, "clientId", ctx.env.AUTH_SECRET);
  const clientSecret = await readConfig(config, "clientSecret", ctx.env.AUTH_SECRET);
  if (!clientId || !clientSecret) {
    throw new AppError("BAD_REQUEST", "The OAuth client credentials were removed mid-flow");
  }

  const token = await callTokenEndpoint(ctx, oauth, clientId, clientSecret, {
    grant_type: "authorization_code",
    code: args.code,
    // Replayed from what leg 1 pinned, not recomputed — the provider compares
    // the two and a mismatch is what a redirect-hijack attempt looks like.
    redirect_uri: pending.redirectUri,
    ...(pending.codeVerifier ? { code_verifier: pending.codeVerifier } : {}),
  });
  if (!token.access_token) throw new AppError("BAD_REQUEST", "Token endpoint returned no access token");

  const it = integrationsTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(it)
    .set({
      config: await tokensIntoConfig(config, token, oauth, ctx.env.AUTH_SECRET),
      status: "connected",
      consecutiveFailures: 0,
      lastFailureAt: null,
      disabledReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(it.tenantId, args.tenantId), eq(it.id, row.id)));

  return { integrationId: row.id, kind: row.kind };
}

// ── Leg 3: keep the access token alive ───────────────────────────────────────

/**
 * Return a usable access token for an OAuth integration, refreshing first when
 * it is close to expiry. `null` means the connection needs re-authorizing —
 * callers treat that the same as a missing credential rather than retrying.
 *
 * Not called for non-OAuth providers; those have no token to keep alive.
 */
export async function ensureAccessToken(
  ctx: Ctx,
  row: IntegrationRowish,
  authSecret: string,
): Promise<string | null> {
  const provider = providerFor(row.kind);
  const oauth = provider?.oauth;
  if (!oauth) return null;

  const config = (row.config ?? {}) as Record<string, unknown>;
  const access = await readConfig(config, OAUTH_ACCESS_TOKEN_KEY, authSecret);
  if (!access) return null;
  if (oauth.nonExpiring) return access;

  const expiresAt = config[OAUTH_EXPIRES_AT_KEY];
  const expiresMs = typeof expiresAt === "number" ? expiresAt : null;
  if (expiresMs !== null && Date.now() < expiresMs - REFRESH_SKEW_MS) return access;
  // No recorded expiry and no way to refresh: the token is all we have, so use
  // it and let the provider be the one to reject it.
  const refresh = await readConfig(config, OAUTH_REFRESH_TOKEN_KEY, authSecret);
  if (!refresh) return expiresMs === null ? access : null;

  const clientId = await readConfig(config, "clientId", authSecret);
  const clientSecret = await readConfig(config, "clientSecret", authSecret);
  if (!clientId || !clientSecret) return null;

  let token: TokenResponse;
  try {
    token = await callTokenEndpoint(ctx, oauth, clientId, clientSecret, {
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
  } catch {
    // A refresh that fails means revoked or rotated-out, not a transient blip
    // worth retrying on every event. Report "needs reconnecting" and stop.
    return null;
  }
  if (!token.access_token) return null;

  const it = integrationsTableFor(ctx.dialect);
  const nextConfig = await tokensIntoConfig(config, token, oauth, authSecret);
  // Compare-and-set on the row version we read. With providers that rotate the
  // refresh token (Google, QuickBooks), a concurrent refresh has already
  // written a newer pair; writing ours on top would restore a refresh token the
  // provider has since killed and break the connection at the next renewal.
  // Losing this race is fine — the access token we just obtained is still valid
  // for this call, and the winner's tokens are the ones that persist.
  await (ctx.db as AnyDb)
    .update(it)
    .set({ config: nextConfig, updatedAt: new Date() })
    .where(
      and(eq(it.id, row.id), row.updatedAt === null ? isNull(it.updatedAt) : eq(it.updatedAt, row.updatedAt as never)),
    );

  return token.access_token;
}
