import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "settings";

const LocaleCode = z.string().min(2).max(8).regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/);

const SettingsInput = z
  .object({
    siteName: z.string().min(1).max(120).optional(),
    openSignup: z.boolean().optional(),
    i18nLocales: z.array(LocaleCode).min(1).max(50).optional(),
    i18nDefaultLocale: LocaleCode.optional(),
  })
  .openapi("SettingsInput");

const SettingsRow = z
  .object({
    siteName: z.string().nullable().optional(),
    openSignup: z.boolean().optional(),
    i18nLocales: z.array(z.string()).optional(),
    i18nDefaultLocale: z.string().nullable().optional(),
    appUrl: z.string(),
    emailFrom: z.string().nullable(),
  })
  .passthrough()
  .openapi("Settings");

const Binding = z.object({
  type: z.string(),
  name: z.string(),
  target: z.string(),
  status: z.string(),
});

const EnvVar = z.object({
  key: z.string(),
  set: z.boolean(),
  source: z.string(),
  secret: z.boolean(),
});

const RuntimeInfo = z
  .object({
    adapter: z.string(),
    dialect: z.string(),
    bindings: z.array(Binding),
    envVars: z.array(EnvVar),
    version: z.string(),
  })
  .openapi("RuntimeInfo");

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/settings",
  tags: [TAG],
  summary: "Get settings",
  description: "Active workspace's runtime-mutable settings plus env-derived `appUrl`/`emailFrom` (read-only).",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: SettingsRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/admin/settings",
  tags: [TAG],
  summary: "Patch settings",
  description: "Whitelisted keys only. Unknown keys are rejected (strict).",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: SettingsInput } } } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/settings/runtime",
  tags: [TAG],
  summary: "Runtime info",
  description: "Read-only adapter/dialect + env var presence + binding inventory. Changes require redeploy.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: RuntimeInfo }) } } },
    ...errorResponses,
  },
});
