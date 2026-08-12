-- Product listings — putting a product ON SALE, which the five capabilities
-- before this could not express.
--
-- A `destination` already writes price and stock to a marketplace, but only
-- against a listing that exists: it addresses one by barcode and has nothing to
-- say about creating it. Creating one needs a category, that category's own
-- attributes, and a brand — and none of those can be declared when the provider
-- is written. Trendyol has 3,867 categories, each demanding ~24 attributes,
-- each attribute allowing hundreds of values. So a listing provider is
-- interrogated at form-fill time and the operator's answers are stored here.
--
-- `direction` gains a fourth value, `listing`, for the same reason it gained
-- `inbound`: the row is identical (collection, schedule, breaker, failure
-- count) and only the direction of travel differs. `category_field` says which
-- of the product collection's columns names the local category, because a
-- workspace's idea of a category is a column of its own choosing.

ALTER TABLE "integration_syncs" ADD COLUMN "category_field" text;--> statement-breakpoint

-- How one of a workspace's categories maps onto a marketplace's.
--
-- A table rather than a JSON blob on the sync row, and the reason is
-- concurrency rather than size. An operator maps ONE category at a time; a blob
-- of five hundred would make every such edit a read-modify-write of the whole
-- map, so two people mapping two categories would each silently discard the
-- other's work. A row per local value makes the edit addressable.
--
-- `attributes` stays JSON because its questions are the provider's and differ
-- per category — attribute id → a fixed value id, free text, or the product
-- column to read the value from. Columns cannot express a shape that changes
-- with the category the operator picked.
CREATE TABLE IF NOT EXISTS "integration_listing_maps" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sync_id" text NOT NULL,
  "local_value" text NOT NULL,
  "category_id" text NOT NULL,
  "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One answer per local category. A second row for the same value would make
-- "which category does this product go in" depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS "integration_listing_maps_value_idx"
  ON "integration_listing_maps" ("sync_id", "local_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_listing_maps_tenant_idx"
  ON "integration_listing_maps" ("tenant_id");--> statement-breakpoint

-- One batch of products handed to a marketplace, and what became of it.
--
-- Every marketplace here answers a create with a queue ticket rather than a
-- result — Trendyol a `batchRequestId`, n11 a task id, Çiçeksepeti a `batchId`,
-- Hepsiburada a tracking id — and the verdict lands minutes or hours later, one
-- unit at a time, with a reason a person has to read. This row is the only
-- thing that knows a publish is outstanding, and it is also the operator's
-- record of what was sent. Same argument `integration_webhook_deliveries`
-- makes, and the same reason neither put a `last_*` column on the sync.
--
-- `sent` is what makes a verdict addressable at all. None of these marketplaces
-- returns our request id; every one of them echoes a column of OURS back (a
-- barcode, a stock code, a merchant sku), so this maps that echo to the row
-- that asked for it. Without it a verdict has nowhere to go.
--
-- The open index is the sweep's whole query, and the sweep runs INDEPENDENTLY
-- of any sync's schedule. A listing sync defaults to manual (`interval_minutes`
-- 0), which the scheduler skips by design — so a manually published batch would
-- never be asked about, and every product in it would read "pending" forever. A
-- verdict is owed whether the publish was clicked or scheduled.
CREATE TABLE IF NOT EXISTS "integration_listing_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sync_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "batch_id" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "sent" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "pending_count" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);--> statement-breakpoint
-- A provider's ticket is unique within the sync that asked for it, which is
-- what stops a retried publish opening a second batch for the same work.
CREATE UNIQUE INDEX IF NOT EXISTS "integration_listing_batches_ticket_idx"
  ON "integration_listing_batches" ("sync_id", "batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_listing_batches_open_idx"
  ON "integration_listing_batches" ("status", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_listing_batches_tenant_idx"
  ON "integration_listing_batches" ("tenant_id");
