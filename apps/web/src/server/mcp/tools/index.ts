import type { McpTool } from "../types";
import { schemaTools } from "./schema";
import { schemaAdminTools } from "./schema-admin";
import { schemaVersionsTools } from "./schema-versions";
import { migrateTools } from "./migrate";
import { templatesTools } from "./templates";
import { collectionsTools } from "./collections";
import { bulkTools } from "./bulk";
import { itemsPublishTools } from "./items-publish";
import { featureFlagsTools } from "./feature-flags";
import { integrationsTools } from "./integrations";
import { syncHooksTools } from "./sync-hooks";
import { documentsTools } from "./documents";
import { geoTools } from "./geo";
import { emailTools } from "./email";
import { phoneTools } from "./phone";
import { approvalsTools } from "./approvals";
import { signaturesTools } from "./signatures";
import { bookingTools } from "./booking";
import { storageTools } from "./storage";
import { uploadsTools } from "./uploads";
import { functionsTools } from "./functions";
import { extensionsTools } from "./extensions";
import { vectorTools } from "./vector";
import { graphqlTools } from "./graphql";
import { permissionsTools } from "./permissions";
import { rolesTools } from "./roles";
import { apiKeysTools } from "./api-keys";
import { webhooksTools } from "./webhooks";
import { flowsTools } from "./flows";
import { paymentsTools } from "./payments";
import { dashboardsTools } from "./dashboards";
import { analyticsTools } from "./analytics";
import { formsTools } from "./forms";
import { usageTools } from "./usage";
import { advisorTools } from "./advisor";
import { backupsTools } from "./backups";
import { agentsTools } from "./agents";
import { jobsTools } from "./jobs";
import { notificationsTools } from "./notifications";
import { usersTools } from "./users";
import { dbTools } from "./db";
import { activityTools } from "./activity";
import { tenantsTools } from "./tenants";
import { appUsersTools } from "./app-users";
import { appOrgsTools } from "./app-orgs";
import { samlTools } from "./saml";
import { sharedLinksTools } from "./shared-links";
import { foldersTools } from "./folders";
import { revisionsTools } from "./revisions";
import { commentsTools } from "./comments";
import { embeddingTools } from "./embedding";
import { settingsTools } from "./settings";
import { aiTools } from "./ai";

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
  ...schemaVersionsTools,
  ...migrateTools,
  ...templatesTools,
  ...collectionsTools,
  ...bulkTools,
  ...itemsPublishTools,
  ...featureFlagsTools,
  ...integrationsTools,
  ...syncHooksTools,
  ...documentsTools,
  ...geoTools,
  ...phoneTools,
  ...emailTools,
  ...approvalsTools,
  ...signaturesTools,
  ...bookingTools,
  ...storageTools,
  ...uploadsTools,
  ...vectorTools,
  ...graphqlTools,
  ...functionsTools,
  ...extensionsTools,
  ...permissionsTools,
  ...rolesTools,
  ...apiKeysTools,
  ...webhooksTools,
  ...flowsTools,
  ...paymentsTools,
  ...dashboardsTools,
  ...analyticsTools,
  ...formsTools,
  ...usageTools,
  ...advisorTools,
  ...backupsTools,
  ...agentsTools,
  ...jobsTools,
  ...notificationsTools,
  ...usersTools,
  ...dbTools,
  ...activityTools,
  ...tenantsTools,
  ...appUsersTools,
  ...appOrgsTools,
  ...samlTools,
  ...sharedLinksTools,
  ...foldersTools,
  ...revisionsTools,
  ...commentsTools,
  ...embeddingTools,
  ...settingsTools,
  ...aiTools,
];
