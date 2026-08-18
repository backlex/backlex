-- A website registered for tag-based measurement.
--
-- The phase-2 tag is a public `<script>`: its site id ships in the snippet and
-- is readable by anyone who views source. That is deliberate — the id names a
-- destination, it does not authenticate one — but it means this table has to
-- carry the settings that actually bound what a public write endpoint accepts:
-- which paths to ignore, which IPs to ignore, whether to keep declared bots,
-- and whether to require a known origin.
--
-- `require_known_origin` is worth being precise about. `Origin` is forgeable by
-- any non-browser client, so the domain check stops a snippet copied onto a
-- staging host and casual abuse; it is NOT a security boundary. What bounds
-- abuse is the per-(site, ip) rate limit on the collect route.
--
-- `tz` is UNUSED in v1 — every report buckets in UTC, because
-- `analytics_events.day` is a UTC string. It lands now anyway: re-bucketing
-- reports into a per-site timezone later would rewrite overview, retention and
-- funnels, and carrying an unused column is much cheaper than migrating one in
-- once rows exist.
--
-- Replay safety: `IF NOT EXISTS` throughout, so auto-migrate re-running this
-- file is a no-op.

CREATE TABLE IF NOT EXISTS "analytics_sites" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "name" text NOT NULL,
  "domain" text NOT NULL,
  "tz" text DEFAULT 'UTC' NOT NULL,
  "excluded_paths" jsonb,
  "ignored_ips" jsonb,
  "filter_bots" boolean DEFAULT true NOT NULL,
  "require_known_origin" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Every lookup is "this workspace's sites", and the collect route resolves a
-- reported origin to a site by host.
CREATE INDEX IF NOT EXISTS "analytics_sites_tenant_domain_idx" ON "analytics_sites" ("tenant_id","domain");
