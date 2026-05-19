import { z } from "@hono/zod-openapi";

// Per-collection shapes are added at request time by services/openapi-dynamic.
// The generic endpoints below document the shared envelope; the body and
// item shapes are `record(unknown)` because the field set is dynamic.
export const ItemBody = z.record(z.string(), z.unknown()).openapi("ItemBody");
export const ItemRow = z.record(z.string(), z.unknown()).openapi("ItemRow");

export const ListMeta = z
  .object({
    filter_count: z.number().int().nonnegative().optional(),
    total_count: z.number().int().nonnegative().optional(),
  })
  .openapi("ItemsListMeta");

export const ListQuery = z.object({
  filter: z.string().optional().openapi({
    description: "JSON-encoded filter DSL (Directus-style).",
  }),
  sort: z.string().optional().openapi({
    description: "Comma-separated field list; prefix `-` for DESC.",
  }),
  fields: z.string().optional().openapi({
    description: "Comma-separated projection. System fields are always included.",
  }),
  expand: z.string().optional().openapi({
    description:
      "Comma-separated relation fields to inline-expand. Each one must be a single-FK `relation` field on the collection. Single-hop only — chains (`a.b`) and `relation_many` heads return 422.",
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

export const TAGS = ["items"];
