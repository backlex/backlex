import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type { Ctx } from "../context";
import { buildDynamicCollectionPaths } from "../services/openapi-dynamic";

// Module-load-time extend: every metadata file imports `z` from this module,
// so the prototype is mutated exactly once and everyone shares it.
extendZodWithOpenApi(z);
export const ensureZodExtended = () => {};

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

export const OkSchema = apiRegistry.register(
  "Ok",
  z.object({ ok: z.literal(true) }),
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
};

export const buildOpenApiDoc = async (
  ctx: Ctx,
  tenantId: string | null,
  opts: BuildDocOptions = {},
) => {
  ensureZodExtended();
  const dynamicPaths = tenantId
    ? await buildDynamicCollectionPaths(ctx, tenantId)
    : {};

  const generator = new OpenApiGeneratorV31(apiRegistry.definitions);
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

export { z };
