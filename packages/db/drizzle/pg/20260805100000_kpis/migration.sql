-- Named KPI definitions: the one place a KPI's formula is written down.
--
-- Today the same business figure is spelled out independently on every surface
-- that shows it. A dashboard panel stores raw `sql` or an inline
-- items-aggregate config. The Ask AI planner is handed the collection's column
-- list and asked to invent `collections.aggregate` arguments from scratch, per
-- question, per session. A scheduled report derives it a third time. Nothing
-- reconciles the three, so "revenue" can mean product totals with tax in one
-- place, without tax in another, and with cancelled orders still counted in a
-- third — and every screen presents its own answer with equal confidence.
--
-- That is the failure this table is for. A KPI row IS the definition;
-- `runKpi()` is the only thing that evaluates it, and panels, Ask AI,
-- reports and the public embed all call through it. They can still be wrong,
-- but they are now wrong in unison and one edit fixes every surface at once.
--
-- Nothing here is a new query engine. The columns mirror `ItemsAggregateConfig`
-- because the runner delegates to `runItemsAggregate`, which already settles
-- the parts that are easy to get subtly wrong: money columns are rescaled from
-- minor units, a sum over a column whose currency varies per row is refused
-- rather than silently adding lira to dollars, and soft-deleted and draft rows
-- follow the caller's own read visibility. A second implementation would drift
-- from those rules the first time one of them changed.
CREATE TABLE IF NOT EXISTS "kpis" (
  "id" text PRIMARY KEY NOT NULL,
  -- NOT NULL with '' for "no tenant", unlike `dashboards` and `saved_panels`
  -- next door, which are nullable so a NULL row can mean "system-global".
  --
  -- A unique index treats NULLs as DISTINCT in both dialects, so a nullable
  -- column here would let an install with no tenant hold two KPIs both
  -- slugged 'revenue'. Everything downstream resolves a KPI BY slug — a
  -- panel references it, an AI tool call names it — so two rows answering to
  -- one slug means the number a chart shows depends on row order. The
  -- alternative, a uniqueness check in the service before insert, is the
  -- check-then-insert race that has already produced UNIQUE failures against
  -- D1 in this codebase. The sentinel is what makes the key a key.
  --
  -- The cost is that this table has no system-global tier. That is deliberate:
  -- a global row and a tenant row sharing a slug would need a precedence rule
  -- to resolve, which is the same ambiguity by another name. If seeded KPIs
  -- are wanted later they can be added per tenant.
  "tenant_id" text DEFAULT '' NOT NULL,
  -- The stable handle. `name` is display text and may be renamed or
  -- translated; a dashboard that referenced the display string would break on
  -- the first rename, so the slug is what panels and tool calls store.
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- Collection slug the KPI aggregates over.
  "collection" text NOT NULL,
  -- count | sum | avg | min | max — mirrors ITEMS_AGG_FUNCS. Validated by the
  -- route's zod enum rather than a CHECK constraint, matching how every other
  -- enum-ish column in this schema is handled.
  "agg" text DEFAULT 'count' NOT NULL,
  -- Aggregate target column. NULL only for `count`.
  "field" text,
  -- Permission-DSL condition narrowing the rows ("only paid orders"). The same
  -- grammar the list endpoint accepts, so a KPI and the filtered list view
  -- an operator would check it against count the same rows instead of
  -- disagreeing over what "paid" means.
  "filter" jsonb,
  -- The timestamp column the period window applies to.
  --
  -- NULL is meaningful, not missing: it marks a KPI with no time dimension
  -- (total customers, current stock on hand). Those report a running total and
  -- NO period comparison. The tempting default — treat NULL as "compare
  -- anyway" — would compute a previous window containing every row ever
  -- written and print a delta that describes the age of the table rather than
  -- anything that changed.
  "date_field" text,
  -- Optional ranking dimension. This is what turns "top products" and "revenue
  -- by country" into definitions rather than queries somebody retypes: the
  -- grouped form returns one row per label, and the runner pairs each label
  -- with its own previous-period value.
  "group_by" text,
  -- Row cap for a grouped KPI. Named `top_n` because `limit` is SQL.
  "top_n" integer,
  -- number | money | percent | duration. Presentation belongs with the
  -- definition: a rate stored as 0.043 has to reach every surface knowing it
  -- is 4.3%, or each one invents its own formatting and they disagree on a
  -- figure they agree on.
  "format" text DEFAULT 'number' NOT NULL,
  -- Free-text suffix for `number` KPIs ("orders", "kg").
  "unit" text,
  "decimals" integer,
  -- Which direction is good news: up | down | neutral.
  --
  -- Needed because the sign of a delta does not carry its meaning. A rising
  -- cancellation rate and a rising order count are both "+12%", and without
  -- this column the UI has to guess which one to paint red — so it would guess
  -- from the KPI's name, in one language, and get the other half wrong.
  "direction" text DEFAULT 'neutral' NOT NULL,
  "created_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kpis_tenant_idx" ON "kpis" ("tenant_id");
--> statement-breakpoint
-- The lookup key, and the reason `tenant_id` carries a sentinel instead of NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "kpis_tenant_slug_idx"
  ON "kpis" ("tenant_id", "slug");
