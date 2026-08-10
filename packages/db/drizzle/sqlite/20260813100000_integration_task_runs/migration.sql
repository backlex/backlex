-- Task runs — SQLite/D1 twin. See the pg migration for why the unique index is
-- the guard rather than a check the code performs.

CREATE TABLE IF NOT EXISTS `integration_task_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  `integration_id` text NOT NULL,
  `task` text NOT NULL,
  `collection` text NOT NULL,
  `item_id` text NOT NULL,
  `status` text NOT NULL,
  `outputs` text DEFAULT '{}' NOT NULL,
  `artifact_key` text,
  `error` text,
  `attempts` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_task_runs_once_idx`
  ON `integration_task_runs` (`tenant_id`, `integration_id`, `task`, `collection`, `item_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_task_runs_tenant_idx` ON `integration_task_runs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_task_runs_item_idx` ON `integration_task_runs` (`collection`, `item_id`);
