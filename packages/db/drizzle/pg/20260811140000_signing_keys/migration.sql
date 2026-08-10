-- JWT signing keys with a life cycle.
--
-- Rotation by environment variable means two deploys to roll forward and a
-- third to roll back, each one in an incident under time pressure. A row has
-- states instead, and every transition is reversible:
--
--   standby          published in the JWKS, signing nothing. A verifier caches
--                    the JWKS, so a key must be VISIBLE before it signs.
--   in_use           exactly one; new tokens carry its kid.
--   previously_used  no longer signs, still verifies — its tokens are live.
--   revoked          out of the JWKS; its tokens stop verifying.
--
-- `private_key` is AES-GCM encrypted with the deployment's AUTH_SECRET, which
-- protects a database dump and nothing beyond it. Instance-level, not per
-- workspace: the JWKS is one document at one URL.

CREATE TABLE IF NOT EXISTS "signing_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "kid" text NOT NULL,
  "alg" text NOT NULL,
  "private_key" text NOT NULL,
  "public_key" text NOT NULL,
  "status" text DEFAULT 'standby' NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signing_keys_kid_idx" ON "signing_keys" ("kid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signing_keys_status_idx" ON "signing_keys" ("status");
