import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const EmailTemplateInput = z
  .object({
    key: z.string().min(2).max(40),
    name: z.string().min(1).max(80),
    subject: z.string().min(1).max(200),
    fromAddress: z
      .union([z.string().email(), z.literal("")])
      .nullish()
      .openapi({ description: "Empty string or null clears the override." }),
    bodyHtml: z.string(),
    bodyText: z.string().nullish(),
    variables: z.array(z.string()).nullish(),
  })
  .openapi("EmailTemplateInput");

const EmailTemplateRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    key: z.string(),
    name: z.string(),
    subject: z.string(),
    fromAddress: z.string().nullable(),
    bodyHtml: z.string(),
    bodyText: z.string().nullable(),
    variables: z.array(z.string()).nullable(),
    updatedBy: z.string().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("EmailTemplateRow");

const SendTestInput = z
  .object({
    to: z.string().email().optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("EmailTemplateSendTestInput");

const tags = ["email-templates"];
const basePath = "/api/admin/email-templates";

apiRegistry.registerPath({
  method: "get",
  path: basePath,
  tags,
  summary: "List email templates",
  description: "Returns tenant-scoped rows plus the global (`tenantId IS NULL`) defaults. Admin only.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(EmailTemplateRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: `${basePath}/{id}`,
  tags,
  summary: "Get a single email template",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: EmailTemplateRow }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: basePath,
  tags,
  summary: "Create an email template",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: EmailTemplateInput } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ data: EmailTemplateRow }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: `${basePath}/{id}`,
  tags,
  summary: "Update an email template",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: EmailTemplateInput.partial() } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: `${basePath}/{id}`,
  tags,
  summary: "Delete an email template",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: `${basePath}/{id}/send-test`,
  tags,
  summary: "Render + send the template as a test email",
  description: "Resolves the workspace email transport, renders the template with sample vars, and sends to `to` (defaults to the caller's email).",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: false, content: { "application/json": { schema: SendTestInput } } },
  },
  responses: {
    200: { description: "Sent", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _EmailTemplateInput = EmailTemplateInput;
export const _EmailTemplateRow = EmailTemplateRow;
