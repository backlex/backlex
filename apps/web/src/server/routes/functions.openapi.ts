import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const FunctionInput = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
    trigger: z.enum(["http", "event", "cron"]),
    pattern: z.string().nullable().optional().openapi({
      description: "For `event`: dot-pattern (`items.*.created`). For `cron`: cron string.",
    }),
    code: z.string().min(1),
    timeoutMs: z.number().int().min(50).max(60_000).optional(),
    active: z.boolean().optional(),
  })
  .openapi("FunctionInput");

const FunctionRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    trigger: z.enum(["http", "event", "cron"]),
    pattern: z.string().nullable().optional(),
    code: z.string(),
    timeoutMs: z.number().int(),
    active: z.boolean(),
  })
  .openapi("FunctionRow");

const InvokeResult = z
  .object({
    ok: z.boolean(),
    logs: z.array(z.unknown()),
    error: z.string().optional(),
    durationMs: z.number().nonnegative(),
    result: z.unknown().optional(),
  })
  .openapi("FunctionInvokeResult");


apiRegistry.registerPath({
  method: "get",
  path: "/api/functions",
  tags: ["functions"],
  summary: "List functions",
  description: "Admin-only. Lists every function in the active workspace.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: z.array(FunctionRow) }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/functions",
  tags: ["functions"],
  summary: "Create function",
  description: "Admin-only.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: FunctionInput } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": { schema: z.object({ data: FunctionRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/functions/{id}",
  tags: ["functions"],
  summary: "Update function",
  description: "Admin-only. Partial update.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: FunctionInput.partial() } },
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
  path: "/api/functions/{id}",
  tags: ["functions"],
  summary: "Delete function",
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
  path: "/api/functions/{name}/invoke",
  tags: ["functions"],
  summary: "Invoke function",
  description:
    "Admin-only. Invokes an `http`-triggered function with the request body as input. Sandbox load failures surface as a 500 with the sandbox's error message.",
  security: SECURITY,
  request: {
    params: z.object({ name: z.string() }),
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.record(z.unknown()).openapi({ description: "Input passed to the function." }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Function ran successfully.",
      content: { "application/json": { schema: InvokeResult } },
    },
    500: {
      description: "Function returned an error.",
      content: { "application/json": { schema: InvokeResult } },
    },
    ...errorResponses,
  },
});
