/**
 * OpenAPI metadata for the schema-template catalog.
 *
 * `routes/templates.ts` is a plain `Hono` router with no `.openapi()` calls, so
 * it never reached `SUBAPPS` and never reached the published document — while
 * `GET /api/admin/templates` answers `200` with the full catalog on every live
 * instance, the SDK ships a `templates` client, and MCP exposes four tools for
 * it. Described here through the sibling-metadata pattern (see
 * `graphql.openapi.ts`).
 */
import { apiRegistry, errorResponses, SECURITY, z } from "../lib/openapi";

const TemplateSummary = z
  .object({
    id: z.string().openapi({ example: "ecommerce" }),
    label: z.string().openapi({ example: "E-commerce" }),
    description: z.string(),
    collections: z.number().int().optional().openapi({ description: "How many collections it seeds." }),
  })
  .openapi("TemplateSummary");

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/templates",
  tags: ["templates"],
  summary: "List the template catalog",
  description:
    "Admin-only. The catalog itself is static, but `hasCollections` and `sampleSeeds` are workspace " +
    "state: the first tells an onboarding card whether to show at all, the second drives the " +
    "\"Remove sample data\" affordance. `defaultTemplateId` is what the cloud control plane preselected " +
    "for this instance through the `SEED_TEMPLATE` worker var.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(TemplateSummary),
            defaultTemplateId: z.string().openapi({ example: "blank" }),
            hasCollections: z.boolean(),
            sampleSeeds: z.number().int().openapi({ description: "Seeded demo rows still present." }),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/templates/apply",
  tags: ["templates"],
  summary: "Apply a template to this workspace",
  description:
    "Admin-only. Seeds a vertical's collections — with admin groups, sample rows, and any role / flow / " +
    "KPI / dashboard bundle the template carries — into the ACTIVE workspace. Send either `templateId` " +
    "to apply one from the catalog, or `template` to apply a definition you authored (the same shape " +
    "`GET /extract` returns, so a workspace round-trips).",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .union([
              z.object({ templateId: z.string().min(1).max(40) }),
              z.object({ template: z.record(z.string(), z.unknown()) }),
            ])
            .openapi({ description: "Exactly one of `templateId` or `template`." }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Applied.",
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/templates/clear-samples",
  tags: ["templates"],
  summary: "Remove seeded sample rows",
  description:
    "Admin-only. Deletes the demo rows a template seeded, and only those — the collections, the groups " +
    "and anything written since all stay. This is what makes a seeded workspace usable as a real one.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/templates/extract",
  tags: ["templates"],
  summary: "Export this workspace as a template",
  description:
    "Admin-only. Returns the active workspace's schema in template form — the inverse of `apply`, so a " +
    "workspace shaped by hand can be replayed into another one.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
    },
    ...errorResponses,
  },
});
