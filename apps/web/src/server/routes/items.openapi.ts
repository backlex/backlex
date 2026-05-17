import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

// Per-collection shapes are added at request time by
// services/openapi-dynamic. The generic endpoints below document the
// shared envelope; the body and item shapes are `record(unknown)` because
// the field set is dynamic.
const ItemBody = z.record(z.unknown()).openapi("ItemBody");
const ItemRow = z.record(z.unknown()).openapi("ItemRow");


const ListMeta = z
  .object({
    filter_count: z.number().int().nonnegative().optional(),
    total_count: z.number().int().nonnegative().optional(),
  })
  .openapi("ItemsListMeta");

const ListQuery = z.object({
  filter: z.string().optional().openapi({
    description: "JSON-encoded filter DSL (Directus-style).",
  }),
  sort: z.string().optional().openapi({
    description: "Comma-separated field list; prefix `-` for DESC.",
  }),
  fields: z.string().optional().openapi({
    description: "Comma-separated projection. System fields are always included.",
  }),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  meta: z.string().optional().openapi({
    description: "`filter_count`, `total_count`, or `*`.",
  }),
  locale: z.string().optional().openapi({
    description: "Locale for i18n_text projection; `*` returns full map.",
  }),
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/items/{slug}",
  tags: ["items"],
  summary: "List items",
  description:
    "Generic list endpoint for any collection. Supports Directus-shaped `filter`, `sort`, `fields`, `limit`, `offset`, `meta`. Item shape comes from the collection's field definitions; see the dynamic per-collection paths for typed schemas.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
    query: ListQuery,
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(ItemRow),
            limit: z.number().int().nonnegative(),
            offset: z.number().int().nonnegative(),
            meta: ListMeta.optional(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/items/{slug}/{id}",
  tags: ["items"],
  summary: "Get item",
  description: "Fetches one row by primary key. Respects per-role read field projection.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string(), id: z.string() }),
    query: z.object({ locale: z.string().optional() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: ItemRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/items/{slug}",
  tags: ["items"],
  summary: "Create item",
  description:
    "Creates a row in the collection. Body shape is the collection's field map; adopted collections must include the primary key value.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
    query: z.object({ locale: z.string().optional() }),
    body: {
      required: true,
      content: { "application/json": { schema: ItemBody } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": { schema: z.object({ data: ItemRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/items/{slug}/{id}",
  tags: ["items"],
  summary: "Update item",
  description:
    "Partial update. `i18n_text` fields merge into the existing locale map; pass `?locale=xx` with a string value to upsert one locale.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string(), id: z.string() }),
    query: z.object({ locale: z.string().optional() }),
    body: {
      required: true,
      content: { "application/json": { schema: ItemBody } },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": { schema: z.object({ data: ItemRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/items/{slug}/{id}",
  tags: ["items"],
  summary: "Delete item",
  description: "Hard-deletes the row. Cascades to ownership side table + vector store.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: OkSchema } },
    },
    ...errorResponses,
  },
});
