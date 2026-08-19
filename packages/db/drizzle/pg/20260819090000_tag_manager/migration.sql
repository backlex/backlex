-- Tag manager — a GTM-style container hung off the site that already carries
-- the analytics tag.
--
-- The site IS the container. `analytics_sites` already names one domain and
-- already has the snippet installed against it; a second container id on the
-- same page would only be a second thing to get wrong. So this migration adds
-- three columns there and four tables beside it.
--
-- The three `tag_*` tables are DRAFT state — what an operator is editing.
-- None of it is ever served to a visitor. `tag_versions` holds the immutable
-- COMPILED artifact that is served, and `analytics_sites.published_version_id`
-- points at the one currently live. That is the same shape as
-- `schema_snapshots` + `schema_branches`: an append-only history plus a mutable
-- pointer, so a rollback is a pointer move rather than a reconstruction of what
-- used to be true — and the served bytes after a rollback are byte-for-byte
-- what was live before, because they were stored compiled.
--
-- `allow_custom_code` defaults to FALSE and that default is the security
-- design, not a preference. A custom tag is arbitrary JavaScript running on a
-- public website; it stays off until someone deliberately enables it for a
-- site they mean to enable it for.
--
-- No foreign keys, matching the rest of this schema: the SQLite/D1 twin cannot
-- enforce them portably, and a constraint that exists on one dialect only is
-- worse than none — it hides the cleanup the application has to do anyway.
--
-- Replay safety: `IF NOT EXISTS` on every statement, so auto-migrate re-running
-- this file is a no-op.

ALTER TABLE "analytics_sites" ADD COLUMN IF NOT EXISTS "allow_custom_code" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_sites" ADD COLUMN IF NOT EXISTS "published_version" integer;--> statement-breakpoint
ALTER TABLE "analytics_sites" ADD COLUMN IF NOT EXISTS "published_version_id" text;--> statement-breakpoint

-- A user-defined variable, referenced from a tag parameter as `{{key}}`.
--
-- `kind = 'js_expression'` is operator-authored code and rides the SAME
-- `allow_custom_code` gate as a custom-HTML tag. That is deliberate: a variable
-- that evaluates an expression is not a smaller capability than a tag that runs
-- code, it is the same capability wearing a smaller name.
CREATE TABLE IF NOT EXISTS "tag_variables" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "kind" text DEFAULT 'constant' NOT NULL,
  "config" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tag_variables_site_idx" ON "tag_variables" ("site_id");--> statement-breakpoint
-- One key per site: `{{page_type}}` has to resolve to exactly one definition,
-- and a duplicate would resolve to whichever row the planner returned first.
CREATE UNIQUE INDEX IF NOT EXISTS "tag_variables_site_key_idx" ON "tag_variables" ("site_id","key");--> statement-breakpoint

-- When a tag fires. `type` is a closed vocabulary (see
-- `services/tag-conditions.ts`); `config` carries the type-specific settings —
-- a CSS selector, a scroll threshold, a timer interval, a custom event name.
--
-- `condition` is an optional predicate tree with the same node grammar as
-- `analytics_segments.definition`, and the same rule applies to it: the stored
-- blob is NEVER trusted on read, only re-parsed. The difference is the compile
-- target — a segment becomes SQL, a trigger condition becomes something the
-- browser evaluates.
CREATE TABLE IF NOT EXISTS "tag_triggers" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "config" jsonb,
  "condition" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tag_triggers_site_idx" ON "tag_triggers" ("site_id");--> statement-breakpoint

-- The tags themselves.
--
-- `trigger_ids` / `blocking_trigger_ids` are JSON arrays rather than a join
-- table, on the schema's own rule: a column earns its place by being grouped or
-- filtered on, and nothing ever groups by these. The published artifact is one
-- JSON document either way, so a join table would buy normalization we never
-- query and cost a second write path on every publish.
--
-- `consent_category` defaults to 'marketing' — the strictest useful answer,
-- because most tags an operator adds here are advertising tags and a default
-- that under-declares would leak past a consent tool that is working correctly.
CREATE TABLE IF NOT EXISTS "tag_definitions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text NOT NULL,
  "name" text NOT NULL,
  "kind" text DEFAULT 'template' NOT NULL,
  "template_id" text,
  "params" jsonb,
  "trigger_ids" jsonb,
  "blocking_trigger_ids" jsonb,
  "consent_category" text DEFAULT 'marketing' NOT NULL,
  "fire_rule" text DEFAULT 'always' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tag_definitions_site_idx" ON "tag_definitions" ("site_id");--> statement-breakpoint

-- An immutable published container version.
--
-- `snapshot` is the COMPILED artifact, exactly as served. Storing the compiled
-- form rather than recompiling on read is what keeps serving down to a single
-- query on a route every visitor hits, and it is what lets a rollback reproduce
-- exactly what was live rather than what today's compiler would produce from
-- yesterday's rows.
--
-- `hash` is the content hash of `snapshot` and doubles as the ETag, so a
-- revalidation is a bodyless 304.
CREATE TABLE IF NOT EXISTS "tag_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text NOT NULL,
  "version" integer NOT NULL,
  "note" text,
  "snapshot" jsonb NOT NULL,
  "hash" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Version numbers are monotonic per site and are what the admin rolls back to,
-- so two rows claiming the same number is a corruption the database should
-- refuse rather than a race the service gets to lose quietly.
CREATE UNIQUE INDEX IF NOT EXISTS "tag_versions_site_version_idx" ON "tag_versions" ("site_id","version");
