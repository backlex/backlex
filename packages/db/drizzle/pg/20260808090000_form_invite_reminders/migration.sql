-- Invite reminders — a second mail to whoever hasn't answered.
--
-- A reminder has to carry a working link, and the plaintext invite token is
-- never stored — only its SHA-256 — so it cannot re-send the one that was
-- mailed and has to mint another. Rotating the invite's own token would kill
-- the link in the first mail, in front of exactly the person the reminder is
-- trying to reach.
--
-- So an invite stops being a link and becomes a TURN with more than one way in.
-- The link it was minted with stays on the invite (`form_invites.token_hash`);
-- every later one lives here. All of them open the same turn, and spending any
-- one spends it.
--
-- Additive on purpose: the boot-time runner replays this file against databases
-- that already have it, tolerating only "already exists"-shaped errors, so a
-- migration that moves or drops a column is a migration that fails on the
-- second pass.
CREATE TABLE IF NOT EXISTS "form_invite_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "invite_id" text NOT NULL,
  -- Denormalised from the invite so the lookup stays scoped to one form without
  -- a join: an invite to the staff survey must not open the customer one.
  "form_id" text NOT NULL,
  "tenant_id" text,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Unique for the same reason the invite's own token is: two links resolving to
-- two different turns would let either answer as the other.
CREATE UNIQUE INDEX IF NOT EXISTS "form_invite_tokens_hash_idx" ON "form_invite_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_invite_tokens_invite_idx" ON "form_invite_tokens" ("invite_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_invite_tokens_form_idx" ON "form_invite_tokens" ("form_id");
--> statement-breakpoint
-- When a reminder last went out, and how many have. Both are about the invite
-- and not about a link.
ALTER TABLE "form_invites" ADD COLUMN IF NOT EXISTS "reminded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "form_invites" ADD COLUMN IF NOT EXISTS "reminder_count" integer DEFAULT 0 NOT NULL;
