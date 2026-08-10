-- JWT signing keys with a life cycle — SQLite/D1 twin. See the pg migration for
-- the four states and why `standby` exists.

CREATE TABLE IF NOT EXISTS `signing_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `kid` text NOT NULL,
  `alg` text NOT NULL,
  `private_key` text NOT NULL,
  `public_key` text NOT NULL,
  `status` text DEFAULT 'standby' NOT NULL,
  `note` text,
  `created_at` integer NOT NULL,
  `activated_at` integer,
  `retired_at` integer,
  `revoked_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `signing_keys_kid_idx` ON `signing_keys` (`kid`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `signing_keys_status_idx` ON `signing_keys` (`status`);
