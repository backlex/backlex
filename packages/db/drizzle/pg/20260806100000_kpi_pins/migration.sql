-- Pinned KPIs: the figure for THIS row, on the row's own page.
--
-- Until now a KPI answered for a whole collection — "revenue", "orders
-- placed". The question an operator actually has while looking at one product
-- is "how is THIS product doing", and answering it meant leaving the page for
-- a dashboard that cannot narrow to a row at all.
--
-- Two columns, because the answer needs two things the definition did not
-- carry:
--
--   `pin_to`    — the collection whose item page this belongs on. NOT the
--                 collection the KPI aggregates: "revenue per product" sums
--                 ORDER LINES and belongs on a PRODUCT. Conflating the two is
--                 why a single column would not do.
--   `pin_field` — the relation column on the KPI's own collection that points
--                 back at that row (`order_items.product`). Without it the
--                 server would have to guess which of several relations the
--                 pin meant, and guessing wrong produces a number that is
--                 confidently about the wrong thing.
--
-- Both or neither, enforced in the service: a `pin_to` with no `pin_field` is
-- a tile with nothing to filter on, and a `pin_field` with no `pin_to` is a
-- link to a page it will never appear on.
ALTER TABLE "kpis" ADD COLUMN IF NOT EXISTS "pin_to" text;
--> statement-breakpoint
ALTER TABLE "kpis" ADD COLUMN IF NOT EXISTS "pin_field" text;
--> statement-breakpoint
-- The item page asks "what is pinned here" on every open, so the lookup is by
-- (tenant, pin_to) rather than a scan of every definition in the workspace.
CREATE INDEX IF NOT EXISTS "kpis_pin_idx" ON "kpis" ("tenant_id", "pin_to");
