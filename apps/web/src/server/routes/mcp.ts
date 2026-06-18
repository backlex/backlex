import { Hono, type MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { requireUser } from "../middleware/session";
import { handleMcpRequest } from "../mcp/http";
import { allTools } from "../mcp/tools";
import type { McpMode, McpServerWiring } from "../mcp/types";
import { rateLimitOk } from "../lib/rate-limit";

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const MCP_WINDOW_MS = 60_000;
const MCP_MAX_PER_MIN = 120;

const ipOf = (req: Request): string =>
  req.headers.get("cf-connecting-ip") ||
  req.headers.get("x-real-ip") ||
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  "unknown";

/** Per-identity (or per-IP) rate limit for the MCP mounts. The REST surface has
 *  its own limiter; without this a single authenticated key could drive
 *  unbounded `tools/call` volume, each fanning out to internal sub-fetches (and
 *  the `ai.*` / `graphql.execute` tools are expensive). Runs after auth so it
 *  buckets per key owner; falls back to IP. Fail-open if env is missing. */
const mcpRateLimit: MiddlewareHandler<AppBindings> = async (c, next) => {
  const env = (c.get("ctx") as { env?: Env } | undefined)?.env;
  if (env) {
    const id = c.get("auth")?.userId ?? ipOf(c.req.raw);
    if (!(await rateLimitOk(env, `mcp:${id}`, MCP_MAX_PER_MIN, MCP_WINDOW_MS))) {
      throw new AppError("RATE_LIMITED", "Too many MCP requests — slow down and retry shortly");
    }
  }
  await next();
};

const buildHandler = (app: Hono<AppBindings>, env: Env, mode: McpMode) => {
  const wiring: McpServerWiring = {
    app: app as unknown as Hono,
    env,
    mode,
    tools: allTools,
  };
  return async (c: Parameters<typeof handleMcpRequest>[0]) =>
    handleMcpRequest(c, wiring);
};

/** Tenant-scoped MCP: any authenticated identity. Cookie session, platform
 *  `pak_…` API key, or workspace end-user bearer token — all welcome.
 *  Permissions are enforced naturally by the per-tool sub-fetch hitting the
 *  same REST surface the admin UI uses. */
export const tenantMcpRoutes = (app: Hono<AppBindings>, env: Env) => {
  const handler = buildHandler(app, env, "tenant");
  return new Hono<AppBindings>()
    .post("/", requireUser, mcpRateLimit, handler)
    .all("/", (c) => handler(c));
};

/** Admin MCP: identity must carry the system `admin` role. That means a
 *  cookie session for an admin user, or a `pak_…` API key whose owner holds
 *  the admin role (and whose `roleId` scope, if set, must be the admin role).
 *  The mount exists so admin-only agents (CI bots, ops tooling) have a
 *  stable endpoint that 403s loudly on non-admin auth instead of silently
 *  returning empty results because of permission filters. */
export const adminMcpRoutes = (app: Hono<AppBindings>, env: Env) => {
  const handler = buildHandler(app, env, "admin");
  return new Hono<AppBindings>()
    .post("/", requireUser, requireAdmin, mcpRateLimit, handler)
    .all("/", (c) => handler(c));
};
