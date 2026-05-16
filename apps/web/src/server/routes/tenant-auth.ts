import { Hono, type Context } from "hono";
import { and, eq, lt } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId, getTenantAuth } from "../services/tenant-auth";
import { loadAuthConfigRow, resolveAuthSurface } from "../services/auth-config";
import { resolveSamlProvider } from "../services/saml-providers";
import { resolveLdapAdapter } from "../services/ldap-config";
import { provisionAppUser } from "../services/sso-provisioning";
import { rateLimitOk } from "../lib/rate-limit";

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

const extractIp = (req: Request): string | null => {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
};

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

const issueAppSession = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  args: {
    tenantId: string;
    userId: string;
    ipAddress: string | null;
    userAgent: string | null;
    lifetimeSeconds: number;
  },
): Promise<{ token: string; expiresAt: Date }> => {
  const t =
    ctx.dialect === "pg" ? pg.schema.appSessions : sqlite.schema.appSessions;
  const token = `app_${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.lifetimeSeconds * 1000);
  await (ctx.db as any).insert(t).values({
    id: crypto.randomUUID(),
    tenantId: args.tenantId,
    userId: args.userId,
    token,
    expiresAt: ctx.dialect === "pg" ? expiresAt : expiresAt.getTime(),
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    createdAt: ctx.dialect === "pg" ? now : now.getTime(),
    updatedAt: ctx.dialect === "pg" ? now : now.getTime(),
  });
  return { token, expiresAt };
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
    const surface = await resolveAuthSurface(
      { db: ctx.db, dialect: ctx.dialect },
      ctx.env,
      tenant.id,
      tenant.slug,
    );
    return c.json({ data: surface });
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

    // 2. Replay protection. We keep the row until NotOnOrAfter — if the same
    //    AssertionID is seen again before then, reject.
    const replayKey = `saml-assertion:${assertion.id}`;
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
      ipAddress: extractIp(c.req.raw) ?? undefined,
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
        ipAddress: extractIp(c.req.raw),
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
    const body = (await c.req.json().catch(() => null)) as
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
    const ip =
      extractIp(c.req.raw) ?? c.req.raw.headers.get("x-real-ip") ?? "unknown";
    const rlKey = `ldap:${tenant.id}:${username.toLowerCase()}:${ip}`;
    if (!rateLimitOk(rlKey, config.rateLimitPerMinute, 60_000)) {
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
      ipAddress: extractIp(c.req.raw) ?? undefined,
      authnContext: "ldap-simple-bind",
    });

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
        ipAddress: extractIp(c.req.raw),
        userAgent: c.req.raw.headers.get("user-agent"),
        lifetimeSeconds: lifetime,
      },
    );

    return c.json({ token, user: { id: appUserId, email: attrs.email } });
  })
  .all("/:slug/auth/*", async (c) => {
    const { ctx, tenant } = await resolveTenant(c);
    const auth = await getTenantAuth(
      { db: ctx.db, dialect: ctx.dialect },
      ctx.env,
      ctx.email,
      tenant,
    );
    return auth.handler(c.req.raw);
  });
