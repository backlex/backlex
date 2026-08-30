import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../app";
import { verifyAccessToken, verifyAgentRunToken } from "../lib/jwt";
import { resolveImpersonation } from "../services/impersonation";
import { verifyThirdPartyToken } from "../lib/third-party-jwt";
import { findApiKey, touchLastUsed } from "../services/api-keys";
import { resolveThirdPartyUser } from "../services/third-party-auth";
import {
  getCachedAppSessionLive,
  getCachedSession,
  setCachedAppSessionLive,
  setCachedSession,
} from "../services/permissions-cache";

const extractIp = (req: Request): string | null => {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
};

const stampSessionMeta = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  sessionId: string,
  req: Request,
): Promise<void> => {
  const t = ctx.dialect === "pg" ? pg.schema.sessions : sqlite.schema.sessions;
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  // Only patch when the existing row is missing data — keeps writes off the
  // hot path for repeat requests in the same session.
  const set: Record<string, unknown> = {};
  if (ip) set.ipAddress = ip;
  if (ua) set.userAgent = ua;
  if (Object.keys(set).length === 0) return;
  try {
    await (ctx.db as any)
      .update(t)
      .set(set)
      .where(
        and(
          eq(t.id, sessionId),
          // Only fill empties — don't churn rows with the same value.
          ip ? isNull(t.ipAddress) : eq(t.id, sessionId),
        ),
      );
  } catch {
    // best-effort
  }
};

// stampSessionMeta only fills ip/ua once (WHERE ip_address IS NULL), so after
// the first stamp every later UPDATE matches 0 rows — yet still pays a D1
// round-trip on every request. Remember the session ids we've already stamped
// in this isolate and skip the no-op write entirely. Capped so a long-lived
// isolate can't grow it without bound.
const stampedSessions = new Set<string>();
const STAMPED_CAP = 10_000;

/** Stamp a session's ip/ua at most once per id per isolate, off the critical
 *  path. `waitUntil` keeps the isolate alive so the (first) write completes;
 *  falls back to a dangling promise where no ExecutionContext exists. */
const stampOnce = (
  c: { executionCtx: { waitUntil(p: Promise<unknown>): void } },
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  sessionId: string,
  req: Request,
): void => {
  if (stampedSessions.has(sessionId)) return;
  if (stampedSessions.size >= STAMPED_CAP) stampedSessions.clear();
  stampedSessions.add(sessionId);
  const p = stampSessionMeta(ctx, sessionId, req).catch(() => {});
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — the promise still runs to completion */
  }
};

// last_used_at feeds the "last used N ago" column in the API-keys panel —
// minute-level precision is plenty. Without a debounce every API-key request
// pays a DB write just to re-bump the timestamp; remember the last bump per
// key id per isolate and skip writes inside the window. Capped like
// stampedSessions so a long-lived isolate can't grow it without bound.
const lastUsedWrite = new Map<string, number>();
const LAST_USED_DEBOUNCE_MS = 5 * 60_000;
const LAST_USED_CAP = 10_000;

const touchLastUsedDebounced = (
  c: { executionCtx: { waitUntil(p: Promise<unknown>): void } },
  ctx: Parameters<typeof touchLastUsed>[0],
  keyId: string,
): void => {
  const now = Date.now();
  if (now - (lastUsedWrite.get(keyId) ?? 0) < LAST_USED_DEBOUNCE_MS) return;
  if (lastUsedWrite.size >= LAST_USED_CAP) lastUsedWrite.clear();
  lastUsedWrite.set(keyId, now);
  const p = touchLastUsed(ctx, keyId).catch(() => {});
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — the promise still runs to completion */
  }
};

/*
 * `loadUnfilteredRoleNames` used to live here: a union of role NAMES across
 * every workspace, with no tenant predicate, consulted by `tenantMiddleware`
 * to decide whether a non-member was "a super-admin who should pass through
 * anyway". It is deleted rather than left unused, because a helper that
 * answers "does this person hold the name `admin` ANYWHERE on the instance"
 * has no safe caller: `POST /api/tenants` hands that name to whoever asks.
 *
 * The question it was standing in for is "is this the instance operator", and
 * `services/roles/guards.ts::isInstanceOperator` is the function that actually
 * answers it — scoped to the default workspace, with an `OWNER_EMAIL` arm and
 * an explicit refusal for API keys.
 */

/** The address `$user.email` binds to. Exported because a queued job has to
 *  rebuild the same identity the request had, and a permission condition
 *  written against the email would otherwise silently match nothing. */
export const loadUserEmail = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  userId: string,
): Promise<string | null> => {
  const t = ctx.dialect === "pg" ? pg.schema.users : sqlite.schema.users;
  const rows = (await (ctx.db as any)
    .select({ email: t.email })
    .from(t)
    .where(eq(t.id, userId))
    .limit(1)) as { email: string }[];
  return rows[0]?.email ?? null;
};

/**
 * Look up a workspace end-user session by its bearer token. The token format
 * is exactly what better-auth's `bearer` plugin issues (the value of
 * `app_sessions.token`). Returns `null` for unknown / expired tokens — the
 * caller treats that as "no app session" and falls through.
 */
const findAppSession = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  token: string,
): Promise<{
  id: string;
  userId: string;
  tenantId: string;
  email: string | null;
} | null> => {
  const t =
    ctx.dialect === "pg"
      ? { sessions: pg.schema.appSessions, users: pg.schema.appUsers }
      : { sessions: sqlite.schema.appSessions, users: sqlite.schema.appUsers };
  const rows = (await (ctx.db as any)
    .select({
      id: t.sessions.id,
      userId: t.sessions.userId,
      tenantId: t.sessions.tenantId,
      expiresAt: t.sessions.expiresAt,
      email: t.users.email,
      status: t.users.status,
    })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
    .where(eq(t.sessions.token, token))
    .limit(1)) as Array<{
      id: string;
      userId: string;
      tenantId: string;
      expiresAt: Date | number;
      email: string | null;
      status: string;
    }>;
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "active") return null; // suspended end-users get no access
  const exp =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  if (exp <= Date.now()) return null;
  return {
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    email: row.email,
  };
};

/**
 * Is the session an app-plane ACCESS TOKEN names still live, and its owner
 * still active?
 *
 * `verifyAccessToken` performs zero database reads by design — it checks a
 * signature and some claims and returns. That is what makes the access token
 * cheap, and it is also why suspending an end-user did not suspend them:
 * `PATCH /api/app-users/{id}` deletes their `app_sessions` rows, which only
 * reaches the two credentials that DO hit the database, while the token the
 * SDK actually sends kept full read and write for the rest of its TTL. The
 * suspend handler's own docstring claimed the opposite ("existing tokens stop
 * working immediately"), and the same gap made sign-out advisory.
 *
 * So the token is now checked against the row it names. Every access token
 * carries `sid` — it is a required claim, not an optional one — so this needs
 * no fallback for older tokens and no fail-open arm.
 *
 * The cost is one indexed lookup, cached per isolate for the same 30s as every
 * other identity lookup on this path. That window is the ceiling on how long a
 * revoked token can still work on an isolate that had already seen it; the
 * isolate serving the suspend evicts immediately.
 *
 * EXPORTED for `routes/realtime.ts`, which re-asks it on the heartbeat of a
 * held SSE stream. It has to be this function and not a copy: the read path and
 * the stream disagreeing about whether a session is live is the same
 * two-paths-drift that `services/realtime-filter.ts` exists to prevent for
 * conditions. Note that `getCachedAppSessionLive` is NOT a substitute for a
 * long-lived stream — nothing repopulates that entry after the request
 * middleware's one call, and `invalidateAppSessions` DELETES rather than
 * setting `false`, so it cannot tell "not cached" from "live".
 */
export const appSessionLive = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  sessionId: string,
): Promise<boolean> => {
  const cached = getCachedAppSessionLive(sessionId);
  if (cached !== undefined) return cached;
  const t =
    ctx.dialect === "pg"
      ? { sessions: pg.schema.appSessions, users: pg.schema.appUsers }
      : { sessions: sqlite.schema.appSessions, users: sqlite.schema.appUsers };
  const rows = (await (ctx.db as any)
    .select({ status: t.users.status, expiresAt: t.sessions.expiresAt })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
    .where(eq(t.sessions.id, sessionId))
    .limit(1)) as Array<{ status: string; expiresAt: Date | number }>;
  const row = rows[0];
  // Deleted session, suspended owner, or a refresh row that has itself expired
  // all mean the same thing: the access token minted from it is spent. The
  // access token's own `exp` is shorter, so the last case is belt and braces.
  const exp = row
    ? row.expiresAt instanceof Date
      ? row.expiresAt.getTime()
      : Number(row.expiresAt)
    : 0;
  const live = Boolean(row) && row!.status === "active" && exp > Date.now();
  setCachedAppSessionLive(sessionId, live);
  return live;
};

/** Resolve an MCP OAuth access token (better-auth `mcp` plugin) to its user.
 *  One indexed lookup on the unique access_token column + a user join for the
 *  email. Enforces expiry — the plugin's own get-session lookup doesn't. */
const findOauthToken = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  token: string,
): Promise<{
  userId: string;
  email: string | null;
  clientId: string;
  scopes: string[];
} | null> => {
  const s = ctx.dialect === "pg" ? pg.schema : sqlite.schema;
  const t = s.oauthAccessTokens;
  const u = s.users;
  try {
    const rows = await (ctx.db as any)
      .select({
        userId: t.userId,
        clientId: t.clientId,
        scopes: t.scopes,
        expiresAt: t.accessTokenExpiresAt,
        email: u.email,
      })
      .from(t)
      .leftJoin(u, eq(t.userId, u.id))
      .where(eq(t.accessToken, token))
      .limit(1);
    const row = rows[0];
    if (!row?.userId) return null;
    const exp =
      row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
    return {
      userId: row.userId,
      email: row.email ?? null,
      clientId: row.clientId,
      scopes:
        typeof row.scopes === "string" ? row.scopes.split(" ").filter(Boolean) : [],
    };
  } catch {
    // Table missing (un-migrated deploy) or transient DB failure — treat the
    // token as unknown rather than 500ing the whole request.
    return null;
  }
};

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");

  let plane: "platform" | "app" = "platform";
  let userId: string | null = null;
  let email: string | null = null;
  // When a request authenticates with an API key, the key carries the tenant
  // it was issued for. Surface it so tenantMiddleware can pin the request to
  // that workspace — header/cookie/user-pref resolution would otherwise miss
  // it on machine-to-machine calls that don't send the X-Backlex-Tenant.
  let apiKeyTenantId: string | null = null;
  // A role-scoped key narrows the request to a single role (see api_keys.role_id).
  let apiKeyRoleId: string | null = null;
  // The key's id + MCP guard fields. The MCP dispatcher reads these to
  // filter `tools/list` and reject out-of-allowlist `tools/call`. For
  // session-based requests (no API key) they stay null/false and the MCP
  // surface enforces no extra restriction beyond permissions.
  let apiKeyId: string | null = null;
  let apiKeyMcpTools: string[] | null = null;
  let apiKeyMcpReadOnly = false;
  let apiKeyRateLimit: number | null = null;
  let apiKeyMonthlyQuota: number | null = null;
  // Workspace end-user sessions (`Authorization: Bearer <app-session-token>`)
  // similarly pin the request to the workspace that issued the session — the
  // app's frontend doesn't send a tenant header, it just uses its token.
  let appSessionTenantId: string | null = null;
  /** Set when the bearer token carries an `imp` claim AND the impersonation it
   *  names is still live — see services/impersonation.ts for why the row, not
   *  the token, is the authority. */
  let impersonatedBy: string | null = null;
  let impersonationId: string | null = null;
  let impersonationReadOnly = false;
  // `app_sessions.id` behind an app-plane request. Carried so the org layer can
  // read back the session's pinned `active_org_id` without a token lookup — the
  // stateless access JWT names it in `sid`, and both DB-backed paths know the
  // row they matched.
  let appSessionId: string | null = null;
  // MCP OAuth access tokens (better-auth `mcp` plugin — hosted Claude custom
  // connectors). Platform-plane: the token's userId is a control-plane user.
  let oauthClientId: string | null = null;

  // Cookie session resolution, with a per-isolate cache keyed on the signed
  // `*.session_token` cookie. better-auth's getSession costs ~2 D1 round-trips
  // and its own cookieCache only short-circuits on `/api/auth/*`, not here — so
  // without this cache every authenticated request paid the DB hit. See
  // services/permissions-cache `CachedSession` for the safety rationale (key is
  // the signed cookie; TTL < better-auth's 60s cookieCache).
  let sessionToken: string | undefined;
  // App-plane cookies are namespaced `wo_<tenantSlug>.session_token` (see
  // packages/auth/src/tenant.ts `advanced.cookiePrefix`). They must NOT be fed
  // to `ctx.auth` — that's the control-plane instance and will never recognise
  // one. Keep them aside and resolve them against `app_sessions` below.
  let appCookieToken: string | undefined;
  const cookies = getCookie(c);
  for (const name of Object.keys(cookies)) {
    if (!name.endsWith("session_token")) continue;
    // Over HTTPS better-auth emits the cookie as `__Secure-wo_<slug>.…`; over
    // plain HTTP (local dev) there is no prefix. Strip the RFC 6265bis prefixes
    // before deciding which plane the cookie belongs to — matching on the raw
    // name works in dev and silently fails in production, which is exactly how
    // this shipped broken once.
    const bare = name.replace(/^__(Secure|Host)-/, "");
    if (bare.startsWith("wo_")) {
      // better-auth signs cookies as `<value>.<signature>`. The value is the
      // same high-entropy `app_sessions.token` the bearer path accepts raw, and
      // it's verified by the DB lookup — so taking the value is no weaker than
      // the bearer path it mirrors.
      appCookieToken ??= cookies[name]?.split(".")[0];
      continue;
    }
    sessionToken ??= cookies[name];
  }
  const cached = sessionToken ? getCachedSession(sessionToken) : undefined;
  if (cached) {
    userId = cached.userId;
    email = cached.email;
    if (cached.sessionId) {
      stampOnce(c, { db: ctx.db, dialect: ctx.dialect }, cached.sessionId, c.req.raw);
    }
  } else {
    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user?.id) {
      userId = session.user.id;
      email = session.user.email ?? null;
      const sessId =
        (session as { session?: { id?: string } }).session?.id ?? null;
      if (sessId) {
        stampOnce(c, { db: ctx.db, dialect: ctx.dialect }, sessId, c.req.raw);
      }
      if (sessionToken) {
        setCachedSession(sessionToken, { userId, email, sessionId: sessId });
      }
    }
  }

  if (!userId) {
    const authHeader = c.req.raw.headers.get("authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer pak_")) {
      const raw = authHeader.slice("bearer ".length).trim();
      const key = await findApiKey(ctx, raw);
      if (key) {
        userId = key.userId;
        email = await loadUserEmail(ctx, key.userId);
        apiKeyTenantId = key.tenantId ?? null;
        apiKeyRoleId = key.roleId ?? null;
        apiKeyId = key.id;
        apiKeyMcpTools = key.mcpTools ?? null;
        apiKeyMcpReadOnly = Boolean(key.mcpReadOnly);
        apiKeyRateLimit = key.rateLimitPerMinute ?? null;
        apiKeyMonthlyQuota = key.monthlyQuota ?? null;
        // best-effort last-used bump, debounced to one write per key per 5 min
        touchLastUsedDebounced(c, ctx, key.id);
      }
    } else if (authHeader.toLowerCase().startsWith("bearer ")) {
      // Any non-`pak_` bearer is a workspace end-user token. Two accepted
      // shapes, tried in order:
      //   1. a stateless access JWT — verified with AUTH_SECRET, no DB hit;
      //   2. an opaque, DB-backed session token (the refresh token, also
      //      issued directly by SAML/LDAP and better-auth's bearer plugin).
      // Unknown tokens fall through → unauthenticated.
      const token = authHeader.slice("bearer ".length).trim();
      // 0. a detached agent-run token (see lib/jwt). Platform plane, minted by
      //    the agent worker for its own in-process sub-fetches and never handed
      //    to a client. It names the user the turn runs as; roles are NOT taken
      //    from the token — tenantMiddleware resolves them from the DB below,
      //    so a suspended user's in-flight turn loses access too.
      const runClaims = await verifyAgentRunToken(ctx.env.AUTH_SECRET, token);
      if (runClaims) {
        userId = runClaims.sub;
        email = await loadUserEmail(ctx, runClaims.sub);
      } else {
        const claims = await verifyAccessToken(ctx.env, token);
        // The signature says the token was ours; the session row says it still
        // is. Nothing is assigned when it fails, so the request stays
        // unauthenticated rather than falling through to the other token
        // shapes: this token verified as ours, and re-probing it against the
        // third-party issuers below would spend a network call per retry on a
        // credential we already know is spent.
        //
        // An IMPERSONATION token is exempt, and not as a concession: its `sid`
        // is the synthetic `imp:<row-id>` that `services/impersonation.ts`
        // mints, never an `app_sessions` id — an operator can act as a subject
        // who has never signed in, which is the point. Its liveness authority
        // is the impersonation row, re-read on every request a few lines
        // below, and that is a stricter guarantee than this one: ended,
        // expired or deleted all stop the token on the next call with no cache
        // window at all.
        const impersonating = claims !== null && typeof claims.imp === "string";
        const sessionStillLive =
          claims === null
            ? false
            : impersonating ||
              (await appSessionLive({ db: ctx.db, dialect: ctx.dialect }, claims.sid));
        if (claims && sessionStillLive) {
          const impId = typeof claims.imp === "string" ? claims.imp : null;
          if (impId) {
            // An impersonation token is only as valid as its row. Ended,
            // expired or deleted all mean the same thing here — the token
            // stops working, which is what makes "end this now" instant.
            const live = await resolveImpersonation(
              { db: ctx.db, dialect: ctx.dialect },
              impId,
            );
            if (!live || live.subjectUserId !== claims.sub || live.tenantId !== claims.tid) {
              // Nothing is assigned: the request stays unauthenticated. It also
              // does not fall through to the other token shapes — this branch
              // is inside `if (claims)`, so a token that verified as ours is
              // never re-probed against the third-party issuers below, which
              // would mean a network call per retry on a dead credential.
            } else {
              plane = "app";
              userId = claims.sub;
              email = claims.email;
              appSessionTenantId = claims.tid;
              appSessionId = claims.sid ?? null;
              impersonatedBy = live.actorUserId;
              impersonationId = live.id;
              impersonationReadOnly = Boolean(live.readOnly);
            }
          } else {
            plane = "app";
            userId = claims.sub;
            email = claims.email;
            appSessionTenantId = claims.tid;
            appSessionId = claims.sid ?? null;
          }
        } else if (claims) {
          // Verified as ours, but the session behind it is gone or its owner is
          // suspended. Deliberately assigns nothing and probes nothing further:
          // a revoked token must not get a second chance at the opaque-session
          // or third-party paths below.
        } else {
          const appSess = await findAppSession(
            { db: ctx.db, dialect: ctx.dialect },
            token,
          );
          if (appSess) {
            plane = "app";
            userId = appSess.userId;
            email = appSess.email;
            appSessionTenantId = appSess.tenantId;
            appSessionId = appSess.id;
          } else {
            // 3. an MCP OAuth access token (better-auth `mcp` plugin). Opaque
            //    random string, platform plane. The plugin's own get-session
            //    endpoint skips the expiry check, so it happens here. Tokens
            //    without the `mcp:write` scope run the MCP surface read-only
            //    (rides the same guard fields as read-only API keys).
            const oauthTok = await findOauthToken(ctx, token);
            if (oauthTok) {
              userId = oauthTok.userId;
              email = oauthTok.email;
              oauthClientId = oauthTok.clientId;
              apiKeyMcpReadOnly = !oauthTok.scopes.includes("mcp:write");
            } else {
              // 4. a JWT minted by a **third-party issuer** this instance has
              //    been told to trust (Clerk, Auth0, Firebase, Cognito,
              //    WorkOS). Last on purpose: it is the only probe that can
              //    reach out to the network, and every shape above is cheaper.
              //    The workspace comes from the token's `iss` — there is no
              //    session row and no tenant header to read it from.
              const identity = await verifyThirdPartyToken(
                { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
                token,
              );
              if (identity) {
                const resolved = await resolveThirdPartyUser(
                  { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
                  identity,
                  extractIp(c.req.raw) ?? undefined,
                );
                if (resolved) {
                  plane = "app";
                  userId = resolved.appUserId;
                  email = identity.email;
                  appSessionTenantId = resolved.tenantId;
                  // No `app_sessions` row backs this — the IdP owns the
                  // session. `appSessionId` stays null, so anything that
                  // revokes by session id simply has nothing to revoke here;
                  // revocation belongs to the issuer, and the short `exp` we
                  // require is what bounds it.
                }
              }
            }
          }
        }
      }
    }
  }

  // Workspace end-user session carried by its own cookie, resolved last so an
  // explicit `Authorization` header always wins.
  //
  // The app plane issues this cookie on every sign-in and the browser sends it
  // back, but until now nothing read it — so a request authenticated by cookie
  // alone got a 401 while the identical token as a bearer got a 200. That gap
  // is invisible to `fetch` callers (the SDK sends the bearer) and fatal to
  // `EventSource`, which cannot set headers at all: realtime was unreachable
  // for every workspace end-user browser app.
  //
  // Cross-origin caveat: the cookie is `SameSite=Lax`, so a browser won't send
  // it to a different site. Same-origin deploys and dev proxies work; a truly
  // cross-origin SPA still needs the bearer (and therefore still can't use
  // EventSource).
  if (!userId && appCookieToken) {
    const appSess = await findAppSession(
      { db: ctx.db, dialect: ctx.dialect },
      appCookieToken,
    );
    if (appSess) {
      plane = "app";
      userId = appSess.userId;
      email = appSess.email;
      appSessionTenantId = appSess.tenantId;
      appSessionId = appSess.id;
    }
  }

  // Roles aren't loaded here — tenantMiddleware will load them tenant-scoped a
  // moment later, and on the hot path (caller is already a member of the active
  // workspace) it never needs the unfiltered union. The lazy fallback inside
  // tenantMiddleware uses `loadUnfilteredRoleNames` only when membership fails,
  // so we save one D1 round-trip on every authenticated request.
  c.set("auth", {
    plane,
    userId,
    email,
    roles: [],
    apiKeyTenantId,
    apiKeyRoleId,
    apiKeyId,
    apiKeyMcpTools,
    apiKeyMcpReadOnly,
    apiKeyRateLimit,
    apiKeyMonthlyQuota,
    appSessionTenantId,
    appSessionId,
    oauthClientId,
    impersonatedBy,
    impersonationId,
    impersonationReadOnly,
  });
  await next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.userId)
    return c.json(
      {
        error: { code: "UNAUTHORIZED", message: "Sign in required" },
        requestId: c.get("requestId"),
      },
      401,
    );
  await next();
};
