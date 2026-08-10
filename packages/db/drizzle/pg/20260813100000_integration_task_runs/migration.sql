-- Task runs — the once-only guard for a provider action with a real effect.
--
-- The three capabilities before this one are all safe to repeat. A sink
-- delivery lost to a retry is one duplicate notification; a pull re-reads a
-- page; a push re-sends a batch a warehouse collapses on merge. A task books a
-- shipment, and the second one costs money and confuses a courier.
--
-- "Did this already happen" cannot come from the provider's answer: a carrier
-- that has no idempotency header will happily open a second consignment, and
-- the queue retries on backoff while an operator can click twice. So it lives
-- here, and the unique index is the guard rather than a check the code does —
-- two concurrent callers race to INSERT and exactly one wins.
--
-- `outputs` is kept so a re-invocation of an already-succeeded task can hand
-- back what the first run produced instead of failing or re-booking. That also
-- makes this an operational record: which orders have a label, which do not.

CREATE TABLE IF NOT EXISTS "integration_task_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "integration_id" text NOT NULL,
  "task" text NOT NULL,
  "collection" text NOT NULL,
  "item_id" text NOT NULL,
  "status" text NOT NULL,
  "outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "artifact_key" text,
  "error" text,
  "attempts" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_task_runs_once_idx"
  ON "integration_task_runs" ("tenant_id", "integration_id", "task", "collection", "item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_task_runs_tenant_idx" ON "integration_task_runs" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_task_runs_item_idx" ON "integration_task_runs" ("collection", "item_id");
