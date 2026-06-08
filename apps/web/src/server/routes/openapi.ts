import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { buildOpenApiDoc } from "../lib/openapi";
import { loadMetadata } from "./openapi-metadata";

// Each of these is an `OpenAPIHono` sub-app — its `openAPIRegistry` holds
// the `registerPath` entries declared via `.openapi(createRoute(...))`.
// We pair each with its mount prefix so we can compose the full path.
import { apiKeysRoutes } from "./api-keys";
import { collectionsRoutes } from "./collections";
import { foldersRoutes } from "./folders";
import { itemsRoutes } from "./items";
import { storageRoutes } from "./storage";
import { vectorRoutes } from "./vector";
import { realtimeRoutes } from "./realtime";
import { webhooksRoutes } from "./webhooks";
import { commentsRoutes } from "./comments";
import { notificationsRoutes } from "./notifications";
import { flowsRoutes } from "./flows";
import { functionsRoutes } from "./functions";
import {
  rolesRoutes,
  permissionsRoutes,
  usersRoutes,
} from "./roles";
import { appUsersRoutes } from "./app-users";
import { tenantsRoutes } from "./tenants";
import { emailTemplatesRoutes } from "./email-templates";
import { emailConfigRoutes } from "./email-config";
import { workspaceConfigRoutes } from "./workspace-config";
import { authAdminRoutes } from "./auth-admin";
import { samlAdminRoutes } from "./saml-admin";
import { ldapAdminRoutes } from "./ldap-admin";
import { adoptRoutes } from "./adopt";
import { panelsRoutes } from "./panels";
import { i18nRoutes } from "./i18n";
import { settingsRoutes } from "./settings";
import { dbAdminRoutes } from "./db-admin";
import { metricsRoutes } from "./metrics";
import { authPublicRoutes } from "./auth-public";
import { activityRoutes } from "./activity";
import { revisionsRoutes } from "./revisions";
import { meRoutes } from "./me";
import { accountRoutes } from "./account";

// `any` on purpose — `OpenAPIHono<AppBindings>` for each sub-app blows
// past TypeScript's inference budget on this many entries. Only the
// runtime `openAPIRegistry.definitions` walk needs to work.
const SUBAPPS: ReadonlyArray<readonly [string, OpenAPIHono<any>]> = [
  ["/api/api-keys", apiKeysRoutes as unknown as OpenAPIHono<any>],
  ["/api/collections", collectionsRoutes as unknown as OpenAPIHono<any>],
  ["/api/folders", foldersRoutes as unknown as OpenAPIHono<any>],
  ["/api/items", itemsRoutes as unknown as OpenAPIHono<any>],
  ["/api/storage", storageRoutes as unknown as OpenAPIHono<any>],
  ["/api/vector", vectorRoutes as unknown as OpenAPIHono<any>],
  ["/api/realtime", realtimeRoutes as unknown as OpenAPIHono<any>],
  ["/api/webhooks", webhooksRoutes as unknown as OpenAPIHono<any>],
  ["/api/comments", commentsRoutes as unknown as OpenAPIHono<any>],
  ["/api/notifications", notificationsRoutes as unknown as OpenAPIHono<any>],
  ["/api/flows", flowsRoutes as unknown as OpenAPIHono<any>],
  ["/api/functions", functionsRoutes as unknown as OpenAPIHono<any>],
  ["/api/roles", rolesRoutes as unknown as OpenAPIHono<any>],
  ["/api/permissions", permissionsRoutes as unknown as OpenAPIHono<any>],
  ["/api/users", usersRoutes as unknown as OpenAPIHono<any>],
  ["/api/app-users", appUsersRoutes as unknown as OpenAPIHono<any>],
  ["/api/tenants", tenantsRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/email-templates", emailTemplatesRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/email-config", emailConfigRoutes as unknown as OpenAPIHono<any>],
  ["/api/workspace-config", workspaceConfigRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/auth", authAdminRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/saml", samlAdminRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/ldap-config", ldapAdminRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/adopt", adoptRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/panels", panelsRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/i18n", i18nRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/settings", settingsRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/db", dbAdminRoutes as unknown as OpenAPIHono<any>],
  ["/api/admin/metrics", metricsRoutes as unknown as OpenAPIHono<any>],
  ["/api/auth", authPublicRoutes as unknown as OpenAPIHono<any>],
  ["/api/activity", activityRoutes as unknown as OpenAPIHono<any>],
  ["/api/revisions", revisionsRoutes as unknown as OpenAPIHono<any>],
  ["/api/me", meRoutes as unknown as OpenAPIHono<any>],
  ["/api/account", accountRoutes as unknown as OpenAPIHono<any>],
];

const requireAdmin = (roles: string[]) => {
  if (!roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const baseUrlFor = (req: Request): string => {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
};

const docFor = async (c: { req: { raw: Request }; get: (k: "ctx") => any }, tenantId: string | null) => {
  await loadMetadata();
  return buildOpenApiDoc(c.get("ctx"), tenantId, {
    baseUrl: baseUrlFor(c.req.raw),
    subApps: SUBAPPS,
  });
};

export const openapiRoutes = new Hono<AppBindings>()
  .get("/openapi.json", requireUser, async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth.roles);
    const doc = await docFor(c, auth.tenantId ?? null);
    // No browser caching: the dynamic `/api/items/{slug}` paths must reflect a
    // just-created collection immediately (the Collections page deep-links here
    // with `?slug=` right after create). Server-side memoization already makes
    // regeneration cheap, so revalidating on every request costs little.
    c.header("Cache-Control", "no-store");
    return c.json(doc);
  })
  .get("/openapi.yaml", requireUser, async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth.roles);
    const doc = await docFor(c, auth.tenantId ?? null);
    // Dynamic-import `yaml` so it stays out of the worker's cold-start eval —
    // only this on-demand spec endpoint needs it (see vite.config manualChunks).
    const { stringify: yamlStringify } = await import("yaml");
    return new Response(yamlStringify(doc), {
      headers: { "content-type": "application/yaml; charset=utf-8" },
    });
  });
