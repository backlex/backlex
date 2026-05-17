import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const FieldSchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
    type: z.enum([
      "text",
      "longtext",
      "integer",
      "number",
      "boolean",
      "json",
      "timestamp",
      "uuid",
      "relation",
    ]),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    to: z.string().regex(/^[a-z][a-z0-9_]*$/).optional().openapi({
      description: "Target collection slug — required when `type === 'relation'`.",
    }),
    interface: z.string().min(1).max(64).optional().openapi({
      description: "UI hint only — admin interface picker id, never affects storage.",
    }),
    options: z
      .object({
        values: z.array(z.string()).optional(),
        choices: z
          .array(
            z.object({
              value: z.string().min(1),
              label: z.string().optional(),
              color: z.string().optional(),
              icon: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    validation: z
      .object({
        regex: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        minLength: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().nonnegative().optional(),
      })
      .optional(),
    visibleWhen: z
      .object({
        field: z.string().regex(/^[a-z][a-z0-9_]*$/),
        op: z.enum(["_eq", "_neq", "_in"]),
        value: z.unknown(),
      })
      .optional(),
    group: z.string().optional(),
    vectorize: z.boolean().optional(),
  })
  .openapi("CollectionField");

const CollectionInput = z
  .object({
    slug: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
    singular: z.string().optional(),
    plural: z.string().optional(),
    note: z.string().optional(),
    displayTemplate: z.string().optional(),
    fields: z.array(FieldSchema),
    ownerScoped: z.boolean().optional(),
    tenantScoped: z.boolean().optional(),
    versioned: z.boolean().optional(),
    vectorize: z.boolean().optional(),
    vectorizeModel: z.string().nullable().optional(),
    defaultSort: z.string().nullable().optional().openapi({
      description: "Comma-separated default sort (`-published_at,name`).",
    }),
  })
  .openapi("CollectionInput");

const CollectionRow = z
  .object({
    id: z.string(),
    slug: z.string(),
    tenantId: z.string().nullable(),
    physicalTable: z.string(),
    singular: z.string().nullable().optional(),
    plural: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    displayTemplate: z.string().nullable().optional(),
    fields: z.array(FieldSchema),
    ownerScoped: z.boolean().optional(),
    tenantScoped: z.boolean().optional(),
    versioned: z.boolean().optional(),
    vectorize: z.boolean().optional(),
    vectorizeModel: z.string().nullable().optional(),
    defaultSort: z.string().nullable().optional(),
    adopted: z.boolean().optional(),
  })
  .openapi("CollectionRow");


apiRegistry.registerPath({
  method: "get",
  path: "/api/collections",
  tags: ["collections"],
  summary: "List collections",
  description: "Returns every collection in the active workspace.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(CollectionRow) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/collections/{slug}",
  tags: ["collections"],
  summary: "Get collection",
  description: "Fetches a single collection by slug.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: CollectionRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/collections",
  tags: ["collections"],
  summary: "Create collection",
  description:
    "Creates a managed collection and its physical table. Seeds owner-scoped permissions when `ownerScoped: true`.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CollectionInput } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": { schema: z.object({ data: CollectionRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/collections/{slug}",
  tags: ["collections"],
  summary: "Update collection",
  description:
    "Partial update. Additive schema changes only — drop fields via the field endpoint. Slug renames cascade across permissions, revisions, flows, etc.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CollectionInput.partial() } },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            slug: z.string(),
            renamed: z.unknown().nullable(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/collections/{slug}",
  tags: ["collections"],
  summary: "Delete collection",
  description:
    "Drops the collection and its physical table (adopted tables are detached, not dropped).",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
  },
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
  path: "/api/collections/{slug}/vectorize",
  tags: ["collections"],
  summary: "Backfill embeddings",
  description:
    "Synchronously embeds every existing row in the collection and upserts into the vector store (100/batch). Requires `vectorize: true` and at least one vectorized text field.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            processed: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});
