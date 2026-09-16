-- Email and document templates gain an appearance: the theme, accent and font
-- a form already stores in its settings, in the same shape. A template reads it
-- back as {{ theme.* }} values at render time (@backlex/core/appearance), so
-- the column holds only the three choices, never derived colours.
--
-- Nullable with no default: an existing template has not chosen anything, and
-- renders against the light defaults exactly as a new one does.
--
-- Additive, so a replay by the boot-time runner raises "already exists" and is
-- tolerated.

ALTER TABLE "email_templates" ADD COLUMN "appearance" jsonb;
--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "appearance" jsonb;
