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
    description: "JSON-encoded filter DSL.",
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
  /**
   * Capped, because `OFFSET n` costs O(n) on both dialects — the database walks
   * and discards every skipped row. At `limit=200` this ceiling is page 500,
   * past anything a person pages to; a crawler that keeps incrementing is
   * billing a full table scan per request (literally, on D1) for rows the keyset
   * `cursor` below returns in constant time.
   */
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  cursor: z.string().optional().openapi({
    description:
      "Keyset (seek) pagination. Pass an empty value to start; echo back the `next_cursor` from each response to page forward. O(1) per page regardless of depth and stable under concurrent inserts — unlike `offset`. When present, `offset` is ignored.",
  }),
  meta: z.string().optional().openapi({
    description: "`filter_count`, `total_count`, or `*`.",
  }),
  locale: z.string().optional().openapi({
    description: "Locale for localized-field projection; `*` returns full map.",
  }),
});

export const TAGS = ["items"];
