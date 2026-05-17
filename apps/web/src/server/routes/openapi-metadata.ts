/**
 * Lazy loader for every `*.openapi.ts` metadata file. Calling `loadMetadata()`
 * triggers each module's top-level `apiRegistry.registerPath(...)` so the
 * shared registry is populated before `buildOpenApiDoc` runs.
 *
 * The previous version did this as 34 static `import "./*.openapi"` statements
 * at module load. The Cloudflare vite-plugin's worker-runner blew up on the
 * resulting deep static-graph traversal — switching to dynamic `await import`
 * keeps the worker entry slim and only pays the cost on the openapi route.
 */
import { ensureZodExtended } from "../lib/openapi";

let loaded = false;

export const loadMetadata = async (): Promise<void> => {
  if (loaded) return;
  ensureZodExtended();
  await Promise.all([
    import("./api-keys.openapi"),
    import("./collections.openapi"),
    import("./items.openapi"),
    import("./storage.openapi"),
    import("./folders.openapi"),
    import("./roles.openapi"),
    import("./users.openapi"),
    import("./tenants.openapi"),
    import("./app-users.openapi"),
    import("./flows.openapi"),
    import("./functions.openapi"),
    import("./webhooks.openapi"),
    import("./comments.openapi"),
    import("./notifications.openapi"),
    import("./graphql.openapi"),
    import("./vector.openapi"),
    import("./realtime.openapi"),
    import("./activity.openapi"),
    import("./revisions.openapi"),
    import("./me.openapi"),
    import("./auth-public.openapi"),
    import("./email-templates.openapi"),
    import("./email-config.openapi"),
    import("./workspace-config.openapi"),
    import("./auth-admin.openapi"),
    import("./saml-admin.openapi"),
    import("./ldap-admin.openapi"),
    import("./adopt.openapi"),
    import("./panels.openapi"),
    import("./i18n.openapi"),
    import("./i18n-public.openapi"),
    import("./settings.openapi"),
    import("./db-admin.openapi"),
    import("./metrics.openapi"),
  ]);
  loaded = true;
};
