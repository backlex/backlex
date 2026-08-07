-- Form drafts — a half-filled form, kept so the person can come back to it.
--
-- Opt-in per form (`settings.saveProgress`); a form that does not ask for it
-- stores nothing. The row is found by `key_hash`: the SHA-256 of whatever the
-- visitor holds — an opaque cookie value for an open link, the invite token for
-- an invited one. Only the hash lands here, exactly as for `form_invites`, so
-- the table is a pile of answers nobody can look up without the secret that
-- wrote them.
--
-- The submit that completes the form deletes its draft; the cron sweep deletes
-- the ones that were abandoned.
CREATE TABLE IF NOT EXISTS "form_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "form_id" text NOT NULL,
  "tenant_id" text,
  -- SHA-256 of the resume secret — never the secret itself.
  "key_hash" text NOT NULL,
  -- Answers so far, clamped to the form's currently-exposed fields.
  "data" jsonb NOT NULL,
  -- Step page the visitor had reached, so they return to it and not to the
  -- first question of a form they are two-thirds through.
  "step" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One draft per (form, holder): the upsert targets this, so two tabs of the
-- same visitor race into one row instead of forking the answers.
CREATE UNIQUE INDEX IF NOT EXISTS "form_drafts_key_idx" ON "form_drafts" ("form_id","key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_drafts_form_idx" ON "form_drafts" ("form_id");
--> statement-breakpoint
-- The sweep walks the oldest first; without this it walks every draft in the
-- workspace to find the stale ones.
CREATE INDEX IF NOT EXISTS "form_drafts_updated_idx" ON "form_drafts" ("updated_at");
