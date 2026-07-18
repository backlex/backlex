-- Form submission counters: all-time accepted + spam-blocked counts and the
-- last accepted-submission timestamp, shown on the Forms list/Submissions tab.
-- See packages/db/drizzle/pg/20260719090000_forms_stats for the twin.

ALTER TABLE `forms` ADD COLUMN `submission_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `forms` ADD COLUMN `blocked_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `forms` ADD COLUMN `last_submission_at` integer;
