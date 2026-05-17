import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "panels";

const PanelInput = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    kind: z.enum(["sql", "items-aggregate", "static"]).default("sql"),
    sql: z.string().nullable().optional(),
    viz: z.enum(["sparkline", "bars", "donut", "counter", "table"]).default("sparkline"),
    config: z.record(z.unknown()).nullable().optional(),
    layout: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        w: z.number().int().positive(),
        h: z.number().int().positive(),
      })
      .nullable()
      .optional(),
  })
  .openapi("PanelInput");

const PanelRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.string(),
    sql: z.string().nullable(),
    viz: z.string(),
    config: z.unknown().nullable(),
    layout: z.unknown().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("Panel");

const PreviewInput = z
  .object({
    kind: z.enum(["sql", "items-aggregate"]),
    sql: z.string().optional(),
    config: z.unknown().optional(),
  })
  .openapi("PanelPreviewInput");

const PanelResult = z.object({
  data: z.array(z.record(z.unknown())),
  ms: z.number().int().nonnegative(),
  note: z.string().optional(),
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/panels",
  tags: [TAG],
  summary: "List panels",
  description: "Saved panels for the active workspace plus the system-global (`tenantId IS NULL`) ones.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(PanelRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/panels",
  tags: [TAG],
  summary: "Create panel",
  description: "SQL panels must contain a single read-only SELECT.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: PanelInput } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ data: PanelRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/admin/panels/{id}",
  tags: [TAG],
  summary: "Update panel",
  description: "Partial update.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: PanelInput.partial() } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/admin/panels/{id}",
  tags: [TAG],
  summary: "Delete panel",
  description: "Idempotent.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/panels/preview",
  tags: [TAG],
  summary: "Preview an unsaved panel",
  description: "Runs the panel without persisting. Same security gates as the saved-run endpoint.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: PreviewInput } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: PanelResult } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/panels/{id}/run",
  tags: [TAG],
  summary: "Run a saved panel",
  description: "Executes the saved query/aggregate config. Non-SQL panels return static config.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: PanelResult } } },
    ...errorResponses,
  },
});
