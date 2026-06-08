import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z, OpenAPIHono } from "@hono/zod-openapi";
import type { Ctx } from "../context";
import { buildDynamicCollectionPaths } from "../services/openapi-dynamic";
import staticGenerated from "./openapi-static.generated.json";

/**
 * Re-export the extended `z` from `@hono/zod-openapi`. That package wraps
 * `@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi` and exposes a
 * pre-mutated `z` — every metadata file in this codebase imports `z` from
 * THIS module so the prototype is shared and `.openapi(...)` resolves.
 */
export { z };

/**
 * Global registry. Used by the (now-shrinking) population of `*.openapi.ts`
 * sibling files that still call `registerPath()` directly. Newer route files
 * declare schemas inline via `OpenAPIHono#openapi(createRoute({...}))` and
 * their definitions live in the sub-app's own `openAPIRegistry`. The
 * `buildOpenApiDoc` helper merges both worlds.
 */
export const apiRegistry = new OpenAPIRegistry();

apiRegistry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "better-auth.session_token",
  description:
    "Browser session cookie issued by better-auth. Sent automatically by the admin SPA.",
});

apiRegistry.registerComponent("securitySchemes", "apiKey", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "pak_<prefix>_<secret>",
  description:
    "Personal API key. Format: `pak_<8-hex>_<32-hex>`. Pass as `Authorization: Bearer <key>`.",
});

export const AppErrorSchema = apiRegistry.register(
  "AppError",
  z
    .object({
      error: z.object({
        code: z.string().openapi({ example: "UNAUTHORIZED" }),
        message: z.string().openapi({ example: "Sign in required" }),
        details: z.unknown().optional(),
      }),
    })
    .openapi({ description: "Uniform error envelope returned by every route." }),
);

// Plain `z.boolean()` rather than `z.literal(true)` so handlers can return
// `{ ok: true }` without TS narrowing the value to a `boolean` mismatch.
export const OkSchema = apiRegistry.register(
  "Ok",
  z.object({ ok: z.boolean() }),
);

export const PaginationMetaSchema = apiRegistry.register(
  "PaginationMeta",
  z.object({
    filter_count: z.number().int().nonnegative().optional(),
    total_count: z.number().int().nonnegative().optional(),
  }),
);

export const errorResponses = {
  400: {
    description: "Validation error or malformed payload.",
    content: { "application/json": { schema: AppErrorSchema } },
  },
  401: {
    description: "Authentication required.",
    content: { "application/json": { schema: AppErrorSchema } },
  },
  403: {
    description: "Authenticated but insufficient permissions.",
    content: { "application/json": { schema: AppErrorSchema } },
  },
  404: {
    description: "Resource not found.",
    content: { "application/json": { schema: AppErrorSchema } },
  },
  422: {
    description: "Semantic validation failure (Zod parse error).",
    content: { "application/json": { schema: AppErrorSchema } },
  },
} as const;

export const SECURITY: { [k: string]: string[] }[] = [
  { sessionCookie: [] },
  { apiKey: [] },
];

export const PUBLIC_SECURITY: { [k: string]: string[] }[] = [];

export const jsonBody = <S extends z.ZodTypeAny>(schema: S, description?: string) => ({
  content: { "application/json": { schema } },
  ...(description ? { description } : {}),
  required: true,
});

export const jsonResponse = <S extends z.ZodTypeAny>(
  schema: S,
  description: string,
) => ({
  description,
  content: { "application/json": { schema } },
});

export type BuildDocOptions = {
  baseUrl?: string;
  title?: string;
  version?: string;
  /** `[mountPath, openAPIHonoSubApp]` pairs. Each sub-app's
   *  `openAPIRegistry.definitions` are pulled and prefixed with the mount
   *  path so the full URL appears in the doc. */
  subApps?: ReadonlyArray<readonly [string, OpenAPIHono<any>]>;
};

/**
 * The static half of the spec — global registry + every sub-app's Zod schemas
 * run through `OpenApiGeneratorV31`. This is CPU-heavy (~34 generator passes,
 * ~5-6s on a Worker) and produces byte-identical output for every request: it
 * depends only on the module-level registries, not on the tenant, `baseUrl`,
 * or anything per-call.
 *
 * In production it is precomputed at build time (`scripts/gen-openapi-static.ts`
 * → `openapi-static.generated.json`, imported below) so NO generation happens
 * at runtime — critical on Cloudflare, where this rarely-hit admin route lands
 * on cold isolates whose in-memory cache is always empty. `buildStaticDoc` is
 * still used at runtime in dev (always fresh as routes change) and as a fallback
 * when the precomputed doc is absent/empty.
 *
 * `servers` is intentionally omitted here (it's the only request-varying field)
 * and injected per request. The result is treated as read-only — callers spread
 * it into a fresh doc rather than mutating it.
 */
let staticDocCache: ReturnType<OpenApiGeneratorV31["generateDocument"]> | null = null;

export const buildStaticDoc = (opts: BuildDocOptions) => {
  // Build the global registry's doc first. This catches the seed schemas
  // (AppError, Ok, PaginationMeta) + any remaining sibling metadata files.
  const globalGen = new OpenApiGeneratorV31(
    apiRegistry?.definitions ? [...apiRegistry.definitions] : [],
  );
  const baseDoc = globalGen.generateDocument({
    openapi: "3.1.0",
    info: {
      title: opts.title ?? "Backlex API",
      version: opts.version ?? "0.1.0",
      description:
        "REST surface for the backlex admin app and SDKs. Schema is generated from the live Zod validators; per-collection `/api/items/{slug}` paths are added from your workspace's collection metadata at request time.",
    },
    security: [{ sessionCookie: [] }, { apiKey: [] }],
  });

  // Then merge each sub-app's doc independently — a broken schema in one
  // sub-app shouldn't blow up the entire build. Failures are logged and
  // the offending mount is skipped.
  baseDoc.paths = baseDoc.paths ?? {};
  for (const [mount, sub] of opts.subApps ?? []) {
    const defs = sub?.openAPIRegistry?.definitions;
    if (!defs) {
      console.warn(`[openapi] sub-app at mount ${mount} has no openAPIRegistry — skipping`);
      continue;
    }
    try {
      const subGen = new OpenApiGeneratorV31(defs);
      const subDoc = subGen.generateDocument({
        openapi: "3.1.0",
        info: { title: "_inline", version: "0.0.0" },
      });
      if (subDoc.paths) {
        for (const [p, item] of Object.entries(subDoc.paths)) {
          const fullPath = mount + (p === "/" ? "" : p);
          (baseDoc.paths as any)[fullPath] = item;
        }
      }
      const subSchemas = (subDoc.components as any)?.schemas;
      if (subSchemas) {
        baseDoc.components = baseDoc.components ?? {};
        (baseDoc.components as any).schemas = {
          ...((baseDoc.components as any).schemas ?? {}),
          ...subSchemas,
        };
      }
    } catch (err) {
      console.warn(
        `[openapi] sub-app at ${mount} failed: ${(err as Error).message}`,
      );
    }
  }

  return baseDoc;
};

// Build-time precomputed static spec (see `scripts/gen-openapi-static.ts`).
// On a fresh checkout / in dev this is the `{ "paths": {} }` placeholder; the
// build script overwrites it with the full doc before bundling.
const precomputedHasPaths =
  Object.keys((staticGenerated as { paths?: Record<string, unknown> }).paths ?? {}).length > 0;
// Vite replaces `import.meta.env.DEV` at build (false in prod bundles); it's
// undefined on the non-Vite Bun entry → treated as prod. In dev we always
// regenerate so the spec tracks live route edits.
const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

export const buildOpenApiDoc = async (
  ctx: Ctx,
  tenantId: string | null,
  opts: BuildDocOptions = {},
) => {
  const dynamicPaths = tenantId
    ? await buildDynamicCollectionPaths(ctx, tenantId)
    : {};

  // Prefer the build-time precomputed doc (zero runtime generation). Fall back
  // to generating once per instance in dev or if the precompute is missing.
  let baseDoc: ReturnType<OpenApiGeneratorV31["generateDocument"]>;
  if (precomputedHasPaths && !isDev) {
    baseDoc = staticGenerated as unknown as typeof baseDoc;
  } else {
    if (!staticDocCache) staticDocCache = buildStaticDoc(opts);
    baseDoc = staticDocCache;
  }

  // Compose a fresh doc per request — never mutate the cached `baseDoc`.
  // `paths` gets a new object (static ∪ dynamic); path *items* are shared by
  // reference (read-only). `servers` is the only request-varying field.
  return {
    ...baseDoc,
    ...(opts.baseUrl ? { servers: [{ url: opts.baseUrl }] } : {}),
    paths: {
      ...(baseDoc.paths ?? {}),
      ...dynamicPaths,
    },
  } as typeof baseDoc;
};
