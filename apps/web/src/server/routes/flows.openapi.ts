import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const FlowInput = z
  .object({
    name: z.string().min(1),
    trigger: z.string().min(1).openapi({
      description: "Trigger key (`event:items.created`, `cron`, `manual`, etc.).",
    }),
    operations: z.unknown().openapi({
      description: "Flow operations DAG. Validated server-side against OperationsSchema.",
    }),
    layout: z.unknown().optional().openapi({
      description: "Builder graph snapshot — purely presentational.",
    }),
    active: z.boolean().optional(),
  })
  .openapi("FlowInput");

const FlowRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    trigger: z.string(),
    operations: z.unknown(),
    layout: z.unknown().nullable().optional(),
    active: z.boolean(),
  })
  .openapi("FlowRow");


apiRegistry.registerPath({
  method: "get",
  path: "/api/flows",
  tags: ["flows"],
  summary: "List flows",
  description: "Admin-only. Lists every flow in the active workspace.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: z.array(FlowRow) }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/flows/{id}",
  tags: ["flows"],
  summary: "Get flow",
  description: "Admin-only. Fetches a single flow by id.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: FlowRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/flows",
  tags: ["flows"],
  summary: "Create flow",
  description: "Admin-only. Creates a flow scoped to the active workspace.",
  security: SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: FlowInput } } },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": { schema: z.object({ data: FlowRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/flows/{id}",
  tags: ["flows"],
  summary: "Update flow",
  description: "Admin-only. Partial update.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: FlowInput.partial() } },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: OkSchema } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/flows/{id}",
  tags: ["flows"],
  summary: "Delete flow",
  description: "Admin-only.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: OkSchema } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/flows/{id}/run",
  tags: ["flows"],
  summary: "Manually run flow",
  description:
    "Admin-only. Synchronously executes the flow with an arbitrary input payload. Records a `flow.run` activity row.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.record(z.unknown()).openapi({ description: "Arbitrary input payload." }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            error: z.string().optional(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});
