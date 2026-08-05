-- Named KPI definitions: the one place a KPI's formula is written down.
-- SQLite/D1 twin of the pg migration, where the reasoning is written out in
-- full.
--
-- The short version: a panel stores raw `sql`, the Ask AI planner invents
-- aggregate arguments per question, and a report derives the same figure a
-- third way — so one workspace can hold three different answers for "revenue",
-- each presented with equal confidence. A KPI row is the definition;
-- `runKpi()` is the only evaluator, and every surface calls through it.
--
-- The columns mirror `ItemsAggregateConfig` because the runner delegates to
-- `runItemsAggregate` rather than reimplementing aggregation — money rescaling,
-- the refusal to sum mixed currencies, and soft-delete/draft visibility are
-- already settled there and must not fork.
CREATE TABLE IF NOT EXISTS `kpis` (
  `id` text PRIMARY KEY NOT NULL,
  -- NOT NULL with '' for "no tenant": a unique index treats NULLs as DISTINCT,
  -- so a nullable key column would let two rows share the slug that panels and
  -- AI tool calls resolve KPIs by, making the number a chart shows depend on
  -- row order. Checking uniqueness in the service instead is the
  -- check-then-insert race that has already produced UNIQUE failures on D1.
  `tenant_id` text DEFAULT '' NOT NULL,
  -- The stable handle. `name` is display text and may be renamed; a dashboard
  -- that referenced the display string would break on the first rename.
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `collection` text NOT NULL,
  -- count | sum | avg | min | max — mirrors ITEMS_AGG_FUNCS.
  `agg` text DEFAULT 'count' NOT NULL,
  -- Aggregate target column. NULL only for `count`.
  `field` text,
  -- Permission-DSL condition narrowing the rows, in the same grammar the list
  -- endpoint accepts, so a KPI and a filtered list view count the same rows.
  `filter` text,
  -- Timestamp column the period window applies to. NULL is meaningful: it marks
  -- a KPI with no time dimension, which reports a running total and no
  -- comparison rather than a delta describing the age of the table.
  `date_field` text,
  -- Optional ranking dimension — what makes "top products" a definition rather
  -- than a query somebody retypes.
  `group_by` text,
  -- Row cap for a grouped KPI. Named `top_n` because `limit` is SQL.
  `top_n` integer,
  -- number | money | percent | duration. Presentation lives with the definition
  -- so a rate stored as 0.043 reaches every surface knowing it is 4.3%.
  `format` text DEFAULT 'number' NOT NULL,
  `unit` text,
  `decimals` integer,
  -- up | down | neutral. The sign of a delta does not carry its meaning: a
  -- rising cancellation rate and a rising order count are both "+12%".
  `direction` text DEFAULT 'neutral' NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `kpis_tenant_idx` ON `kpis` (`tenant_id`);
--> statement-breakpoint
-- The lookup key, and the reason `tenant_id` carries a sentinel instead of NULL.
CREATE UNIQUE INDEX IF NOT EXISTS `kpis_tenant_slug_idx`
  ON `kpis` (`tenant_id`, `slug`);
