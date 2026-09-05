import { Hono, type Context } from "hono";
import { and, eq, lt } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import { hashSecret } from "@backlex/auth/secret-hash";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId, getTenantAuth } from "../services/tenant-auth";
import {
  applyPasswordLoginMode,
  loadAuthConfigRow,
  passwordLoginBlocked,
  resolveAuthSurface,
} from "../services/auth-config";
import { loadPasswordLoginMode } from "../services/settings";
import { resolveSamlProvider } from "../services/saml-providers";
import {
  assertAssertionBoundToAcs,
  samlReplayIdentity,
} from "../services/saml-binding";
import { resolveLdapAdapter } from "../services/ldap-config";
import { provisionAppUser } from "../services/sso-provisioning";
import { consumeAppUserInvite, findAppUserInvite } from "../services/app-user-invites";
import { assignAppUserRoleByName, ensureSystemRoles } from "../services/seed";
import { invalidateUserRoles } from "../services/permissions-cache";
import { rateLimitOk } from "../lib/rate-limit";
import { type JwtEnv, signAccessToken } from "../lib/jwt";
import { runCustomAccessTokenHook } from "../services/auth-hooks";
import { loadRolesForUser } from "../services/permissions";
import type { Env } from "../env";
import { readJsonOr } from "../lib/body";

/**
 * Workspace end-user auth surface — the "auth as a service" router. Mounted
 * at `/api/t/:slug/auth/*`.
 *
 *   - `GET /api/t/:slug/auth/providers` — public, unauthenticated discovery:
 *     which sign-in providers + policy flags the workspace's app should
 *     render. No secrets.
 *   - `GET|POST /api/t/:slug/auth/saml/:providerSlug/...` — SAML 2.0 SSO
 *     endpoints (login redirect, ACS, metadata, SLO). Must mount BEFORE the
 *     better-auth catch-all so they aren't proxied to better-auth's handler.
 *   - everything else under `/api/t/:slug/auth/*` is delegated to that
 *     workspace's cached better-auth instance, whose internal `basePath` is
 *     `/api/t/{slug}/auth` so the URL routes correctly.
 *
 * No middleware here uses the control-plane session: customer end-users
 * authenticate against the tenant pool via bearer tokens (the better-auth
 * `bearer` plugin), not the platform's session cookie.
 */
const resolveTenant = async (c: Context<AppBindings>) => {
  const ctx = c.get("ctx");
  const slug = c.req.param("slug");
  const tenant = slug
    ? await findTenantBySlugOrId({ db: ctx.db, dialect: ctx.dialect }, slug)
    : null;
  if (!tenant) throw new AppError("NOT_FOUND", `Workspace "${slug ?? ""}" not found`);
  return { ctx, tenant };
};

/** App-session lifetime in seconds, falling back to 7 days when the
 *  workspace's auth_config doesn't pin one. Matches better-auth's
 *  bearer-plugin convention. */
const DEFAULT_APP_SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const parseLifetime = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const m = /^(\d+)\s*([smhd])$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
};

import { type ClientAddressEnv, clientAddress } from "../lib/client-address";
const extractIp = (req: Request, env: ClientAddressEnv): string | null =>
  clientAddress(req, env);

/**
 * Validate a `relayState` value against the workspace's redirect-URL
 * allowlist. Throws on a hostile URL (open-redirect protection). When no
 * redirectUrls are configured we accept only same-origin returns (the
 * deployment's APP_URL) — better than failing the login outright.
 */
const validateRelayState = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite"; env: { APP_URL: string } },
  tenantId: string,
  rawRelayState: string | undefined,
): Promise<string> => {
  const appOrigin = new URL(ctx.env.APP_URL).origin;
  if (!rawRelayState) return ctx.env.APP_URL;
  let target: URL;
  try {
    target = new URL(rawRelayState, ctx.env.APP_URL);
  } catch {
    throw new AppError("VALIDATION", "Invalid relayState URL");
  }
  if (target.origin === appOrigin) return target.toString();
  const row = await loadAuthConfigRow(
    { db: ctx.db as any, dialect: ctx.dialect },
    tenantId,
  );
  const allowed = (row?.redirectUrls ?? [])
    .map((u) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    })
    .filter((s): s is string => s !== null);
  if (!allowed.includes(target.origin)) {
    throw new AppError("FORBIDDEN", "relayState target origin not allowed");
  }
  return target.toString();
};

const writeVerification = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  identifier: string,
  value: string,
  expiresAt: Date,
): Promise<void> => {
  const t =
    ctx.dialect === "pg"
      ? pg.schema.appVerifications
      : sqlite.schema.appVerifications;
  await (ctx.db as any).insert(t).values({
    id: crypto.randomUUID(),
    tenantId,
    identifier,
    value,
    expiresAt: ctx.dialect === "pg" ? expiresAt : expiresAt.getTime(),
  });
};

const findVerification = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  identifier: string,
): Promise<{ id: string; value: string; expiresAt: number } | null> => {
  const t =
    ctx.dialect === "pg"
      ? pg.schema.appVerifications
      : sqlite.schema.appVerifications;
  const rows = (await (ctx.db as any)
    .select({ id: t.id, value: t.value, expiresAt: t.expiresAt })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.identifier, identifier)))
    .limit(1)) as Array<{ id: string; value: string; expiresAt: Date | number }>;
  const row = rows[0];
  if (!row) return null;
  const exp = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  return { id: row.id, value: row.value, expiresAt: exp };
};

const consumeVerification = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  id: string,
): Promise<void> => {
  const t =
    ctx.dialect === "pg"
      ? pg.schema.appVerifications
      : sqlite.schema.appVerifications;
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};

interface AppSessionArgs {
  tenantId: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  lifetimeSeconds: number;
}

const issueAppSession = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  args: AppSessionArgs,
): Promise<{ id: string; token: string; expiresAt: Date }> => {
  const t =
    ctx.dialect === "pg" ? pg.schema.appSessions : sqlite.schema.appSessions;
  const id = crypto.randomUUID();
  const token = `app_${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.lifetimeSeconds * 1000);
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: args.tenantId,
    userId: args.userId,
    token,
    expiresAt: ctx.dialect === "pg" ? expiresAt : expiresAt.getTime(),
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    createdAt: ctx.dialect === "pg" ? now : now.getTime(),
    updatedAt: ctx.dialect === "pg" ? now : now.getTime(),
  });
  return { id, token, expiresAt };
};

/**
 * The workspace's `custom-access-token` hook, resolved for one about-to-be
 * minted token. Returns `{}` when no hook is configured — which is the case
 * for nearly every workspace, and why the role lookup is a thunk rather than a
 * value (see `runCustomAccessTokenHook`).
 */
const customClaimsFor = async (
  ctx: { db: any; dialect: "pg" | "sqlite"; env: JwtEnv },
  args: { tenantId: string; userId: string; email: string | null; sessionId: string },
): Promise<Record<string, unknown>> =>
  runCustomAccessTokenHook(
    // Passed whole rather than sliced to `{db, dialect, env}`: every caller
    // here holds the request `Ctx`, and a function-target hook then runs with
    // the real host bindings instead of a stub.
    ctx as unknown as { db: any; dialect: "pg" | "sqlite"; env: Env },
    args.tenantId,
    { userId: args.userId, email: args.email, sessionId: args.sessionId },
    async () =>
      (
        await loadRolesForUser(
          { db: ctx.db, dialect: ctx.dialect },
          args.userId,
          args.tenantId,
          // App plane: the membership gate is control-plane only, since an
          // end-user has no `tenant_members` row — their session is pinned to
          // its issuing workspace instead. `"member"` is still the honest
          // answer, and it is the strict one.
          { plane: "app", access: "member" },
        )
      ).map((r) => r.name),
  );

/**
 * Issue a sign-in token pair: the `app_sessions` row doubles as the
 * long-lived, revocable *refresh* token; the HS256 JWT is the short-lived
 * stateless *access* token verified without a DB round-trip on every request.
 */
const issueTokenPair = async (
  ctx: { db: any; dialect: "pg" | "sqlite"; env: JwtEnv },
  args: AppSessionArgs & { email: string | null },
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: Date;
}> => {
  const session = await issueAppSession(ctx, args);
  const access = await signAccessToken(
    ctx.env,
    {
      sub: args.userId,
      tid: args.tenantId,
      sid: session.id,
      email: args.email,
    },
    undefined,
    await customClaimsFor(ctx, {
      tenantId: args.tenantId,
      userId: args.userId,
      email: args.email,
      sessionId: session.id,
    }),
  );
  return {
    accessToken: access.token,
    refreshToken: session.token,
    expiresIn: access.expiresIn,
    refreshExpiresAt: session.expiresAt,
  };
};

/**
 * Resolve a refresh token (an `app_sessions.token`) to its live session, or
 * `null` when the token is unknown, expired, or the end-user is suspended.
 * Tenant-scoped so a token from another workspace can't be exchanged here.
 */
const findRefreshSession = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  token: string,
): Promise<{ id: string; userId: string; email: string | null } | null> => {
  const t =
    ctx.dialect === "pg"
      ? { sessions: pg.schema.appSessions, users: pg.schema.appUsers }
      : { sessions: sqlite.schema.appSessions, users: sqlite.schema.appUsers };
  const rows = (await (ctx.db as any)
    .select({
      id: t.sessions.id,
      userId: t.sessions.userId,
      expiresAt: t.sessions.expiresAt,
      email: t.users.email,
      status: t.users.status,
    })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
    .where(and(eq(t.sessions.token, token), eq(t.sessions.tenantId, tenantId)))
    .limit(1)) as Array<{
      id: string;
      userId: string;
      expiresAt: Date | number;
      email: string | null;
      status: string;
    }>;
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "active") return null;
  const exp =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  if (exp <= Date.now()) return null;
  return { id: row.id, userId: row.userId, email: row.email };
};

const revokeAppSession = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  token: string,
): Promise<void> => {
  const t =
    ctx.dialect === "pg" ? pg.schema.appSessions : sqlite.schema.appSessions;
  await (ctx.db as any).delete(t).where(eq(t.token, token));
};

const pruneExpiredVerifications = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
): Promise<void> => {
  const t =
    ctx.dialect === "pg"
      ? pg.schema.appVerifications
      : sqlite.schema.appVerifications;
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  try {
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.tenantId, tenantId), lt(t.expiresAt, now as never)));
  } catch {
    // best-effort
  }
};

export const tenantAuthRoutes = new Hono<AppBindings>()
  .get("/:slug/auth/providers", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const dbCtx = { db: ctx.db as any, dialect: ctx.dialect };
    const surface = await resolveAuthSurface(
      dbCtx,
      ctx.env,
      tenant.id,
      tenant.slug,
    );
    // Only `disabled` reaches the workspace plane — mirrors the gate below.
    return c.json({
      data: applyPasswordLoginMode(
        surface,
        await loadPasswordLoginMode(ctx.db, ctx.dialect),
        "app",
      ),
    });
  })
  /**
   * SP-initiated SAML login. Builds an AuthnRequest, persists its id in
   * `app_verifications` for the ACS to match against `inResponseTo`, then
   * redirects the user-agent to the IdP.
   */
  .get("/:slug/auth/saml/:providerSlug/login", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const providerSlug = c.req.param("providerSlug");
    if (!providerSlug) throw new AppError("VALIDATION", "Provider slug required");
    const rawRelay = c.req.query("relayState") ?? c.req.query("returnTo") ?? "";
    const relayState = await validateRelayState(
      { db: ctx.db as any, dialect: ctx.dialect, env: ctx.env },
      tenant.id,
      rawRelay,
    );
    const resolved = await resolveSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      tenant.id,
      tenant.slug,
      providerSlug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");
    const { url, requestId } = await resolved.adapter.buildAuthnRequest(resolved.cfg, {
      relayState,
    });
    await writeVerification(
      { db: ctx.db, dialect: ctx.dialect },
      tenant.id,
      `saml-req:${requestId}`,
      JSON.stringify({ providerSlug, relayState, requestId }),
      new Date(Date.now() + 10 * 60 * 1000),
    );
    return c.redirect(url, 302);
  })
  /**
   * Assertion Consumer Service. Verifies the signature, blocks replays,
   * provisions the app_user, issues an app_session, then redirects the
   * user-agent to the validated `relayState` with the session token in
   * the URL fragment.
   */
  .post("/:slug/auth/saml/:providerSlug/acs", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const providerSlug = c.req.param("providerSlug");
    if (!providerSlug) throw new AppError("VALIDATION", "Provider slug required");

    const form = await c.req.formData();
    const samlResponse = form.get("SAMLResponse");
    if (typeof samlResponse !== "string" || samlResponse.length === 0) {
      throw new AppError("VALIDATION", "Missing SAMLResponse");
    }
    const relayStateFromForm = form.get("RelayState");

    const resolved = await resolveSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      tenant.id,
      tenant.slug,
      providerSlug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");

    // 1. Verify signature + audience + issuer + NotOnOrAfter.
    let assertion;
    try {
      assertion = await resolved.adapter.verifyAssertion(resolved.cfg, samlResponse);
    } catch (err) {
      throw new AppError(
        "UNAUTHORIZED",
        `SAML verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 1b. The assertion has to have been minted for THIS endpoint. `Recipient`
    //     is inside the signed scope, so this is the half that an attacker
    //     cannot edit away.
    assertAssertionBoundToAcs(assertion, resolved.cfg.acsUrl);

    // 2. Replay protection. We keep the row until NotOnOrAfter — if the same
    //    assertion is seen again before then, reject. The identity is the
    //    SIGNED `<Assertion>` `@ID`; keying it on the unsigned envelope's `@ID`
    //    meant one edited byte produced a fresh key and replayed the login.
    const replayKey = `saml-assertion:${samlReplayIdentity(assertion)}`;
    const replayHit = await findVerification(
      { db: ctx.db, dialect: ctx.dialect },
      tenant.id,
      replayKey,
    );
    if (replayHit) {
      throw new AppError("UNAUTHORIZED", "SAML assertion replay detected");
    }
    await writeVerification(
      { db: ctx.db, dialect: ctx.dialect },
      tenant.id,
      replayKey,
      "1",
      assertion.notOnOrAfter,
    );

    // 3. Match InResponseTo against the saved AuthnRequest (SP-initiated).
    //    IdP-initiated flows (no InResponseTo) get the deployment APP_URL as
    //    the default landing target.
    let relayState: string;
    let storedReq: { id: string; value: string } | null = null;
    if (assertion.inResponseTo) {
      storedReq = await findVerification(
        { db: ctx.db, dialect: ctx.dialect },
        tenant.id,
        `saml-req:${assertion.inResponseTo}`,
      );
      if (!storedReq) {
        throw new AppError(
          "UNAUTHORIZED",
          "SAML InResponseTo does not match a known AuthnRequest",
        );
      }
      try {
        const parsed = JSON.parse(storedReq.value) as { relayState?: string };
        relayState = await validateRelayState(
          { db: ctx.db as any, dialect: ctx.dialect, env: ctx.env },
          tenant.id,
          parsed.relayState,
        );
      } catch {
        relayState = ctx.env.APP_URL;
      }
    } else {
      relayState = await validateRelayState(
        { db: ctx.db as any, dialect: ctx.dialect, env: ctx.env },
        tenant.id,
        typeof relayStateFromForm === "string" ? relayStateFromForm : undefined,
      );
    }
    if (storedReq) {
      await consumeVerification(
        { db: ctx.db, dialect: ctx.dialect },
        storedReq.id,
      );
    }

    // 4. Map attributes via attribute_map.
    const am = resolved.row.attributeMap ?? {};
    const emailKey = am.email ?? "email";
    const firstKey = am.firstName ?? "firstName";
    const lastKey = am.lastName ?? "lastName";
    const groupsKey = am.groups ?? "groups";
    const email = assertion.attributes[emailKey]?.[0] ?? assertion.nameId;
    const firstName = assertion.attributes[firstKey]?.[0];
    const lastName = assertion.attributes[lastKey]?.[0];
    const groups = assertion.attributes[groupsKey] ?? [];

    if (!email) {
      throw new AppError("VALIDATION", "SAML assertion missing email attribute");
    }

    // 5. Provision the app-user + role sync.
    const { appUserId } = await provisionAppUser({
      ctx: { db: ctx.db, dialect: ctx.dialect },
      hookEnv: ctx.env,
      tenantId: tenant.id,
      providerType: "saml",
      providerId: resolved.row.id,
      subject: assertion.nameId,
      email,
      firstName,
      lastName,
      groups,
      defaultRoleId: resolved.row.defaultRoleId ?? null,
      groupsToRoles: resolved.row.groupsToRoles ?? null,
      linkByVerifiedEmail: resolved.row.linkByVerifiedEmail,
      ipAddress: extractIp(c.req.raw, c.get("ctx").env) ?? undefined,
      authnContext: assertion.authnContext,
    });

    // 6. Issue an app session.
    const lifetime =
      parseLifetime(
        (await loadAuthConfigRow(
          { db: ctx.db as any, dialect: ctx.dialect },
          tenant.id,
        ))?.sessionLifetime,
      ) ?? DEFAULT_APP_SESSION_LIFETIME_SECONDS;
    const { token } = await issueAppSession(
      { db: ctx.db, dialect: ctx.dialect },
      {
        tenantId: tenant.id,
        userId: appUserId,
        ipAddress: extractIp(c.req.raw, c.get("ctx").env),
        userAgent: c.req.raw.headers.get("user-agent"),
        lifetimeSeconds: lifetime,
      },
    );

    // Best-effort: drop expired verification rows.
    void pruneExpiredVerifications(
      { db: ctx.db, dialect: ctx.dialect },
      tenant.id,
    );

    // 7. Redirect to the validated relayState with the bearer token in the
    //    URL fragment (better-auth bearer-plugin convention). The fragment
    //    isn't transmitted in the network request, so the token is not
    //    captured in proxy/server logs.
    const target = new URL(relayState);
    target.hash = `token=${encodeURIComponent(token)}&type=saml`;
    return c.redirect(target.toString(), 302);
  })
  /**
   * Publish the SP's SAML metadata XML. IdPs consume this to configure
   * themselves (entityID, ACS binding, signing cert if applicable).
   */
  .get("/:slug/auth/saml/:providerSlug/metadata", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const providerSlug = c.req.param("providerSlug");
    if (!providerSlug) throw new AppError("VALIDATION", "Provider slug required");
    const resolved = await resolveSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      tenant.id,
      tenant.slug,
      providerSlug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");
    const xml = resolved.adapter.metadataXml(resolved.cfg);
    return new Response(xml, {
      status: 200,
      headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" },
    });
  })
  /**
   * SP- or IdP-initiated logout. SP-initiated: a bearer token in
   * `Authorization` or query (`token=…`) is revoked; if the IdP exposes an
   * SLO URL and we have a NameID, redirect to it with a LogoutRequest.
   * IdP-initiated: the IdP POSTs a `SAMLRequest` — we acknowledge by
   * revoking matching sessions and ending. Both flows tolerate an absent
   * SLO URL by ending locally.
   */
  .all("/:slug/auth/saml/:providerSlug/slo", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const providerSlug = c.req.param("providerSlug");
    if (!providerSlug) throw new AppError("VALIDATION", "Provider slug required");
    const resolved = await resolveSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      tenant.id,
      tenant.slug,
      providerSlug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");

    let token: string | null = null;
    const authHeader = c.req.raw.headers.get("authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer ")) token = authHeader.slice(7).trim();
    if (!token) token = c.req.query("token") ?? null;
    if (token) await revokeAppSession({ db: ctx.db, dialect: ctx.dialect }, token);

    if (!resolved.cfg.sloUrl) return c.json({ ok: true });
    const nameId = c.req.query("nameId");
    if (!nameId) return c.json({ ok: true });
    const logout = await resolved.adapter.buildLogoutRequest(resolved.cfg, {
      nameId,
      sessionIndex: c.req.query("sessionIndex") ?? undefined,
    });
    if (!logout) return c.json({ ok: true });
    return c.redirect(logout.url, 302);
  })
  /**
   * LDAP / Active Directory sign-in. Form-driven: the customer's app POSTs
   * `{ username, password }` and we either return `{ token, user }` or 401.
   *
   * Flow:
   *   1. resolve the tenant + its LDAP config (null → 503 UNAVAILABLE);
   *   2. rate-limit per `(tenant_id, normalized_username, ip)` against
   *      `config.rateLimitPerMinute`;
   *   3. if `config.domainMatch` is set and the username looks like email,
   *      bail BEFORE the LDAP roundtrip when the domain isn't allow-listed;
   *   4. `adapter.authenticate(username, password)` → null → 401 (we do NOT
   *      distinguish "no such user" from "wrong password");
   *   5. provision the app_user (`linkByVerifiedEmail: false` — LDAP users
   *      are directory-bound, no cross-provider linking by default);
   *   6. issue an `app_sessions` row + return `{ token, user }`.
   */
  .post("/:slug/auth/ldap/sign-in", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const body = (await readJsonOr(c.req, null)) as
      | { username?: unknown; password?: unknown }
      | null;
    const username =
      typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) {
      throw new AppError("VALIDATION", "username and password are required");
    }

    const resolved = await resolveLdapAdapter(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      tenant.id,
    );
    if (!resolved) {
      throw new AppError(
        "UNAVAILABLE",
        "LDAP is not configured or not available on this runtime",
      );
    }
    const { adapter, config } = resolved;

    // Per-(tenant, username, ip) rate limit. Both successes and failures count
    // — directory brute-force attempts shouldn't get a clean window from
    // throwing the right password somewhere along the way.
    // No `x-real-ip` fallback: off a trusted proxy that header is whatever the
    // caller typed, so falling back to it hands the limiter a fresh bucket per
    // request — which is the defect this derivation exists to close.
    const ip = extractIp(c.req.raw, c.get("ctx").env) ?? "unknown";
    const rlKey = `ldap:${tenant.id}:${username.toLowerCase()}:${ip}`;
    if (!(await rateLimitOk(ctx.env, rlKey, config.rateLimitPerMinute, 60_000))) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many LDAP sign-in attempts — try again in a minute",
      );
    }

    // Domain allow-list — applied BEFORE the LDAP roundtrip when the username
    // looks like an email and a list is configured.
    if (config.domainMatch && config.domainMatch.length > 0 && username.includes("@")) {
      const domain = username.split("@")[1]?.toLowerCase() ?? "";
      const allowed = config.domainMatch.map((d) => d.toLowerCase());
      if (!allowed.includes(domain)) {
        throw new AppError("VALIDATION", "Email domain not allowed for LDAP sign-in");
      }
    }

    // Authenticate against the directory. Transport errors throw → 500.
    let attrs;
    try {
      attrs = await adapter.authenticate(username, password);
    } catch (err) {
      throw new AppError(
        "INTERNAL",
        `LDAP transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!attrs) {
      throw new AppError("UNAUTHORIZED", "Invalid credentials");
    }
    if (!attrs.email) {
      throw new AppError(
        "VALIDATION",
        "LDAP user has no email attribute (configure attributeMap.email)",
      );
    }

    // Provision the app-user. `linkByVerifiedEmail: false` — LDAP is the
    // identity authority for these users; we don't auto-link to whatever
    // happens to share their email locally.
    const { appUserId } = await provisionAppUser({
      ctx: { db: ctx.db, dialect: ctx.dialect },
      hookEnv: ctx.env,
      tenantId: tenant.id,
      providerType: "ldap",
      providerId: "ldap",
      subject: attrs.dn,
      email: attrs.email,
      firstName: attrs.firstName,
      lastName: attrs.lastName,
      groups: attrs.groups,
      defaultRoleId: config.defaultRoleId ?? null,
      groupsToRoles: config.groupsToRoles ?? null,
      linkByVerifiedEmail: false,
      ipAddress: extractIp(c.req.raw, c.get("ctx").env) ?? undefined,
      authnContext: "ldap-simple-bind",
    });

    const lifetime =
      parseLifetime(
        (await loadAuthConfigRow(
          { db: ctx.db as any, dialect: ctx.dialect },
          tenant.id,
        ))?.sessionLifetime,
      ) ?? DEFAULT_APP_SESSION_LIFETIME_SECONDS;
    const tokens = await issueTokenPair(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      {
        tenantId: tenant.id,
        userId: appUserId,
        email: attrs.email,
        ipAddress: extractIp(c.req.raw, c.get("ctx").env),
        userAgent: c.req.raw.headers.get("user-agent"),
        lifetimeSeconds: lifetime,
      },
    );

    return c.json({
      // `token` is the legacy field — identical to `refreshToken`. Kept so
      // existing opaque-bearer clients keep working; new (mobile) clients use
      // the short-lived `accessToken` and refresh it via /auth/token/refresh.
      token: tokens.refreshToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: "Bearer",
      user: { id: appUserId, email: attrs.email },
    });
  })
  /**
   * Exchange a refresh token for a fresh access token. The refresh token is
   * an `app_sessions.token` (returned as `refreshToken` by every sign-in
   * path, or in the SAML redirect fragment). Accepts it in the JSON body
   * (`refreshToken` or legacy `token`) or as an `Authorization: Bearer`
   * header. The refresh token itself is unchanged — it stays valid until its
   * own expiry or until the session row is revoked.
   */
  .post("/:slug/auth/token/refresh", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const body = (await readJsonOr(c.req, null)) as
      | { refreshToken?: unknown; token?: unknown }
      | null;
    let refreshToken =
      typeof body?.refreshToken === "string"
        ? body.refreshToken.trim()
        : typeof body?.token === "string"
          ? body.token.trim()
          : "";
    if (!refreshToken) {
      const authHeader = c.req.raw.headers.get("authorization") ?? "";
      if (authHeader.toLowerCase().startsWith("bearer ")) {
        refreshToken = authHeader.slice("bearer ".length).trim();
      }
    }
    if (!refreshToken) {
      throw new AppError("VALIDATION", "refreshToken is required");
    }

    const session = await findRefreshSession(
      { db: ctx.db, dialect: ctx.dialect },
      tenant.id,
      refreshToken,
    );
    if (!session) {
      throw new AppError("UNAUTHORIZED", "Invalid or expired refresh token");
    }

    const access = await signAccessToken(
      ctx.env,
      {
        sub: session.userId,
        tid: tenant.id,
        sid: session.id,
        email: session.email,
      },
      undefined,
      // Re-run on every refresh rather than copying the claims off the old
      // token: the whole point of a 15-minute access token is that a plan
      // change or a role demotion is felt within the window, and claims
      // carried forward would outlive both.
      await customClaimsFor(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        {
          tenantId: tenant.id,
          userId: session.userId,
          email: session.email,
          sessionId: session.id,
        },
      ),
    );
    return c.json({
      accessToken: access.token,
      refreshToken,
      expiresIn: access.expiresIn,
      tokenType: "Bearer",
    });
  })
  /**
   * Public preview of an admin-issued end-user invitation — everything the
   * accept page (`/t/:slug/join/:token`) can put in front of somebody who has
   * no account yet, and nothing else.
   *
   * Unauthenticated by construction. The invitee is a person this workspace has
   * only ever reached at an email address, so requiring a session to read the
   * invitation would demand the very thing the invitation exists to hand over.
   * Nothing upstream refuses them either, and that is a property of the mount
   * rather than an exemption carved into it: `/api/t/*` carries four
   * middlewares and all four let this GET through untouched — the auth rate
   * limiter gates only POST/PUT/PATCH/DELETE, the per-account lockout and the
   * captcha gate both return early on any method that is not POST, and the
   * password-verification auth hook only fires on a sign-in. None consults a
   * session. No shared middleware had to be weakened to make this reachable.
   *
   * ONE response shape for every unusable token. Unknown, expired, already
   * spent, or pointing at an `app_users` row that has since been deleted or
   * suspended — all four answer the identical
   * `{ valid: false, workspaceName: null, email: null }`. So the endpoint
   * cannot be walked to learn which tokens exist, and because the invited
   * address is withheld on that branch it cannot be asked whether a given
   * person was ever invited here. Reporting "expired" separately would be
   * friendlier and is deliberately not done: it would turn each refusal into a
   * two-valued answer about a token the caller has no other way to probe.
   *
   * The workspace existing at all is NOT concealed — `resolveTenant` still 404s
   * an unknown slug, exactly as the sibling `GET /:slug/auth/providers` does.
   * That fact is already public through that endpoint, so nothing new is
   * disclosed by matching it, and one response shape per *token* is what the
   * oracle argument is actually about.
   *
   * What the valid branch discloses is bounded to the two facts an invitee
   * needs in order to decide whether the page is trustworthy: the workspace's
   * OWN name (`tenants.name`) and the address the invitation was sent to —
   * which is, by definition, already sitting in the mailbox that received the
   * link. Nothing else about the workspace or its users crosses this line: not
   * the tenant id, not who sent it, not the roles attached, not whether other
   * members exist.
   *
   * Why the name and nothing more, on a page that is unauthenticated: a
   * workspace admin picks `tenants.name`, so it is operator-authored text
   * rendered to a stranger, and that is precisely the raw material of a
   * phishing page. The line drawn is that a workspace may identify ITSELF and
   * may not say anything else — the name is the minimum an invitee needs to
   * recognise an expected invitation, React escapes it as text, and it is the
   * only operator-controlled string the page renders. There is deliberately no
   * invitation "message"/"note" field to pass through, because free text under
   * the workspace's own branding, on a page that already shows a password box,
   * is a credential-harvesting surface that this endpoint would be the one
   * supplying.
   *
   * Mounted BEFORE the better-auth catch-all so it isn't proxied there.
   */
  .get("/:slug/auth/invite/:token", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const dbCtx = { db: ctx.db, dialect: ctx.dialect };
    // Declared once and returned from every refusal below, so the branches
    // cannot drift apart into telling one kind of failure from another.
    const unusable: { valid: boolean; workspaceName: string | null; email: string | null } = {
      valid: false,
      workspaceName: null,
      email: null,
    };

    const token = (c.req.param("token") ?? "").trim();
    if (!token) return c.json({ data: unusable });

    const invite = await findAppUserInvite(dbCtx, tenant.id, token);
    if (!invite || invite.expired) return c.json({ data: unusable });

    // "Usable" is defined as "the accept call below would not refuse it" —
    // same row lookup, same suspended check, kept adjacent so they stay in
    // step. Answering `valid` for an invitation that accept then rejects would
    // seat the invitee in front of a form that cannot succeed, which is the
    // shape of dead end this whole page exists to remove.
    const users = ctx.dialect === "pg" ? pg.schema.appUsers : sqlite.schema.appUsers;
    const rows = (await (ctx.db as any)
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(and(eq(users.id, invite.appUserId), eq(users.tenantId, tenant.id)))
      .limit(1)) as Array<{ id: string; status: string }>;
    const user = rows[0];
    if (!user || user.status === "suspended") return c.json({ data: unusable });

    const tenantsTable = ctx.dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;
    const ws = (await (ctx.db as any)
      .select({ name: tenantsTable.name })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenant.id))
      .limit(1)) as Array<{ name: string }>;

    return c.json({
      data: {
        valid: true,
        // Falls back to the slug rather than a literal like "workspace": the
        // slug is in the URL the invitee already followed, so it can never be
        // more identifying than what they hold.
        workspaceName: ws[0]?.name ?? tenant.slug,
        email: invite.email,
      },
    });
  })
  /**
   * Accept an admin-issued end-user invite (`POST /api/app-users/invite`):
   * `{ token, password }` sets the credential on the pending `app_users` row,
   * flips it to `active` (email counted as verified — the token arrived at
   * that mailbox), consumes the one-shot token, and signs the user straight
   * in with the same token pair every other sign-in path returns.
   *
   * Mounted BEFORE the better-auth catch-all so it isn't proxied there.
   */
  .post("/:slug/auth/invite/accept", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const dbCtx = { db: ctx.db, dialect: ctx.dialect };
    const body = (await readJsonOr(c.req, null)) as
      | { token?: unknown; password?: unknown }
      | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!token || !password) {
      throw new AppError("VALIDATION", "token and password are required");
    }
    // Match better-auth's `minPasswordLength` for the email+password flow.
    if (password.length < 8) {
      throw new AppError("VALIDATION", "Password must be at least 8 characters");
    }

    const invite = await findAppUserInvite(dbCtx, tenant.id, token);
    if (!invite) throw new AppError("NOT_FOUND", "Invite not found");
    if (invite.expired) throw new AppError("VALIDATION", "Invite has expired");

    const t =
      ctx.dialect === "pg"
        ? { users: pg.schema.appUsers, accounts: pg.schema.appAccounts }
        : { users: sqlite.schema.appUsers, accounts: sqlite.schema.appAccounts };
    const users = (await (ctx.db as any)
      .select({ id: t.users.id, email: t.users.email, status: t.users.status })
      .from(t.users)
      .where(and(eq(t.users.id, invite.appUserId), eq(t.users.tenantId, tenant.id)))
      .limit(1)) as Array<{ id: string; email: string; status: string }>;
    const user = users[0];
    if (!user) throw new AppError("NOT_FOUND", "Invited end-user no longer exists");
    if (user.status === "suspended") {
      throw new AppError("FORBIDDEN", "This account is suspended");
    }

    // Set the credential — better-auth's own scrypt format (`hashSecret`
    // re-exports better-auth/crypto), so the normal email+password sign-in
    // verifies it from here on.
    //
    // ...but ONLY when the account does not already have one. An invitation's
    // job is to seat an account at the standing it was invited to; it is not a
    // password reset, and this endpoint is public. Whoever holds a live token
    // would otherwise overwrite a working credential without ever proving they
    // know it — an unauthenticated account takeover of somebody who had already
    // finished signing up. The accept page's `existing` mode verifies the
    // current password before calling here, but that check runs in a browser
    // the attacker simply does not use, so the guarantee has to live HERE.
    //
    // Skipping the write costs the legitimate `existing` flow nothing: that
    // path submits the password the account already has, so the update was a
    // no-op in the only case it was ever reached honestly. Everything below
    // still runs, which is the part that actually matters — the invite is
    // consumed and the roles are granted.
    //
    // A genuinely forgotten password goes through the workspace's own reset
    // flow, which mails the address on file rather than trusting a token that
    // may have been forwarded, screenshotted, or read out of a backup.
    const hash = await hashSecret(password);
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    const existing = (await (ctx.db as any)
      .select({ id: t.accounts.id })
      .from(t.accounts)
      .where(and(eq(t.accounts.userId, user.id), eq(t.accounts.providerId, "credential")))
      .limit(1)) as Array<{ id: string }>;
    // No `else` branch on purpose: an existing credential row is left exactly
    // as it stands.
    if (!existing[0]) {
      await (ctx.db as any).insert(t.accounts).values({
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: hash,
        createdAt: now,
        updatedAt: now,
      });
    }

    await (ctx.db as any)
      .update(t.users)
      .set({ status: "active", emailVerified: true, updatedAt: now })
      .where(eq(t.users.id, user.id));
    await consumeAppUserInvite(dbCtx, invite.id);

    // Implicit `authenticated` role, same as every other provisioning path.
    await ensureSystemRoles(dbCtx, tenant.id);
    await assignAppUserRoleByName(dbCtx, tenant.id, user.id, SYSTEM_ROLES.authenticated);
    invalidateUserRoles(tenant.id, user.id);

    const lifetime =
      parseLifetime(
        (await loadAuthConfigRow(
          { db: ctx.db as any, dialect: ctx.dialect },
          tenant.id,
        ))?.sessionLifetime,
      ) ?? DEFAULT_APP_SESSION_LIFETIME_SECONDS;
    const tokens = await issueTokenPair(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      {
        tenantId: tenant.id,
        userId: user.id,
        email: user.email,
        ipAddress: extractIp(c.req.raw, c.get("ctx").env),
        userAgent: c.req.raw.headers.get("user-agent"),
        lifetimeSeconds: lifetime,
      },
    );
    return c.json({
      // Same shape as the LDAP sign-in: `token` = the opaque refresh token
      // (what existing bearer clients replay), plus the short-lived JWT pair.
      token: tokens.refreshToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: "Bearer",
      user: { id: user.id, email: user.email },
    });
  })
  .all("/:slug/auth/*", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    // The workspace (app) plane. `disabled` blocks here; `app-only` does not —
    // that mode exists precisely to move staff onto SSO while customers keep
    // the login they signed up with.
    const passwordBlocked = await passwordLoginBlocked(
      { db: ctx.db as any, dialect: ctx.dialect },
      c.req.path,
      "app",
    );
    if (passwordBlocked) throw new AppError("FORBIDDEN", passwordBlocked);
    const auth = await getTenantAuth(
      { db: ctx.db, dialect: ctx.dialect },
      ctx.env,
      ctx.email,
      tenant,
    );
    return auth.handler(c.req.raw);
  });
