import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z, OpenAPIHono } from "@hono/zod-openapi";
import type { Ctx } from "../context";
import { buildDynamicCollectionPaths } from "../services/openapi-dynamic";

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

export const buildOpenApiDoc = async (
  ctx: Ctx,
  tenantId: string | null,
  opts: BuildDocOptions = {},
) => {
  const dynamicPaths = tenantId
    ? await buildDynamicCollectionPaths(ctx, tenantId)
    : {};

  // Combine the global registry (used by the few remaining legacy sibling
  // metadata files) with every OpenAPIHono sub-app's registry. Each sub-app
  // path gets its mount prefix so the doc shows the full URL.
  const combined = apiRegistry?.definitions ? [...apiRegistry.definitions] : [];
  for (const [mount, sub] of opts.subApps ?? []) {
    const defs = sub?.openAPIRegistry?.definitions;
    if (!defs) {
      console.warn(
        `[openapi] sub-app at mount ${mount} has no openAPIRegistry — skipping. sub=${typeof sub} keys=${
          sub ? Object.keys(sub).slice(0, 5).join(",") : "null"
        }`,
      );
      continue;
    }
    for (const def of defs) {
      if (def.type === "route") {
        const prefixed = mount + (def.route.path === "/" ? "" : def.route.path);
        combined.push({
          type: "route",
          route: { ...def.route, path: prefixed },
        });
      } else {
        combined.push(def);
      }
    }
  }

  const generator = new OpenApiGeneratorV31(combined);
  const baseDoc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: opts.title ?? "Workeros API",
      version: opts.version ?? "0.1.0",
      description:
        "REST surface for the workeros admin app and SDKs. Schema is generated from the live Zod validators; per-collection `/api/items/{slug}` paths are added from your workspace's collection metadata at request time.",
    },
    servers: opts.baseUrl ? [{ url: opts.baseUrl }] : undefined,
    security: [{ sessionCookie: [] }, { apiKey: [] }],
  });

  baseDoc.paths = {
    ...(baseDoc.paths ?? {}),
    ...dynamicPaths,
  } as typeof baseDoc.paths;
  return baseDoc;
};
