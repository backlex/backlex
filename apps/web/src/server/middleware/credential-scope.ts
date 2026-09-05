/**
 * A credential is only good for the resource it was issued for.
 *
 * WHAT WAS WRONG
 *
 * `sessionMiddleware` resolves an MCP OAuth access token (better-auth `mcp`
 * plugin) into a full platform-plane identity and then reads its `scopes`
 * exactly once, to set `apiKeyMcpReadOnly`. That flag is consumed by
 * `mcp/guards.ts` and by nothing else, so the scope existed only inside the MCP
 * dispatcher. Measured against the real app: a token granted `openid mcp:read`
 * was refused `collections.insert` over `/mcp` and, in the same second, got
 * `201` from `POST /api/items/<slug>`, `201` from `POST /api/collections` and
 * `200` from `POST /api/admin/db/sql/run` — arbitrary SQL. One consent click on
 * an openly-registerable client (dynamic registration is deliberately open for
 * the MCP flow) was the whole precondition.
 *
 * WHY REFUSING IT OFF `/mcp` IS THE FIX, RATHER THAN A SURFACE-AGNOSTIC
 * `auth.readOnly`
 *
 * The server already says what this token is for. `packages/auth/src/index.ts`
 * passes `resource: <APP_URL>/mcp` to the plugin, which is the RFC 9728
 * protected-resource identifier a strict MCP client compares against the server
 * URL it was pointed at, and `/.well-known/oauth-protected-resource/mcp`
 * publishes it. The consent screen the user approves says "MCP connector". A
 * general API credential is `pak_…`, minted deliberately, revocable per key,
 * with its own tenant pin, role scoping, rate limit and quota — none of which
 * an OAuth grant carries. Promoting the read-only bit to `auth.readOnly` would
 * make the SCOPE mean something on REST while leaving the token itself a
 * full-blown read credential for every workspace the consenting user can reach,
 * which is a wider grant than anything the consent screen described.
 *
 * Nothing in the grant becomes decorative as a result: `mcp:write` still
 * decides writes at the resource (`mcp/guards.ts`), and `openid` / `profile` /
 * `email` / `offline_access` are consumed by better-auth's own OIDC endpoints
 * under `/api/auth/*`, which this gate deliberately does not touch. What DOES
 * change is that a grant carrying neither `mcp:read` nor `mcp:write` no longer
 * reaches the resource at all — previously such a token had full MCP read,
 * i.e. the advertised scopes were optional decoration on the way in.
 *
 * THE ONE PATH THAT IS NOT A MOUNT
 *
 * MCP tools do their work by sub-fetching this same Hono app
 * (`mcp/internal-fetch.ts`), forwarding the caller's `Authorization` header, so
 * a `tools/call` for `collections.insert` arrives here a second time as
 * `POST /api/items/<slug>`. A naive path check would refuse it and take the
 * whole MCP surface down for OAuth clients — the exact "the FIX text is the
 * least reliable part of a finding" trap. `isInternalRequest` answers that by
 * object identity on the `Request` we constructed, which no external caller can
 * forge, and the outer request was already checked by this gate before the
 * dispatcher ran.
 *
 * `/api/auth/*` is exempt for a different reason: it is the token's own ISSUER.
 * The plugin advertises `userinfo_endpoint: <baseURL>/mcp/userinfo`, which an
 * OIDC client calls with this very bearer, and refusing it would break the flow
 * that mints the token in the first place. Those handlers pass the raw request
 * to better-auth and never authorize on `c.get("auth")`.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { isInternalRequest } from "../mcp/internal-fetch";
import { isMcpMountPath } from "../mcp/mounts";

/** better-auth's own OAuth/OIDC surface, which issued the token and is its
 *  legitimate consumer (token, revocation, `mcp/userinfo`). */
const ISSUER_PREFIX = "/api/auth/";

/**
 * The discovery documents — JWKS, `oauth-authorization-server`,
 * `oauth-protected-resource` — served to anonymous callers by design
 * (`app.ts` exempts the prefix from CORS for the same reason).
 *
 * Exempt because refusing them buys nothing and costs a working client. They
 * carry no workspace data and answer without any credential at all, so a 403
 * here would protect a document you can already `curl`; meanwhile a client that
 * re-reads its metadata mid-session with the bearer still attached — an
 * ordinary thing for an OAuth client to do — would find the endpoint that
 * TELLS it which resource its token is for suddenly refusing the token.
 */
const WELL_KNOWN_PREFIX = "/.well-known/";

/** Scopes that name THIS resource. Mirrors `MCP_OAUTH_SCOPES` in
 *  `packages/auth` — kept as a local predicate rather than an import so the
 *  server bundle does not pull the auth package in for one string compare. */
const namesTheMcpResource = (scopes: readonly string[] | null | undefined): boolean =>
  Array.isArray(scopes) && scopes.some((s) => s === "mcp:read" || s === "mcp:write");

export const credentialScopeGate: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const auth = c.get("auth");
  // Every other credential shape — cookie session, `pak_` API key, app-plane
  // access token, third-party JWT — is unaffected. This gate has exactly one
  // subject.
  if (auth?.credential !== "mcp-oauth") return next();

  // A call the MCP dispatcher made on the caller's behalf. The outer `/mcp`
  // request already passed this gate and the tool guards.
  if (isInternalRequest(c.req.raw)) return next();

  const path = new URL(c.req.url).pathname;
  if (path === "/api/auth" || path.startsWith(ISSUER_PREFIX)) return next();
  if (path.startsWith(WELL_KNOWN_PREFIX)) return next();

  if (!isMcpMountPath(path)) {
    throw new AppError(
      "FORBIDDEN",
      "This access token is scoped to the MCP endpoint. Use an API key (`pak_…`) for the REST and GraphQL API.",
    );
  }

  if (!namesTheMcpResource(auth.oauthScopes)) {
    throw new AppError(
      "FORBIDDEN",
      "This access token was granted no `mcp:read` or `mcp:write` scope — re-authorize the client asking for one.",
    );
  }

  return next();
};
