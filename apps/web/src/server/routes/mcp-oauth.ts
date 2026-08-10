/**
 * MCP OAuth glue around the better-auth `mcp` plugin (see packages/auth).
 *
 * The plugin owns the actual OAuth machinery under the better-auth basePath
 * (`/api/auth/mcp/authorize|token|register`, `/api/auth/oauth2/consent`).
 * This module adds the two pieces the plugin can't provide from inside that
 * mount:
 *
 * 1. **Root discovery documents.** RFC 8414 / RFC 9728 clients (the MCP SDK,
 *    claude.ai) fetch `/.well-known/oauth-authorization-server` and
 *    `/.well-known/oauth-protected-resource` from the ORIGIN ROOT — the
 *    plugin serves them under `/api/auth/...` where nothing looks. Path-
 *    suffixed variants are mounted too because clients that know the resource
 *    lives at `/mcp` (or the issuer at `/api/auth`) insert the well-known
 *    prefix before that path.
 *
 * 2. **Forced consent.** The plugin's authorize endpoint only shows a consent
 *    screen when the CLIENT sends `prompt=consent`; otherwise it mints the
 *    code immediately. Combined with open dynamic client registration that
 *    would let any registered client silently obtain a code from a signed-in
 *    admin's browser. The wrapper below intercepts GET /api/auth/mcp/authorize
 *    and 302s back with `prompt=consent` unless this user has already granted
 *    this client every requested scope (an `oauth_consents` row covers it).
 */
import { Hono, type MiddlewareHandler } from "hono";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../app";

/** Scope the plugin grants implicitly when a client omits `scope`. Mirrors
 *  the oidc-provider `defaultScope` ("openid"). */
const DEFAULT_SCOPE = "openid";

const wellKnownJson = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Public metadata — cacheable, and CORS-open so browser-based MCP
      // clients can read it (mirrors the plugin's own headers).
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });

/** Root-mounted OAuth discovery documents. Delegates to the better-auth
 *  endpoints so the payload always matches what the plugin serves. Mount at
 *  `/.well-known`. */
export const mcpOAuthWellKnownRoutes = () => {
  const router = new Hono<AppBindings>();
  const authServer: MiddlewareHandler<AppBindings> = async (c) => {
    const api = c.get("ctx").auth.api as unknown as {
      getMcpOAuthConfig: (i: object) => Promise<unknown>;
    };
    return wellKnownJson(await api.getMcpOAuthConfig({}));
  };
  const protectedResource: MiddlewareHandler<AppBindings> = async (c) => {
    const api = c.get("ctx").auth.api as unknown as {
      getMCPProtectedResource: (i: object) => Promise<unknown>;
    };
    return wellKnownJson(await api.getMCPProtectedResource({}));
  };
  // OIDC clients look for `openid-configuration`; OAuth 2.1 clients look for
  // `oauth-authorization-server`. The plugin is an OIDC provider underneath, so
  // both documents are the same one — and serving only the second meant a
  // library that speaks OIDC could not discover this server at all.
  router.get("/openid-configuration", authServer);
  router.get("/oauth-authorization-server", authServer);
  // Issuer-with-path variant (RFC 8414 §3.1): issuer is `<origin>/api/auth`.
  router.get("/oauth-authorization-server/api/auth", authServer);
  router.get("/oauth-protected-resource", protectedResource);
  // Resource-with-path variant (RFC 9728): the MCP endpoint lives at `/mcp`.
  router.get("/oauth-protected-resource/mcp", protectedResource);
  return router;
};

/** True when every requested scope is covered by a prior consent grant.
 *  Exported for unit tests. */
export const scopesCovered = (requested: string[], granted: string): boolean => {
  const have = new Set(granted.split(" ").filter(Boolean));
  return requested.every((s) => have.has(s));
};

/** Pre-catch-all interceptor for GET /api/auth/mcp/authorize (mount at
 *  `/api/auth` BEFORE the better-auth catch-all). Forces `prompt=consent`
 *  for clients the signed-in user hasn't already granted the requested
 *  scopes. Everything else — login redirects, PKCE validation, code minting —
 *  stays the plugin's job. */
export const mcpAuthorizeConsentGate = () => {
  const router = new Hono<AppBindings>();
  router.get("/mcp/authorize", async (c, next) => {
    const url = new URL(c.req.url);
    const q = url.searchParams;
    // Client already asked for the consent screen — nothing to enforce.
    if (q.get("prompt") === "consent") return next();
    const clientId = q.get("client_id");
    const auth = c.get("auth");
    // Unauthenticated: let the plugin redirect to the login page; the re-run
    // after sign-in passes through here again and gets the consent check.
    if (!clientId || !auth?.userId) return next();

    const ctx = c.get("ctx");
    const s = ctx.dialect === "pg" ? pg.schema : sqlite.schema;
    const t = s.oauthConsents;
    const requested = (q.get("scope") ?? DEFAULT_SCOPE).split(" ").filter(Boolean);
    let covered = false;
    try {
      const rows = (await (ctx.db as any)
        .select({ scopes: t.scopes, consentGiven: t.consentGiven })
        .from(t)
        .where(and(eq(t.clientId, clientId), eq(t.userId, auth.userId)))) as Array<{
        scopes: string | null;
        consentGiven: boolean | number;
      }>;
      covered = rows.some(
        (r) => Boolean(r.consentGiven) && scopesCovered(requested, r.scopes ?? ""),
      );
    } catch {
      // Un-migrated table / transient failure → fall through to forcing the
      // consent screen; never to silently authorizing.
    }
    if (covered) return next();
    q.set("prompt", "consent");
    return c.redirect(`${url.pathname}?${q.toString()}`, 302);
  });
  return router;
};
