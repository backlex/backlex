import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "workspace-config";

const nullableString = z.union([z.string(), z.null()]).optional();

const WorkspaceConfigPutInput = z
  .object({
    workspaceName: nullableString,
    description: nullableString,
    logoFileKey: nullableString,
    faviconFileKey: nullableString,
    primaryColor: z.union([z.string(), z.null()]).optional(),
    defaultTheme: z.union([z.enum(["light", "dark", "system"]), z.literal(""), z.null()]).optional(),
  })
  .openapi("WorkspaceConfigPutInput");

const WorkspaceConfigRaw = z
  .object({
    tenantId: z.string(),
    workspaceName: z.string().nullable(),
    description: z.string().nullable(),
    logoFileKey: z.string().nullable(),
    faviconFileKey: z.string().nullable(),
    primaryColor: z.string().nullable(),
    defaultTheme: z.string().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("WorkspaceConfigRaw");

const WorkspaceConfigResolved = z
  .object({
    workspaceName: z.string().nullable(),
    description: z.string().nullable(),
    logoUrl: z.string().nullable().optional(),
    faviconUrl: z.string().nullable().optional(),
    primaryColor: z.string().nullable(),
    defaultTheme: z.string().nullable(),
  })
  .passthrough()
  .openapi("WorkspaceConfigResolved");

apiRegistry.registerPath({
  method: "get",
  path: "/api/workspace-config",
  tags: [TAG],
  summary: "Resolved workspace branding",
  description: "Layered view (workspace row over `_global`). Public so the sign-in screen can read it.",
  security: [],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: WorkspaceConfigResolved }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/workspace-config/raw",
  tags: [TAG],
  summary: "Raw workspace-config row",
  description: "The workspace's own row, without falling back to `_global`. Admin-only.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: WorkspaceConfigRaw }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: "/api/workspace-config",
  tags: [TAG],
  summary: "Upsert workspace branding",
  description: "Empty string or null clears a field back to the design-system default.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: WorkspaceConfigPutInput } } } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/workspace-config/asset/{kind}",
  tags: [TAG],
  summary: "Stream a branding asset",
  description: "Streams the logo or favicon bytes from storage. Public (no auth) so it renders on the login screen.",
  security: [],
  request: {
    params: z.object({ kind: z.enum(["logo", "favicon"]) }),
  },
  responses: {
    200: {
      description: "Binary asset (PNG/SVG/ICO/etc).",
      content: { "application/octet-stream": { schema: z.string() } },
    },
    ...errorResponses,
  },
});
