import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
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
import { activityRoutes } from "./routes/activity";
import { revisionsRoutes } from "./routes/revisions";
import { authRoutes } from "./routes/auth";
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
import { tenantsRoutes } from "./routes/tenants";
import { emailTemplatesRoutes } from "./routes/email-templates";
import { authAdminRoutes } from "./routes/auth-admin";
import { panelsRoutes } from "./routes/panels";
import { i18nRoutes } from "./routes/i18n";
import { settingsRoutes } from "./routes/settings";
import { dbAdminRoutes } from "./routes/db-admin";
import { metricsRoutes } from "./routes/metrics";
import type { Env } from "./env";

export type AppBindings = {
  Variables: {
    ctx: Ctx;
    auth: {
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
    };
    permission: PermissionVar;
  };
};

let rolesSeeded = false;

export const createApp = (env: Env) => {
  const app = new Hono<AppBindings>();

  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: env.APP_URL,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    const ctx = buildContext(env);
    c.set("ctx", ctx);
    if (!rolesSeeded) {
      const dbCtx = { db: ctx.db, dialect: ctx.dialect };
      const defaultTenantId = await ensureDefaultTenant(dbCtx);
      await ensureSystemRoles(dbCtx, defaultTenantId);
      await seedOwnerScopedPermissions(dbCtx, defaultTenantId, FILES_COLLECTION);
      await seedEmailTemplates(dbCtx);
      rolesSeeded = true;
    }
    await next();
  });

  app.use("*", sessionMiddleware);
  app.use("*", tenantMiddleware);

  app.get("/health", (c) =>
    c.json({ ok: true, dialect: c.get("ctx").dialect, ts: Date.now() }),
  );

  app.route("/api/auth", authRoutes);
  app.route("/api/tenants", tenantsRoutes);
  app.route("/api/admin/email-templates", emailTemplatesRoutes);
  app.route("/api/admin/auth", authAdminRoutes);
  app.route("/api/admin/panels", panelsRoutes);
  app.route("/api/admin/i18n", i18nRoutes);
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
  app.route("/api/functions", functionsRoutes);
  app.route("/api/graphql", graphqlRoutes);
  app.route("/api/_internal/sandbox-rpc", sandboxRpcRoutes);

  app.onError(errorHandler);

  return app;
};
