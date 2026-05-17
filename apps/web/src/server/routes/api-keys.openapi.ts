import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const ApiKeyInput = z
  .object({
    name: z.string().min(1).max(120).optional().openapi({
      description: "Human-readable label. A timestamped default is generated when omitted.",
      example: "Production GitHub Action",
    }),
    userId: z.string().optional().openapi({
      description: "Admin-only — issue a key on behalf of another user.",
    }),
    roleId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .openapi({
        description:
          "Optional. Scope the key to a single role the owner currently holds. Omit/null = inherit the owner's full role set.",
      }),
    expiresAt: z.string().datetime().optional().openapi({
      description: "ISO-8601 UTC. Must be in the future. Omit for non-expiring keys.",
      example: "2026-12-31T23:59:59Z",
    }),
  })
  .openapi("ApiKeyInput");

const ApiKeyRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    prefix: z.string().openapi({ description: "First 8 hex chars of the secret key." }),
    name: z.string(),
    userId: z.string(),
    roleId: z.string().nullable(),
    roleName: z.string().nullable(),
    expiresAt: z.unknown().nullable(),
    lastUsedAt: z.unknown().nullable(),
    revokedAt: z.unknown().nullable(),
    createdAt: z.unknown().nullable(),
  })
  .openapi("ApiKeyRow");

const ApiKeyCreatedRow = ApiKeyRow.extend({
  secret: z.string().openapi({
    description:
      "Full plaintext key (`pak_<prefix>_<secret>`). Returned exactly once — store it now.",
    example: "pak_a1b2c3d4_..." as const,
  }),
}).openapi("ApiKeyCreatedRow");

const RoleRow = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
  })
  .openapi("RoleRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/api-keys",
  tags: ["api-keys"],
  summary: "List API keys",
  description:
    "Returns the caller's keys. Admins see every key in the active workspace; non-admins see only their own.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(ApiKeyRow) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/api-keys/available-roles",
  tags: ["api-keys"],
  summary: "List bindable roles",
  description:
    "Roles the caller may attach to a new key. Admins: every workspace role. Non-admins: only roles they hold.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: z.array(RoleRow) }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/api-keys",
  tags: ["api-keys"],
  summary: "Create API key",
  description:
    "Issues a new personal API key. The plaintext secret is returned once in the response body and never again.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ApiKeyInput } },
    },
  },
  responses: {
    201: {
      description: "Created — `data.secret` is the only chance to record the key.",
      content: {
        "application/json": {
          schema: z.object({
            data: ApiKeyCreatedRow,
            warning: z.string(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/api-keys/{id}",
  tags: ["api-keys"],
  summary: "Revoke API key",
  description: "Marks the key as revoked. Idempotent — a missing/foreign key returns 404.",
  security: SECURITY,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Key id (NOT the prefix or secret)." }),
    }),
  },
  responses: {
    200: {
      description: "Revoked",
      content: { "application/json": { schema: OkSchema } },
    },
    ...errorResponses,
  },
});

export const _ApiKeyInput = ApiKeyInput;
export const _ApiKeyRow = ApiKeyRow;
