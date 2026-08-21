-- Every distinct artifact a site's consent policy has compiled to.
--
-- Proof of consent is meaningless without an immutable thing to point at. A
-- consent record (a later phase) stores the hash it showed the visitor; this
-- table is what that hash resolves to. Storing only the live policy would make
-- the evidence a pointer into mutable state, which is not evidence.
--
-- CONTENT-ADDRESSED, NOT COUNTER-VERSIONED — the one place this departs from
-- `tag_versions`, which it otherwise mirrors. A tag container has a draft the
-- operator publishes, so a monotonic `version` is the number they roll back
-- to. A consent policy has no draft: `consent_policies` is one row per site and
-- `enabled` is already the live switch. So there is nothing to publish and
-- nothing to roll back to, and a counter would only buy a race — the tag
-- manager's `max(version) + 1` is an unguarded check-then-insert whose sole
-- guard is its unique index, and it surfaces as a raw driver violation rather
-- than an AppError. Keying on `(site_id, hash)` removes the race and makes a
-- repeated or reverted save a free no-op insert.
--
-- No foreign key on `site_id`, matching every table in this block: D1 runs with
-- foreign keys off, so a constraint that exists only on Postgres is a dialect
-- difference pretending to be an invariant. The cascade lives in
-- `services/consent.ts`, next to the ownership check that makes it safe.
--
-- Replay-safe: IF NOT EXISTS on both objects, and the column add is guarded.

CREATE TABLE IF NOT EXISTS "consent_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text NOT NULL,
  "hash" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consent_versions_site_hash_idx" ON "consent_versions" ("site_id","hash");--> statement-breakpoint
ALTER TABLE "consent_policies" ADD COLUMN IF NOT EXISTS "artifact_hash" text;
