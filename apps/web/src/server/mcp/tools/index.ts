import type { McpTool } from "../types";
import { schemaTools } from "./schema";
import { schemaAdminTools } from "./schema-admin";
import { collectionsTools } from "./collections";
import { bulkTools } from "./bulk";
import { storageTools } from "./storage";
import { functionsTools } from "./functions";
import { vectorTools } from "./vector";
import { graphqlTools } from "./graphql";
import { permissionsTools } from "./permissions";
import { rolesTools } from "./roles";
import { apiKeysTools } from "./api-keys";
import { webhooksTools } from "./webhooks";
import { flowsTools } from "./flows";
import { notificationsTools } from "./notifications";
import { usersTools } from "./users";
import { dbTools } from "./db";
import { activityTools } from "./activity";
import { tenantsTools } from "./tenants";
import { appUsersTools } from "./app-users";
import { samlTools } from "./saml";
import { sharedLinksTools } from "./shared-links";
import { foldersTools } from "./folders";
import { revisionsTools } from "./revisions";
import { commentsTools } from "./comments";
import { embeddingTools } from "./embedding";
import { settingsTools } from "./settings";

/** The full tool roster. Both the `/mcp` and `/api/admin/mcp` mounts expose
 *  the same set — the mount gate is what differs (any-authenticated vs.
 *  admin-only). Tools that need higher privileges (functions.invoke,
 *  schema.create/update/drop, webhooks, flows, users.*, saml.*, db.*,
 *  settings.update) are enforced at the upstream HTTP endpoint, not at the
 *  MCP layer, so we don't double-gate here. The per-key MCP allowlist +
 *  read-only flags give callers another defense-in-depth axis on top. */
export const allTools: McpTool[] = [
  ...schemaTools,
  ...schemaAdminTools,
  ...collectionsTools,
  ...bulkTools,
  ...storageTools,
  ...vectorTools,
  ...graphqlTools,
  ...functionsTools,
  ...permissionsTools,
  ...rolesTools,
  ...apiKeysTools,
  ...webhooksTools,
  ...flowsTools,
  ...notificationsTools,
  ...usersTools,
  ...dbTools,
  ...activityTools,
  ...tenantsTools,
  ...appUsersTools,
  ...samlTools,
  ...sharedLinksTools,
  ...foldersTools,
  ...revisionsTools,
  ...commentsTools,
  ...embeddingTools,
  ...settingsTools,
];
