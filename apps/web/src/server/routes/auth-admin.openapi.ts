import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "auth-admin";

const ConfigInput = z
  .object({
    providers: z.record(z.unknown()).optional(),
    policy: z.record(z.unknown()).optional(),
    sessionLifetime: z.string().optional(),
    redirectUrls: z.array(z.string().url()).optional(),
  })
  .openapi("AuthConfigInput");

const AuthConfigRow = z
  .object({
    tenantId: z.string(),
    providers: z.record(z.unknown()),
    policy: z.record(z.unknown()),
    sessionLifetime: z.string(),
    redirectUrls: z.array(z.string()),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("AuthConfigRow");

const SessionRow = z
  .object({
    id: z.string(),
    userId: z.string(),
    userEmail: z.string(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.unknown(),
    updatedAt: z.unknown(),
    expiresAt: z.unknown(),
    current: z.boolean(),
  })
  .openapi("AuthSessionRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/auth/config",
  tags: [TAG],
  summary: "Get auth config",
  description:
    "Read the active workspace's auth config. Falls back to env-derived defaults when no row exists. Secrets are redacted.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: AuthConfigRow }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/admin/auth/config",
  tags: [TAG],
  summary: "Patch auth config",
  description:
    "Partial update. Provider `clientSecret` plaintext is encrypted into `clientSecretEnc`. Invalidates the cached tenant-auth instance.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: ConfigInput } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/auth/sessions",
  tags: [TAG],
  summary: "List active sessions",
  description: "Every active better-auth session joined with user email. Flags the caller's current session.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(SessionRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/admin/auth/sessions/{id}",
  tags: [TAG],
  summary: "Revoke a session",
  description: "Idempotent — the next request from this session id returns 401.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Revoked", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/auth/sessions/revoke-others",
  tags: [TAG],
  summary: "Revoke other sessions",
  description: "Signs out every session for the caller except the one making this request.",
  security: SECURITY,
  responses: {
    200: {
      description: "Revoked",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), removed: z.number().int().nonnegative() }),
        },
      },
    },
    ...errorResponses,
  },
});
