/**
 * The OAuth clients this instance has issued tokens to.
 *
 * ## What was missing, exactly
 *
 * The authorization server already runs: PKCE, consent, refresh tokens,
 * discovery, dynamic client registration — all of it, because the MCP
 * connector needed it. What it did not have is anyone able to SEE it. Clients
 * arrived only by dynamic registration, nothing listed them, nothing could
 * disable one, and the consents a person had granted were invisible to both
 * them and the operator.
 *
 * That is the difference between running an OAuth server and operating one, and
 * it is the whole of this file: a registry, an off switch for open
 * registration, and a way to take a grant back.
 *
 * ## The decisions
 *
 * **Disabling is not deleting.** A disabled client stops working immediately
 * and its history stays: which tokens it holds, who consented, when. Deleting
 * cascades all of that away, which is the right answer for a client registered
 * by mistake and the wrong one for a client that misbehaved.
 *
 * **Revoking a consent revokes the tokens too.** A consent row with live tokens
 * under it is a revocation that did not revoke — the person clicked "remove
 * access" and the client kept working until its token expired.
 *
 * **A confidential client's secret is shown once.** It is stored as issued
 * because the token endpoint has to compare it, exactly like the S3 secret and
 * for the same reason (a shared-secret scheme cannot verify a digest of a
 * secret it must also present). Public clients get no secret at all — PKCE is
 * what protects them, and a secret in a browser or a CLI is not a secret.
 */
import { and, count, desc, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import type { Env } from "../env";

type AnyDb = any;

const apps = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.oauthApplications
    : sqlite.schema.oauthApplications) as typeof pg.schema.oauthApplications;

const tokens = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.oauthAccessTokens
    : sqlite.schema.oauthAccessTokens) as typeof pg.schema.oauthAccessTokens;

const consents = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.oauthConsents
    : sqlite.schema.oauthConsents) as typeof pg.schema.oauthConsents;

export interface OAuthClientView {
  id: string;
  clientId: string;
  name: string;
  /** `public` (PKCE, no secret) or `confidential` (holds a secret). */
  type: string;
  redirectUrls: string[];
  disabled: boolean;
  /** True when the client arrived through dynamic registration rather than an
   *  operator creating it. Worth surfacing: those are the ones nobody vetted. */
  dynamic: boolean;
  hasSecret: boolean;
  activeTokens: number;
  createdAt: number | null;
}

const ms = (v: Date | number | null | undefined): number | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.getTime() : v;

const splitUrls = (raw: string | null): string[] =>
  (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const listOAuthClients = async (ctx: Ctx): Promise<OAuthClientView[]> => {
  const a = apps(ctx.dialect);
  const t = tokens(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(a)
    .orderBy(desc(a.createdAt))) as Array<{
    id: string;
    clientId: string;
    name: string;
    type: string;
    redirectUrls: string | null;
    clientSecret: string | null;
    disabled: boolean;
    userId: string | null;
    createdAt: Date | number | null;
  }>;
  // One grouped count rather than a query per client — a registry with a
  // hundred dynamically-registered clients is a plausible shape.
  const counts = (await (ctx.db as AnyDb)
    .select({ clientId: t.clientId, n: count() })
    .from(t)
    .groupBy(t.clientId)) as Array<{ clientId: string; n: number }>;
  const byClient = new Map(counts.map((c) => [c.clientId, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    name: r.name,
    type: r.type,
    redirectUrls: splitUrls(r.redirectUrls),
    disabled: Boolean(r.disabled),
    // Dynamic registration attributes the client to nobody; an operator-created
    // one records who made it.
    dynamic: !r.userId,
    hasSecret: Boolean(r.clientSecret),
    activeTokens: byClient.get(r.clientId) ?? 0,
    createdAt: ms(r.createdAt),
  }));
};

export interface CreateClientInput {
  name: string;
  redirectUrls: string[];
  type?: "public" | "confidential";
}

const randomToken = (bytes = 32): string => {
  const out = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...out))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

export const createOAuthClient = async (
  ctx: Ctx,
  ownerUserId: string,
  input: CreateClientInput,
): Promise<{ client: OAuthClientView; clientSecret: string | null }> => {
  if (!input.name?.trim()) throw new AppError("VALIDATION", "`name` is required");
  const redirectUrls = (input.redirectUrls ?? []).map((u) => u.trim()).filter(Boolean);
  if (redirectUrls.length === 0) {
    throw new AppError("VALIDATION", "At least one redirect URI is required");
  }
  for (const url of redirectUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError("VALIDATION", `Not a valid redirect URI: ${url}`);
    }
    // An authorization code is delivered TO this URL. Over plain http it is
    // readable by anything on the path, so the only exemption is a loopback
    // address — which is what a native app's local callback actually is.
    const loopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new AppError(
        "VALIDATION",
        `Redirect URIs must be https (or http on loopback for a native app): ${url}`,
      );
    }
    if (parsed.hash) {
      // A fragment is never sent to the server and would silently not match.
      throw new AppError("VALIDATION", `A redirect URI may not carry a fragment: ${url}`);
    }
  }
  const type = input.type === "confidential" ? "confidential" : "public";
  const clientId = `blx_${randomToken(16)}`;
  // A public client gets NO secret. PKCE is what protects it, and a secret
  // shipped in a browser or a CLI is not a secret — issuing one would only
  // encourage somebody to rely on it.
  const clientSecret = type === "confidential" ? randomToken(32) : null;
  const a = apps(ctx.dialect);
  const now = new Date();
  await (ctx.db as AnyDb).insert(a).values({
    id: crypto.randomUUID(),
    name: input.name.trim(),
    clientId,
    clientSecret,
    redirectUrls: redirectUrls.join(","),
    type,
    disabled: false,
    userId: ownerUserId,
    createdAt: now,
    updatedAt: now,
  });
  const client: OAuthClientView = {
    id: clientId,
    clientId,
    name: input.name.trim(),
    type,
    redirectUrls,
    disabled: false,
    dynamic: false,
    hasSecret: Boolean(clientSecret),
    activeTokens: 0,
    createdAt: now.getTime(),
  };
  return { client, clientSecret };
};

export const setOAuthClientDisabled = async (
  ctx: Ctx,
  clientId: string,
  disabled: boolean,
): Promise<void> => {
  const a = apps(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: a.id })
    .from(a)
    .where(eq(a.clientId, clientId))
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Client not found");
  await (ctx.db as AnyDb)
    .update(a)
    .set({ disabled, updatedAt: new Date() })
    .where(eq(a.clientId, clientId));
};

export const deleteOAuthClient = async (ctx: Ctx, clientId: string): Promise<void> => {
  const a = apps(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: a.id })
    .from(a)
    .where(eq(a.clientId, clientId))
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Client not found");
  // Tokens and consents cascade from the FK. That is the difference from
  // disabling, which keeps the history.
  await (ctx.db as AnyDb).delete(a).where(eq(a.clientId, clientId));
};

export interface OAuthGrantView {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
  createdAt: number | null;
}

/** Every consent this instance holds, newest first — optionally for one user,
 *  which is what an "apps with access to your account" screen reads. */
export const listOAuthGrants = async (
  ctx: Ctx,
  opts: { userId?: string; clientId?: string; limit?: number } = {},
): Promise<OAuthGrantView[]> => {
  const c = consents(ctx.dialect);
  const a = apps(ctx.dialect);
  const where = opts.userId
    ? opts.clientId
      ? and(eq(c.userId, opts.userId), eq(c.clientId, opts.clientId))
      : eq(c.userId, opts.userId)
    : opts.clientId
      ? eq(c.clientId, opts.clientId)
      : undefined;
  const rows = (await (ctx.db as AnyDb)
    .select({
      id: c.id,
      clientId: c.clientId,
      userId: c.userId,
      scopes: c.scopes,
      createdAt: c.createdAt,
      clientName: a.name,
    })
    .from(c)
    .leftJoin(a, eq(a.clientId, c.clientId))
    .where(where)
    .orderBy(desc(c.createdAt))
    .limit(Math.min(Math.max(1, opts.limit ?? 100), 500))) as Array<{
    id: string;
    clientId: string;
    userId: string;
    scopes: string | null;
    createdAt: Date | number | null;
    clientName: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName ?? r.clientId,
    userId: r.userId,
    scopes: splitUrls(r.scopes),
    createdAt: ms(r.createdAt),
  }));
};

/**
 * Take a grant back, tokens and all.
 *
 * Deleting only the consent row would be a revocation that does not revoke: the
 * access token already issued under it keeps working until it expires, and the
 * refresh token keeps minting new ones. The person pressing "remove access"
 * means both.
 */
export const revokeOAuthGrant = async (
  ctx: Ctx,
  clientId: string,
  userId: string,
): Promise<{ tokensRevoked: number }> => {
  const c = consents(ctx.dialect);
  const t = tokens(ctx.dialect);
  const live = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.clientId, clientId), eq(t.userId, userId)))) as Array<{ id: string }>;
  await (ctx.db as AnyDb)
    .delete(t)
    .where(and(eq(t.clientId, clientId), eq(t.userId, userId)));
  await (ctx.db as AnyDb)
    .delete(c)
    .where(and(eq(c.clientId, clientId), eq(c.userId, userId)));
  return { tokensRevoked: live.length };
};

/**
 * Whether open dynamic client registration is accepted.
 *
 * On by default, and that is not laziness: the hosted MCP connectors this
 * server exists for register dynamically, and turning it off by default would
 * break the one client everybody actually uses. An operator running it as a
 * company IdP wants the opposite, so `OAUTH_DYNAMIC_REGISTRATION=off` refuses
 * the endpoint and the registry becomes the only way in.
 */
export const dynamicRegistrationEnabled = (env: Env): boolean =>
  env.OAUTH_DYNAMIC_REGISTRATION !== "off" && env.OAUTH_DYNAMIC_REGISTRATION !== "0";
