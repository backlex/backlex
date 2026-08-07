-- Form invites — one single-use link per recipient.
-- SQLite/D1 twin of the pg migration.
--
-- A public form's own token is a door: anyone holding the link answers, as
-- many times as they like. The cookie guard beside it is a courtesy, not a
-- count — another browser answers again. An invite is the shape for the survey
-- that has to ask each person once: minted per recipient, spent by the submit
-- that uses it.
--
-- Only the SHA-256 of the token is stored; the plaintext is returned once at
-- mint time, exactly as for `approval_approvers` and `signature_requests`.
CREATE TABLE IF NOT EXISTS `form_invites` (
  `id` text PRIMARY KEY NOT NULL,
  `form_id` text NOT NULL,
  `tenant_id` text,
  -- Null for a batch of unaddressed links the operator hands out themselves.
  `email` text,
  `name` text,
  `token_hash` text NOT NULL,
  `sent_at` integer,
  -- Written by the submit that spends the invite, in an UPDATE conditional on
  -- this column still being null — two tabs racing one link produce one answer.
  `used_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- The token IS the grant, so its lookup must be unique — two invites sharing
-- one would let either answer as the other.
CREATE UNIQUE INDEX IF NOT EXISTS `form_invites_token_idx` ON `form_invites` (`token_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `form_invites_form_idx` ON `form_invites` (`form_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `form_invites_tenant_idx` ON `form_invites` (`tenant_id`);
