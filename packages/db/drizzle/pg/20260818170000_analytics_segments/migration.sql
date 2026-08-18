-- A saved analytics filter.
--
-- `definition` holds an operator-authored predicate tree. It is the highest-
-- severity input in this feature — it ends up inside a WHERE clause on every
-- report it is applied to — so it is stored as an opaque blob and never
-- trusted on read: `services/analytics-segments.ts` re-parses it against a
-- closed field allowlist and binds every value on the way out. Storing it
-- pre-compiled would mean trusting yesterday's validator forever.
--
-- `site_id` is optional. A segment scoped to one site is the common case for a
-- workspace measuring several properties; a NULL applies workspace-wide.
--
-- Replay safety: `IF NOT EXISTS` throughout.

CREATE TABLE IF NOT EXISTS "analytics_segments" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text,
  "name" text NOT NULL,
  "definition" jsonb,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_segments_tenant_idx" ON "analytics_segments" ("tenant_id","site_id");
