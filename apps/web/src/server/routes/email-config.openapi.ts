import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const EmailProvider = z.enum([
  "inherit",
  "console",
  "resend",
  "sendgrid",
  "mailgun",
  "ses",
  "smtp",
]);

const EmailConfigPutInput = z
  .object({
    provider: EmailProvider,
    fromAddress: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
    config: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Non-secret provider params (mailgun domain, ses region, smtp host, etc.). Replaces stored config wholesale.",
    }),
    secrets: z
      .record(z.string(), z.union([z.string(), z.null()]))
      .optional()
      .openapi({
        description:
          "Per-key plaintext secret (`apiKey`, `secretAccessKey`, `pass`). Non-empty string = encrypt + store; empty/null = clear; omitted keys are left untouched.",
      }),
  })
  .openapi("EmailConfigPutInput");

const EmailConfigResponse = z
  .object({
    tenantId: z.string(),
    provider: z.string(),
    fromAddress: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    secretsSet: z.object({
      apiKey: z.boolean(),
      secretAccessKey: z.boolean(),
      pass: z.boolean(),
    }),
    updatedAt: z.unknown().nullable(),
    env: z.object({
      provider: z.string().nullable(),
      from: z.string().nullable(),
    }),
    providerIds: z.array(z.string()),
  })
  .openapi("EmailConfigResponse");

const EmailTestInput = z
  .object({ to: z.string().email().optional() })
  .openapi("EmailTestInput");

const tags = ["email-config"];
const basePath = "/api/admin/email-config";

apiRegistry.registerPath({
  method: "get",
  path: basePath,
  tags,
  summary: "Read the workspace email config",
  description: "Returns the active workspace's email config. Secret values are never returned — only a per-key 'is it set' flag.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: EmailConfigResponse }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: basePath,
  tags,
  summary: "Upsert the workspace email config",
  description: "Plaintext secrets are encrypted (AES-256-GCM, key derived from `AUTH_SECRET`) before storage. Invalidates the tenant auth cache.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: EmailConfigPutInput } } } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: `${basePath}/test`,
  tags,
  summary: "Send a test email through the resolved transport",
  security: SECURITY,
  request: { body: { required: false, content: { "application/json": { schema: EmailTestInput } } } },
  responses: {
    200: {
      description: "Sent",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), to: z.string() }) } },
    },
    ...errorResponses,
  },
});

export const _EmailConfigPutInput = EmailConfigPutInput;
export const _EmailConfigResponse = EmailConfigResponse;
