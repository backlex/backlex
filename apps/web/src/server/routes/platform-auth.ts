/**
 * Control-plane (admin / "platform" plane) SSO endpoints — instance-global
 * SAML + LDAP for dashboard operators. Mounted under `/api/auth` BEFORE the
 * better-auth catch-all so these specific paths win.
 *
 * Mirror of the workspace flow (`routes/tenant-auth.ts`) with three deltas:
 *   - no tenant resolution — admin SSO is instance-global;
 *   - identities provision into `users` (see `platform-sso-provisioning.ts`);
 *   - sign-in mints a better-auth COOKIE session (via `mintPlatformSession`)
 *     instead of issuing a bearer token — the dashboard is cookie-authed.
 *
 * AuthnRequest correlation + assertion-replay state live in the platform
 * `verifications` table (better-auth's), keyed with `psaml-*` prefixes so they
 * never collide with better-auth's own email-verification rows.
 *
 * Gated by `PLATFORM_SSO_ENABLED` (see lib/platform-sso): when off, every route
 * 404s as if the feature weren't mounted.
 */
import { Hono } from "hono";
import { and, eq, like, lt } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { rateLimitOk } from "../lib/rate-limit";
import { recordActivity, requestMeta } from "../services/activity";
import { isPlatformSsoEnabled } from "../lib/platform-sso";
import { extractIp, mintPlatformSession } from "../lib/platform-session";
import {
  resolvePlatformSamlProvider,
} from "../services/platform-saml-providers";
import { resolvePlatformLdapAdapter } from "../services/platform-ldap-config";
import { provisionPlatformUser } from "../services/platform-sso-provisioning";

type DbCtx = { db: unknown; dialect: "pg" | "sqlite" };

const verificationsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.verifications : sqlite.schema.verifications;

/** Validate a relayState against the dashboard origin + EXTRA_TRUSTED_ORIGINS.
 *  Falls back to APP_URL when absent. Platform plane has no per-tenant list. */
const validatePlatformRelayState = (
  env: Pick<Env, "APP_URL" | "EXTRA_TRUSTED_ORIGINS">,
  raw: string | undefined,
): string => {
  if (!raw) return env.APP_URL;
  let target: URL;
  try {
    target = new URL(raw, env.APP_URL);
  } catch {
    throw new AppError("VALIDATION", "Invalid relayState URL");
  }
  const allowed = new Set<string>([new URL(env.APP_URL).origin]);
  for (const o of (env.EXTRA_TRUSTED_ORIGINS ?? "").split(",")) {
    const t = o.trim();
    if (!t) continue;
    try {
      allowed.add(new URL(t).origin);
    } catch {
      /* ignore malformed entry */
    }
  }
  if (!allowed.has(target.origin)) {
    throw new AppError("FORBIDDEN", "relayState target origin not allowed");
  }
  return target.toString();
};

const writeVerification = async (
  ctx: DbCtx,
  identifier: string,
  value: string,
  expiresAt: Date,
): Promise<void> => {
  const t = verificationsTable(ctx.dialect);
  await (ctx.db as any).insert(t).values({
    id: crypto.randomUUID(),
    identifier,
    value,
    expiresAt: ctx.dialect === "pg" ? expiresAt : (expiresAt as never),
  });
};

const findVerification = async (
  ctx: DbCtx,
  identifier: string,
): Promise<{ id: string; value: string } | null> => {
  const t = verificationsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.id, value: t.value })
    .from(t)
    .where(eq(t.identifier, identifier))
    .limit(1)) as Array<{ id: string; value: string }>;
  return rows[0] ?? null;
};

const consumeVerification = async (ctx: DbCtx, id: string): Promise<void> => {
  const t = verificationsTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};

/** Best-effort cleanup of expired `psaml-*` rows so the shared verifications
 *  table doesn't grow unbounded. Scoped to our prefix so it never touches
 *  better-auth's own verification rows. */
const pruneExpiredVerifications = async (ctx: DbCtx): Promise<void> => {
  const t = verificationsTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : (Date.now() as never);
  try {
    await (ctx.db as any)
      .delete(t)
      .where(and(lt(t.expiresAt, now as never), like(t.identifier, "psaml-%")));
  } catch {
    // best-effort
  }
};

/** Login-CSRF guard for cookie-setting POSTs: when an Origin header is present
 *  it must match APP_URL / a trusted origin. Absent Origin (non-browser API
 *  clients) is allowed. */
const assertAllowedOrigin = (
  env: Pick<Env, "APP_URL" | "EXTRA_TRUSTED_ORIGINS">,
  req: Request,
): void => {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const allowed = new Set<string>([new URL(env.APP_URL).origin]);
  for (const o of (env.EXTRA_TRUSTED_ORIGINS ?? "").split(",")) {
    const tr = o.trim();
    if (tr) {
      try {
        allowed.add(new URL(tr).origin);
      } catch {
        /* ignore */
      }
    }
  }
  if (!allowed.has(origin)) {
    throw new AppError("FORBIDDEN", "Cross-origin sign-in not allowed");
  }
};

/** 404 when the feature is gated off. */
const ensureEnabled = (env: Pick<Env, "PLATFORM_SSO_ENABLED">): void => {
  if (!isPlatformSsoEnabled(env)) {
    throw new AppError("NOT_FOUND", "Platform SSO is not enabled");
  }
};

export const platformAuthRoutes = new Hono<AppBindings>()
  /** SP-initiated SAML login → AuthnRequest → 302 to the IdP. */
  .get("/saml/:slug/login", async (c) => {
    const ctx = c.get("ctx");
    ensureEnabled(ctx.env);
    const slug = c.req.param("slug");
    if (!slug) throw new AppError("VALIDATION", "Provider slug required");
    const relayState = validatePlatformRelayState(
      ctx.env,
      c.req.query("relayState") ?? c.req.query("returnTo") ?? undefined,
    );
    const resolved = await resolvePlatformSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      slug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");
    const { url, requestId } = await resolved.adapter.buildAuthnRequest(resolved.cfg, {
      relayState,
    });
    await writeVerification(
      { db: ctx.db, dialect: ctx.dialect },
      `psaml-req:${requestId}`,
      JSON.stringify({ slug, relayState, requestId }),
      new Date(Date.now() + 10 * 60 * 1000),
    );
    return c.redirect(url, 302);
  })
  /** Assertion Consumer Service → verify → provision `users` → cookie → 302. */
  .post("/saml/:slug/acs", async (c) => {
    const ctx = c.get("ctx");
    ensureEnabled(ctx.env);
    const slug = c.req.param("slug");
    if (!slug) throw new AppError("VALIDATION", "Provider slug required");

    const form = await c.req.formData();
    const samlResponse = form.get("SAMLResponse");
    if (typeof samlResponse !== "string" || samlResponse.length === 0) {
      throw new AppError("VALIDATION", "Missing SAMLResponse");
    }
    const relayStateFromForm = form.get("RelayState");

    const resolved = await resolvePlatformSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      slug,
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

    // 2. Replay protection — keep the row until NotOnOrAfter.
    const replayKey = `psaml-assertion:${assertion.id}`;
    if (await findVerification({ db: ctx.db, dialect: ctx.dialect }, replayKey)) {
      throw new AppError("UNAUTHORIZED", "SAML assertion replay detected");
    }
    await writeVerification(
      { db: ctx.db, dialect: ctx.dialect },
      replayKey,
      "1",
      assertion.notOnOrAfter,
    );

    // 3. Match InResponseTo against the saved AuthnRequest (SP-initiated).
    let relayState: string;
    let storedReq: { id: string; value: string } | null = null;
    if (assertion.inResponseTo) {
      storedReq = await findVerification(
        { db: ctx.db, dialect: ctx.dialect },
        `psaml-req:${assertion.inResponseTo}`,
      );
      if (!storedReq) {
        throw new AppError(
          "UNAUTHORIZED",
          "SAML InResponseTo does not match a known AuthnRequest",
        );
      }
      try {
        const parsed = JSON.parse(storedReq.value) as { relayState?: string };
        relayState = validatePlatformRelayState(ctx.env, parsed.relayState);
      } catch {
        relayState = ctx.env.APP_URL;
      }
    } else {
      relayState = validatePlatformRelayState(
        ctx.env,
        typeof relayStateFromForm === "string" ? relayStateFromForm : undefined,
      );
    }
    if (storedReq) {
      await consumeVerification({ db: ctx.db, dialect: ctx.dialect }, storedReq.id);
    }

    // 4. Map attributes via attribute_map.
    const am = resolved.row.attributeMap ?? {};
    const email =
      assertion.attributes[am.email ?? "email"]?.[0] ?? assertion.nameId;
    const firstName = assertion.attributes[am.firstName ?? "firstName"]?.[0];
    const lastName = assertion.attributes[am.lastName ?? "lastName"]?.[0];
    const groups = assertion.attributes[am.groups ?? "groups"] ?? [];
    if (!email) {
      throw new AppError("VALIDATION", "SAML assertion missing email attribute");
    }

    // 4b. JIT allow-list: when the provider restricts domains, only provision
    //     operators whose asserted email is in-list. Stops a whole corporate
    //     IdP from auto-getting dashboard accounts.
    const allow = resolved.row.domainMatch;
    if (allow && allow.length > 0) {
      const domain = email.split("@")[1]?.toLowerCase() ?? "";
      if (!allow.map((d) => d.toLowerCase()).includes(domain)) {
        throw new AppError("FORBIDDEN", "Email domain not allowed for SSO");
      }
    }

    // 5. Provision the operator (`users`) + role sync.
    const { userId, isNew } = await provisionPlatformUser({
      ctx: { db: ctx.db, dialect: ctx.dialect },
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

    // 6. Mint the control-plane cookie session, then land on the dashboard.
    await mintPlatformSession(c, userId);
    void recordActivity(
      { db: ctx.db, dialect: ctx.dialect },
      {
        userId,
        tenantId: null,
        action: "auth.sso.login",
        collection: "auth",
        ...requestMeta(c.req.raw),
        payload: { providerType: "saml", providerId: resolved.row.id, isNew, email },
      },
    );
    void pruneExpiredVerifications({ db: ctx.db, dialect: ctx.dialect });
    return c.redirect(relayState, 302);
  })
  /** Publish the SP's SAML metadata XML for IdP configuration. */
  .get("/saml/:slug/metadata", async (c) => {
    const ctx = c.get("ctx");
    ensureEnabled(ctx.env);
    const slug = c.req.param("slug");
    if (!slug) throw new AppError("VALIDATION", "Provider slug required");
    const resolved = await resolvePlatformSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      slug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");
    const xml = resolved.adapter.metadataXml(resolved.cfg);
    return new Response(xml, {
      status: 200,
      headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" },
    });
  })
  /**
   * Logout. The control plane signs out via better-auth's own
   * `/api/auth/sign-out` (deletes the session row), so SP-initiated SLO here
   * only needs to honor an IdP redirect when one is configured.
   */
  .all("/saml/:slug/slo", async (c) => {
    const ctx = c.get("ctx");
    ensureEnabled(ctx.env);
    const slug = c.req.param("slug");
    if (!slug) throw new AppError("VALIDATION", "Provider slug required");
    const resolved = await resolvePlatformSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      slug,
    );
    if (!resolved) throw new AppError("NOT_FOUND", "SAML provider not found");
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
  /** LDAP / AD sign-in → provision `users` → cookie session. Self-host only
   *  (the adapter is unavailable on Workers — 503 there). */
  .post("/ldap/sign-in", async (c) => {
    const ctx = c.get("ctx");
    ensureEnabled(ctx.env);
    assertAllowedOrigin(ctx.env, c.req.raw);
    const body = (await c.req.json().catch(() => null)) as
      | { username?: unknown; password?: unknown }
      | null;
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) {
      throw new AppError("VALIDATION", "username and password are required");
    }

    const resolved = await resolvePlatformLdapAdapter({
      db: ctx.db,
      dialect: ctx.dialect,
      env: ctx.env,
    });
    if (!resolved) {
      throw new AppError(
        "UNAVAILABLE",
        "LDAP is not configured or not available on this runtime (use SAML on Cloudflare Workers)",
      );
    }
    const { adapter, config } = resolved;

    const ip = extractIp(c.req.raw) ?? "unknown";
    const rlKey = `pldap:${username.toLowerCase()}:${ip}`;
    if (!(await rateLimitOk(ctx.env, rlKey, config.rateLimitPerMinute, 60_000))) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many LDAP sign-in attempts — try again in a minute",
      );
    }

    if (config.domainMatch && config.domainMatch.length > 0 && username.includes("@")) {
      const domain = username.split("@")[1]?.toLowerCase() ?? "";
      if (!config.domainMatch.map((d) => d.toLowerCase()).includes(domain)) {
        throw new AppError("VALIDATION", "Email domain not allowed for LDAP sign-in");
      }
    }

    let attrs;
    try {
      attrs = await adapter.authenticate(username, password);
    } catch (err) {
      throw new AppError(
        "INTERNAL",
        `LDAP transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!attrs) throw new AppError("UNAUTHORIZED", "Invalid credentials");
    if (!attrs.email) {
      throw new AppError(
        "VALIDATION",
        "LDAP user has no email attribute (configure attributeMap.email)",
      );
    }

    const { userId, isNew } = await provisionPlatformUser({
      ctx: { db: ctx.db, dialect: ctx.dialect },
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

    await mintPlatformSession(c, userId);
    void recordActivity(
      { db: ctx.db, dialect: ctx.dialect },
      {
        userId,
        tenantId: null,
        action: "auth.sso.login",
        collection: "auth",
        ...requestMeta(c.req.raw),
        payload: { providerType: "ldap", providerId: "ldap", isNew, email: attrs.email },
      },
    );
    return c.json({ ok: true, user: { id: userId, email: attrs.email } });
  });
