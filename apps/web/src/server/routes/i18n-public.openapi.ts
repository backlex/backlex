import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const I18nLocalesResponse = z
  .object({
    locales: z.array(z.string()),
    defaultLocale: z.string(),
  })
  .openapi("I18nPublicLocalesResponse");

const I18nBundle = z
  .record(z.string(), z.string())
  .openapi("I18nPublicBundle");

const tags = ["i18n-public"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/i18n",
  tags,
  summary: "List configured locales (public)",
  description: "Public, unauthenticated. Returns the workspace's configured locales + default locale. Cached for 60s.",
  security: [],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: I18nLocalesResponse }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/i18n/{locale}",
  tags,
  summary: "Fetch a locale string bundle (public)",
  description: "Public, unauthenticated. Returns the merged `(key → value)` bundle for `locale`, with tenant rows shadowing global fallback rows. Cached for 60s.",
  security: [],
  request: {
    params: z.object({
      locale: z.string().openapi({ description: "BCP-47 locale code (e.g. `en`, `tr-TR`)." }),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: I18nBundle }) } },
    },
    ...errorResponses,
  },
});

export const _I18nPublicBundle = I18nBundle;
