import type { AuthPlane } from "@backlex/core";
import { createD1SessionClient } from "@backlex/db/sqlite";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { buildContext, type Ctx } from "./context";
import type { Env } from "./env";
import { authRateLimitMiddleware } from "./lib/auth-rate-limit";
import { errorHandler } from "./middleware/error";
import type { PermissionVar } from "./middleware/permission";
import { sessionMiddleware } from "./middleware/session";
import { tenantMiddleware } from "./middleware/tenant";
import { accountRoutes } from "./routes/account";
import { activityRoutes } from "./routes/activity";
import { adoptRoutes } from "./routes/adopt";
import { advisorRoutes } from "./routes/advisor";
import { aiAskRoutes } from "./routes/ai-ask";
import { apiKeysRoutes } from "./routes/api-keys";
import { appUsersRoutes } from "./routes/app-users";
import { authRoutes } from "./routes/auth";
import { authAdminRoutes } from "./routes/auth-admin";
import { authPublicRoutes } from "./routes/auth-public";
import { platformAuthRoutes } from "./routes/platform-auth";
import { collectionsRoutes } from "./routes/collections";
import { commentsRoutes } from "./routes/comments";
import { dbAdminRoutes } from "./routes/db-admin";
import { emailConfigRoutes } from "./routes/email-config";
import { emailTemplatesRoutes } from "./routes/email-templates";
import { flowsRoutes } from "./routes/flows";
import { foldersRoutes } from "./routes/folders";
import { functionsRoutes } from "./routes/functions";
import { i18nRoutes } from "./routes/i18n";
import { i18nPublicRoutes } from "./routes/i18n-public";
import { integrationsRoutes } from "./routes/integrations";
import { itemsRoutes } from "./routes/items";
import { ldapAdminRoutes } from "./routes/ldap-admin";
import { adminMcpRoutes, tenantMcpRoutes } from "./routes/mcp";
import { meRoutes } from "./routes/me";
import { metricsRoutes } from "./routes/metrics";
import { notificationsRoutes } from "./routes/notifications";
import { openapiRoutes } from "./routes/openapi";
import { panelsRoutes } from "./routes/panels";
import { realtimeRoutes } from "./routes/realtime";
import { realtimeAdminRoutes } from "./routes/realtime-admin";
import { revisionsRoutes } from "./routes/revisions";
import {
  permissionsRoutes,
  rolesRoutes,
  usersRoutes,
} from "./routes/roles";
import { samlAdminRoutes } from "./routes/saml-admin";
import { platformSamlAdminRoutes } from "./routes/platform-saml-admin";
import { platformLdapAdminRoutes } from "./routes/platform-ldap-admin";
import { sandboxRpcRoutes } from "./routes/sandbox-rpc";
import { settingsRoutes } from "./routes/settings";
import { sharedLinksRoutes } from "./routes/shared-links";
import { sharedPublicRoutes } from "./routes/shared-public";
import { FILES_COLLECTION, storageRoutes } from "./routes/storage";
import { templatesRoutes } from "./routes/templates";
import { tenantAuthRoutes } from "./routes/tenant-auth";
import { tenantsRoutes } from "./routes/tenants";
import { vectorRoutes } from "./routes/vector";
import { webhookTriggerRoutes } from "./routes/webhook-trigger";
import { webhooksRoutes } from "./routes/webhooks";
import { workspaceConfigRoutes } from "./routes/workspace-config";
import {
  isWorkspaceAllowedOrigin,
  refreshAllowedOriginsIfStale,
  warmAllowedOrigins,
} from "./services/cors-origins";
import type { PermResolveCache } from "./services/permissions";
import {
  ensureDefaultTenant,
  ensureSystemRoles,
  seedEmailTemplates,
  seedOwnerScopedPermissions,
} from "./services/seed";

export type AppBindings = {
  Variables: {
    ctx: Ctx;
    auth: {
      /** Which auth plane this identity belongs to — see {@link AuthPlane}.
       *  `"platform"` for admin-app / control-plane sessions and API keys;
       *  `"app"` for workspace end-users authenticated via a tenant's own
       *  auth service. Always `"platform"` until the tenant-auth surface
       *  ships. */
      plane: AuthPlane;
      userId: string | null;
      email: string | null;
      roles: string[];
      /** Resolved by tenantMiddleware. Null only on /api/auth and /health. */
      tenantId?: string | null;
      /** Set by sessionMiddleware when the request authenticates with a
       *  bearer API key — the key's home tenant wins over user.activeTenantId
       *  so machine-to-machine calls always land in the right workspace. */
      apiKeyTenantId?: string | null;
      /** Set by sessionMiddleware when the bearer API key is scoped to a
       *  single role. tenantMiddleware narrows `roles` to that role and the
       *  permission resolver evaluates against it alone. Null/absent = the
       *  key carries the owner's full role set. */
      apiKeyRoleId?: string | null;
      /** The PAK row id. Surfaced so MCP dispatcher / audit logging can
       *  attribute requests back to a specific key without re-querying. */
      apiKeyId?: string | null;
      /** Per-key MCP tool allowlist. `null` = unrestricted (all tools the
       *  server exposes are callable). `[]` = zero tools (deny everything).
       *  An array = only the listed tool names are callable. The MCP layer
       *  enforces this; REST routes ignore it. */
      apiKeyMcpTools?: string[] | null;
      /** When true, the MCP layer rejects every write tool for this key
       *  (insert / update / delete / grant / revoke / invoke / assign / etc.).
       *  REST routes are unaffected. */
      apiKeyMcpReadOnly?: boolean;
      /** Set by sessionMiddleware when the request authenticates with a
       *  workspace end-user bearer token (plane = "app"). The session row
       *  carries the issuing workspace; we pin the request to it so the
       *  customer's app never needs to send `X-Backlex-Tenant`. */
      appSessionTenantId?: string | null;
    };
    permission: PermissionVar;
    /** Per-request L1 permission cache. Lazily initialized by the first
     *  `requirePermission` (or any explicit `getRequestPermCache(c)` call)
     *  and reused by subsequent `resolvePermission` calls in the same
     *  request — GraphQL, expand, shared-links, etc. — so a single request
     *  never hits the same `(collection, action)` lookup twice. */
    permCache?: PermResolveCache;
    /** Per-request phase timings (ms), emitted as a `Server-Timing` response
     *  header. `_t0` is the worker-entry timestamp; other keys are durations.
     *  Used to attribute latency (dispatch vs ctx vs middleware vs route). */
    __st?: Record<string, number>;
  };
};

let rolesSeeded = false;

/** Wrap a middleware to record its OWN time (excluding the downstream `next()`
 *  it triggers) into the per-request Server-Timing collector under `name`.
 *  Diagnostic — lets us split `premw` into cors/session/tenant. */
const timed =
  (name: string, mw: MiddlewareHandler<AppBindings>): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    const st = c.get("__st");
    const start = performance.now();
    let downstream = 0;
    await mw(c, async () => {
      const d0 = performance.now();
      await next();
      downstream += performance.now() - d0;
    });
    if (st) st[name] = performance.now() - start - downstream;
  };

export const createApp = (env: Env) => {
  // Main app stays as plain Hono — `OpenAPIHono.route(...)` chains the tag
  // tree types of every sub-app together, which can blow past TS heap
  // limits in a large repo. The sub-apps that ARE `OpenAPIHono` still
  // expose their `openAPIRegistry`; `mountOpenapiRoutes` collects them
  // explicitly to build the doc.
  const app = new Hono<AppBindings>();

  // Per-request phase timing → `Server-Timing` response header. Gated behind a
  // secret header (`x-backlex-timing: $DEBUG_TIMING_SECRET`) so the diagnostic
  // is on-demand for ops (curl) and never publicly discloses internal phase
  // latencies. When off (default — no secret, or header mismatch) `__st` is
  // never set, so the `timed()` wrappers + ctx/d1 marks all no-op (`if (st)`)
  // and nothing is collected or emitted. `total` captures whole instance-worker
  // time; vs external ttfb + ICMP RTT it isolates dispatch (WfP) overhead.
  app.use("*", async (c, next) => {
    const on =
      !!env.DEBUG_TIMING_SECRET &&
      c.req.header("x-backlex-timing") === env.DEBUG_TIMING_SECRET;
    if (!on) {
      await next();
      return;
    }
    const t0 = performance.now();
    const st: Record<string, number> = { _t0: t0 };
    c.set("__st", st);
    await next();
    const total = performance.now() - t0;
    const parts = [`total;dur=${total.toFixed(1)}`];
    for (const k of ["ctx", "d1", "cors", "session", "tenant", "premw"]) {
      const v = st[k];
      if (v !== undefined) parts.push(`${k};dur=${v.toFixed(1)}`);
    }
    c.res.headers.set("Server-Timing", parts.join(", "));
  });

  app.use("*", logger());
  app.use("*", secureHeaders());

  // Build the per-request context *before* CORS so the CORS origin check can
  // read the active workspace set. `buildContext` is memoized per isolate
  // (createAuth + adapter setup happens once); the one-time role/seed bootstrap
  // is gated by a module flag.
  //
  // On D1 we open a per-request Sessions-API client so reads can hit the
  // nearest replica. The bookmark from the previous request (sent back on
  // `x-d1-bookmark`) is fed to `withSession` so cross-request read-your-writes
  // is preserved — see CF's "Use Sessions API" pattern. The base Ctx (and the
  // better-auth instance it carries) stays bound to the original D1 binding —
  // better-auth's own DB writes route to primary, while route handlers use
  // the session-bound `ctx.db` and get replica reads.
  app.use("*", async (c, next) => {
    const st = c.get("__st");
    const tc = performance.now();
    const baseCtx = await buildContext(env);
    if (st) st.ctx = performance.now() - tc;
    let ctx: Ctx = baseCtx;
    let session: { getBookmark: () => string | null } | null = null;
    if (env.D1) {
      // Read the prior bookmark (if any); fall back to `first-unconstrained`
      // so CF picks the nearest replica when no anchor is provided. Mutations
      // always route to primary regardless of the constraint.
      const constraint = c.req.header("x-d1-bookmark") ?? "first-unconstrained";
      const td = performance.now();
      const s = createD1SessionClient(env.D1, constraint);
      if (st) st.d1 = performance.now() - td;
      session = s;
      ctx = { ...baseCtx, db: s.db };
    }
    c.set("ctx", ctx);
    if (!rolesSeeded) {
      // Set optimistically so a burst of concurrent first-requests on a cold
      // isolate doesn't each run the bootstrap.
      rolesSeeded = true;
      const dbCtx = { db: ctx.db, dialect: ctx.dialect };
      // Prime the cross-origin allow-list before the CORS middleware runs on
      // this same first request — otherwise the first cross-origin call after
      // a cold isolate start would miss the workspace redirect-URL origins.
      // One cheap SELECT; stays on the critical path.
      await warmAllowedOrigins(dbCtx);
      // The rest is idempotent bootstrap seeding. On an already-provisioned
      // instance (every cold isolate after the first ever) it's ~11 no-op
      // SELECTs that needlessly blocked the first request ~110ms — traced on a
      // cold /api/collections. Defer it off the critical path; `waitUntil` keeps
      // the isolate alive until it finishes. The genuine first-user bootstrap is
      // also performed in context.ts, so deferring here is safe. Tests / runtimes
      // without an ExecutionContext fall back to awaiting inline (deterministic).
      const seed = async () => {
        const defaultTenantId = await ensureDefaultTenant(dbCtx);
        await ensureSystemRoles(dbCtx, defaultTenantId);
        await seedOwnerScopedPermissions(dbCtx, defaultTenantId, FILES_COLLECTION);
        await seedEmailTemplates(dbCtx);
      };
      let ec: ExecutionContext | undefined;
      try {
        ec = c.executionCtx;
      } catch {
        ec = undefined;
      }
      if (ec) {
        ec.waitUntil(seed().catch(() => {}));
        // Pre-warm the lazily-chunked GraphQL handler in the background, once per
        // cold isolate. GraphQL is a first-class data API here — a customer app
        // may use it exclusively — so we don't want its 452K chunk parsed inside
        // the first /api/graphql request (a p99 spike on every cold isolate).
        // Parsing it off the critical path keeps cold-start lean AND has the
        // module cached before real query load arrives. No-op if already loaded.
        ec.waitUntil(import("./routes/graphql").catch(() => {}));
      } else await seed();
    }
    await next();
    // Stamp the latest bookmark on the way out so the client can round-trip
    // it on the next request. `c.res.headers.set` merges into the final
    // response — downstream handlers can't clobber it (we run after next()).
    if (session) {
      const bm = session.getBookmark();
      if (bm) c.res.headers.set("x-d1-bookmark", bm);
    }
  });

  app.use(
    "*",
    timed("cors", cors({
      // Allow `APP_URL` always; allow any origin in `EXTRA_TRUSTED_ORIGINS`
      // or derived from a workspace's `auth_config.redirectUrls` (so a
      // customer's app on a different domain can call its workspace's auth
      // surface + the data API with credentials). Anything else gets a
      // non-matching ACAO header → blocked by the browser.
      origin: (origin, c) => {
        if (!origin || origin === env.APP_URL) return env.APP_URL;
        const ctx = c.get("ctx");
        if (ctx) refreshAllowedOriginsIfStale({ db: ctx.db, dialect: ctx.dialect });
        return isWorkspaceAllowedOrigin(origin, env) ? origin : env.APP_URL;
      },
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-Backlex-Tenant", "X-D1-Bookmark"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      // Expose so the browser SPA can read the bookmark off the response and
      // round-trip it on the next request (D1 Sessions API). Server-Timing is
      // NOT exposed — it's an ops-only, secret-gated diagnostic.
      exposeHeaders: ["X-D1-Bookmark"],
    }),
  ),
  );

  app.use("*", timed("session", sessionMiddleware));
  app.use("*", timed("tenant", tenantMiddleware));

  // Mark when all pre-route middleware (ctx + CORS + session + tenant) is done,
  // so `premw` vs `route` (= total − premw) can be split in Server-Timing.
  app.use("*", async (c, next) => {
    const st = c.get("__st");
    const t0 = st?._t0;
    if (st && t0 !== undefined) st.premw = performance.now() - t0;
    await next();
  });

  // `version` is the worker-template version baked in at build time (see
  // vite.config `define`). Lets the cloud control-plane + ops verify which
  // template a live instance is actually running without guessing. The `typeof`
  // guard keeps it safe under runtimes that don't apply Vite `define` (bun test,
  // bun self-host) — there it reports "dev" instead of throwing on the global.
  const templateVersion =
    typeof __TEMPLATE_VERSION__ !== "undefined" ? __TEMPLATE_VERSION__ : "dev";
  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: templateVersion,
      dialect: c.get("ctx").dialect,
      ts: Date.now(),
    }),
  );

  // Per-IP rate limit on the sensitive auth subpaths (sign-in, sign-up,
  // password reset, magic link, OTP, 2FA). Sits in front of both the
  // control-plane better-auth router and the workspace end-user tenant-auth
  // router so credential-stuffing and reset-spam are blunted before they
  // ever reach the auth handler. GETs and other read-only OAuth flows
  // pass through untouched (see lib/auth-rate-limit.ts).
  app.use("/api/auth/*", authRateLimitMiddleware);
  app.use("/api/t/*", authRateLimitMiddleware);

  // Public auth-surface discovery — must be registered before the better-auth
  // catch-all (`/api/auth/*`) so it isn't shadowed by it.
  app.route("/api/auth", authPublicRoutes);
  // Control-plane SSO (SAML ACS/metadata/slo, LDAP sign-in) — must precede the
  // better-auth catch-all so `/api/auth/saml/*` and `/api/auth/ldap/*` win.
  app.route("/api/auth", platformAuthRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/account", accountRoutes);
  // Workspace end-user auth (the "auth as a service" surface) — each tenant
  // gets its own better-auth instance under /api/t/<slug>/auth/*, backed by
  // the app_* tables and the tenant-scoped adapter wrapper.
  app.route("/api/t", tenantAuthRoutes);
  app.route("/api/tenants", tenantsRoutes);
  app.route("/api/admin/email-templates", emailTemplatesRoutes);
  app.route("/api/admin/email-config", emailConfigRoutes);
  app.route("/api/workspace-config", workspaceConfigRoutes);
  app.route("/api/admin/auth", authAdminRoutes);
  app.route("/api/admin/saml", samlAdminRoutes);
  app.route("/api/admin/ldap-config", ldapAdminRoutes);
  app.route("/api/admin/platform-saml", platformSamlAdminRoutes);
  app.route("/api/admin/platform-ldap-config", platformLdapAdminRoutes);
  app.route("/api/admin/adopt", adoptRoutes);
  app.route("/api/admin/panels", panelsRoutes);
  app.route("/api/admin/i18n", i18nRoutes);
  app.route("/api/i18n", i18nPublicRoutes);
  app.route("/api/admin/settings", settingsRoutes);
  app.route("/api/admin/db", dbAdminRoutes);
  app.route("/api/admin/metrics", metricsRoutes);
  app.route("/api/admin/realtime", realtimeAdminRoutes);
  app.route("/api/admin/advisor", advisorRoutes);
  app.route("/api/api-keys", apiKeysRoutes);
  app.route("/api/collections", collectionsRoutes);
  app.route("/api/admin/templates", templatesRoutes);
  app.route("/api/items", itemsRoutes);
  app.route("/api/activity", activityRoutes);
  app.route("/api/revisions", revisionsRoutes);
  app.route("/api/storage", storageRoutes);
  app.route("/api/folders", foldersRoutes);
  app.route("/api/vector", vectorRoutes);
  app.route("/api/realtime", realtimeRoutes);
  app.route("/api/webhooks", webhooksRoutes);
  app.route("/api/admin/integrations", integrationsRoutes);
  // Public flow-trigger endpoint — POST /api/webhook/:flowId fires the
  // matching `webhook`-triggered flow. Distinct path from /api/webhooks
  // (outgoing dispatch admin) by design.
  app.route("/api/webhook", webhookTriggerRoutes);
  app.route("/api/comments", commentsRoutes);
  app.route("/api/shared-links", sharedLinksRoutes);
  // Public, unauthenticated record-share resolution — no `requireUser`.
  app.route("/api/shared", sharedPublicRoutes);
  app.route("/api/notifications", notificationsRoutes);
  app.route("/api/flows", flowsRoutes);
  app.route("/api/roles", rolesRoutes);
  app.route("/api/permissions", permissionsRoutes);
  app.route("/api/users", usersRoutes);
  app.route("/api/app-users", appUsersRoutes);
  app.route("/api/functions", functionsRoutes);
  // Lazy: the GraphQL subsystem (graphql-yoga + graphql + @graphql-tools) is a
  // large slice of the bundle that most requests never touch. Dynamic-import it
  // on first hit so it stays out of the worker's cold-start eval path.
  app.all("/api/graphql", (c) =>
    import("./routes/graphql").then((m) => m.handleGraphql(c)),
  );
  app.route("/api", openapiRoutes);
  app.route("/api/_internal/sandbox-rpc", sandboxRpcRoutes);
  // MCP (Model Context Protocol) — must mount after the routes its tools
  // sub-fetch into, since the route factories capture the same `app`
  // reference to issue in-process requests against the existing REST
  // surface. Two mounts: `/mcp` is open to any authenticated identity
  // (permissions are enforced by the per-tool sub-fetch); `/api/admin/mcp`
  // additionally requires the system `admin` role.
  app.route("/mcp", tenantMcpRoutes(app, env));
  app.route("/api/admin/mcp", adminMcpRoutes(app, env));
  // Admin "Ask AI" page — splits the design's `planForPrompt` mock into
  // /plan (Claude → tool + args) and /run (executes one MCP tool, logs to
  // the activity table). Mounted after MCP because /run reuses the same
  // tool roster via in-process sub-fetches against this same Hono app.
  app.route("/api/admin/ai", aiAskRoutes(app, env));

  app.onError(errorHandler);

  return app;
};
