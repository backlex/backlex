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
let loaded = false;

export const loadMetadata = async (): Promise<void> => {
  if (loaded) return;
  await Promise.all([
    import("./graphql.openapi"),
    import("./i18n-public.openapi"),
  ]);
  loaded = true;
};
