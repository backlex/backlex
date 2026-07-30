-- Data-subject erasure requests. SQLite/D1 twin of the pg migration.
--
-- No column holds the subject's email or id: an audit trail that records who
-- was erased re-creates the data the request existed to remove, and outlives
-- every row it deleted. `subject_hash` is a salted digest instead.
CREATE TABLE IF NOT EXISTS `erasure_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `subject_type` text NOT NULL,
  `subject_hash` text NOT NULL,
  `mode` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `plan` text,
  `report` text,
  `error` text,
  `reference` text,
  `requested_by` text,
  `previewed_at` integer,
  `completed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erasure_requests_tenant_idx` ON `erasure_requests` (`tenant_id`);--> statement-breakpoint
-- "Has this person asked before?" is a lookup by hash within a workspace.
CREATE INDEX IF NOT EXISTS `erasure_requests_subject_idx` ON `erasure_requests` (`tenant_id`,`subject_hash`);
