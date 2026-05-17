import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const I18nUpsertInput = z
  .object({
    key: z.string().min(1).max(120),
    locale: z.string().min(2).max(8),
    value: z.string(),
  })
  .openapi("I18nUpsertInput");

const I18nBulkInput = z.array(I18nUpsertInput).openapi("I18nBulkInput");

const AutoTranslateInput = z
  .object({
    targetLocale: z.string().min(2).max(8),
    sourceLocale: z.string().min(2).max(8).optional(),
    keys: z.array(z.string().min(1).max(120)).optional(),
    onlyMissing: z.boolean().default(true),
  })
  .openapi("I18nAutoTranslateInput");

const I18nRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    key: z.string(),
    locale: z.string(),
    value: z.string(),
  })
  .openapi("I18nRow");

const I18nMatrix = z
  .object({
    locales: z.array(z.string()),
    keys: z.array(z.string()),
    values: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .passthrough()
  .openapi("I18nMatrix");

const tags = ["i18n"];
const basePath = "/api/admin/i18n";

apiRegistry.registerPath({
  method: "get",
  path: basePath,
  tags,
  summary: "List i18n string rows (admin)",
  description: "Returns rows for the active workspace plus global fallback rows. Admin only.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(I18nRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: `${basePath}/_matrix`,
  tags,
  summary: "Pivoted key×locale matrix",
  description: "Convenience view that includes empty columns for configured-but-untranslated locales.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: I18nMatrix } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: basePath,
  tags,
  summary: "Upsert a single (key, locale) string",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: I18nUpsertInput } } } },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: z.object({ data: I18nRow }) } },
    },
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ data: I18nRow }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: `${basePath}/_bulk`,
  tags,
  summary: "Bulk upsert i18n strings",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: I18nBulkInput } } } },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.literal(true), upserts: z.number().int() }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: `${basePath}/_auto-translate`,
  tags,
  summary: "AI auto-translate into a target locale",
  description: "Requires `ANTHROPIC_API_KEY`. Caps a single request to 50 keys; loops are caller-driven.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: AutoTranslateInput } } } },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            translated: z.number().int(),
            remaining: z.number().int().optional(),
            rows: z.array(I18nRow.pick({ id: true, key: true, locale: true, value: true })),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: `${basePath}/{id}`,
  tags,
  summary: "Delete an i18n row",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _I18nUpsertInput = I18nUpsertInput;
export const _I18nRow = I18nRow;
