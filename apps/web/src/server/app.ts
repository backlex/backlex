import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { AuthPlane } from "@workeros/core";
import { createD1SessionClient } from "@workeros/db/sqlite";
import { buildContext, type Ctx } from "./context";
import { errorHandler } from "./middleware/error";
import { sessionMiddleware } from "./middleware/session";
import { tenantMiddleware } from "./middleware/tenant";
import type { PermissionVar } from "./middleware/permission";
import {
  ensureDefaultTenant,
  ensureSystemRoles,
  seedOwnerScopedPermissions,
  seedEmailTemplates,
} from "./services/seed";
import {
  isWorkspaceAllowedOrigin,
  refreshAllowedOriginsIfStale,
  warmAllowedOrigins,
} from "./services/cors-origins";
import { activityRoutes } from "./routes/activity";
import { revisionsRoutes } from "./routes/revisions";
import { authRoutes } from "./routes/auth";
import { authPublicRoutes } from "./routes/auth-public";
import { meRoutes } from "./routes/me";
import { tenantAuthRoutes } from "./routes/tenant-auth";
import { apiKeysRoutes } from "./routes/api-keys";
import { collectionsRoutes } from "./routes/collections";
import { foldersRoutes } from "./routes/folders";
import { itemsRoutes } from "./routes/items";
import { storageRoutes, FILES_COLLECTION } from "./routes/storage";
import { vectorRoutes } from "./routes/vector";
import { realtimeRoutes } from "./routes/realtime";
import { webhooksRoutes } from "./routes/webhooks";
import { webhookTriggerRoutes } from "./routes/webhook-trigger";
import { commentsRoutes } from "./routes/comments";
import { notificationsRoutes } from "./routes/notifications";
import { flowsRoutes } from "./routes/flows";
import { functionsRoutes } from "./routes/functions";
import { graphqlRoutes } from "./routes/graphql";
import { sandboxRpcRoutes } from "./routes/sandbox-rpc";
import {
  rolesRoutes,
  permissionsRoutes,
  usersRoutes,
} from "./routes/roles";
import { appUsersRoutes } from "./routes/app-users";
import { tenantsRoutes } from "./routes/tenants";
import { emailTemplatesRoutes } from "./routes/email-templates";
import { emailConfigRoutes } from "./routes/email-config";
import { workspaceConfigRoutes } from "./routes/workspace-config";
import { authAdminRoutes } from "./routes/auth-admin";
import { samlAdminRoutes } from "./routes/saml-admin";
import { ldapAdminRoutes } from "./routes/ldap-admin";
import { adoptRoutes } from "./routes/adopt";
import { panelsRoutes } from "./routes/panels";
import { i18nRoutes } from "./routes/i18n";
import { i18nPublicRoutes } from "./routes/i18n-public";
import { settingsRoutes } from "./routes/settings";
import { dbAdminRoutes } from "./routes/db-admin";
import { metricsRoutes } from "./routes/metrics";
import { openapiRoutes } from "./routes/openapi";
import type { Env } from "./env";

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
      /** Set by sessionMiddleware when the request authenticates with a
       *  workspace end-user bearer token (plane = "app"). The session row
       *  carries the issuing workspace; we pin the request to it so the
       *  customer's app never needs to send `X-Workeros-Tenant`. */
      appSessionTenantId?: string | null;
    };
    permission: PermissionVar;
  };
};

let rolesSeeded = false;

export const createApp = (env: Env) => {
  // Main app stays as plain Hono — `OpenAPIHono.route(...)` chains the tag
  // tree types of every sub-app together, which can blow past TS heap
  // limits in a large repo. The sub-apps that ARE `OpenAPIHono` still
  // expose their `openAPIRegistry`; `mountOpenapiRoutes` collects them
  // explicitly to build the doc.
  const app = new Hono<AppBindings>();

  app.use("*", logger());
  app.use("*", secureHeaders());

  // Build the per-request context *before* CORS so the CORS origin check can
  // read the active workspace set. `buildContext` is memoized per isolate
  // (createAuth + adapter setup happens once); the one-time role/seed bootstrap
  // is gated by a module flag.
  //
  // On D1 we open a per-request Sessions-API client so reads can hit the
  // nearest replica. The base Ctx (and the better-auth instance it carries)
  // stays bound to the original D1 binding — better-auth's own DB writes
  // always go through that and land on primary, while route handlers use the
  // session-bound `ctx.db` and benefit from replica routing.
  app.use("*", async (c, next) => {
    const baseCtx = buildContext(env);
    let ctx: Ctx = baseCtx;
    if (env.D1) {
      // `first-unconstrained` lets D1 pick the nearest replica for the first
      // read and pins the rest of the session to it with read-your-writes
      // consistency. Mutations always route to primary regardless of the
      // constraint, so this is safe even on write-mixed requests.
      ctx = { ...baseCtx, db: createD1SessionClient(env.D1, "first-unconstrained") };
    }
    c.set("ctx", ctx);
    if (!rolesSeeded) {
      const dbCtx = { db: ctx.db, dialect: ctx.dialect };
      const defaultTenantId = await ensureDefaultTenant(dbCtx);
      await ensureSystemRoles(dbCtx, defaultTenantId);
      await seedOwnerScopedPermissions(dbCtx, defaultTenantId, FILES_COLLECTION);
      await seedEmailTemplates(dbCtx);
      // Prime the cross-origin allow-list before the CORS middleware runs on
      // this same first request — otherwise the first cross-origin call after
      // a cold isolate start would miss the workspace redirect-URL origins.
      await warmAllowedOrigins(dbCtx);
      rolesSeeded = true;
    }
    await next();
  });

  app.use(
    "*",
    cors({
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
      allowHeaders: ["Content-Type", "Authorization", "X-Workeros-Tenant"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", sessionMiddleware);
  app.use("*", tenantMiddleware);

  app.get("/health", (c) =>
    c.json({ ok: true, dialect: c.get("ctx").dialect, ts: Date.now() }),
  );

  // Public auth-surface discovery — must be registered before the better-auth
  // catch-all (`/api/auth/*`) so it isn't shadowed by it.
  app.route("/api/auth", authPublicRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/api/me", meRoutes);
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
  app.route("/api/admin/adopt", adoptRoutes);
  app.route("/api/admin/panels", panelsRoutes);
  app.route("/api/admin/i18n", i18nRoutes);
  app.route("/api/i18n", i18nPublicRoutes);
  app.route("/api/admin/settings", settingsRoutes);
  app.route("/api/admin/db", dbAdminRoutes);
  app.route("/api/admin/metrics", metricsRoutes);
  app.route("/api/api-keys", apiKeysRoutes);
  app.route("/api/collections", collectionsRoutes);
  app.route("/api/items", itemsRoutes);
  app.route("/api/activity", activityRoutes);
  app.route("/api/revisions", revisionsRoutes);
  app.route("/api/storage", storageRoutes);
  app.route("/api/folders", foldersRoutes);
  app.route("/api/vector", vectorRoutes);
  app.route("/api/realtime", realtimeRoutes);
  app.route("/api/webhooks", webhooksRoutes);
  // Public flow-trigger endpoint — POST /api/webhook/:flowId fires the
  // matching `webhook`-triggered flow. Distinct path from /api/webhooks
  // (outgoing dispatch admin) by design.
  app.route("/api/webhook", webhookTriggerRoutes);
  app.route("/api/comments", commentsRoutes);
  app.route("/api/notifications", notificationsRoutes);
  app.route("/api/flows", flowsRoutes);
  app.route("/api/roles", rolesRoutes);
  app.route("/api/permissions", permissionsRoutes);
  app.route("/api/users", usersRoutes);
  app.route("/api/app-users", appUsersRoutes);
  app.route("/api/functions", functionsRoutes);
  app.route("/api/graphql", graphqlRoutes);
  app.route("/api", openapiRoutes);
  app.route("/api/_internal/sandbox-rpc", sandboxRpcRoutes);

  app.onError(errorHandler);

  return app;
};
