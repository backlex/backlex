-- A visitor's decision, and what it was a decision about.
--
-- Append-only by construction: no `updated_at` column exists, the service has
-- no UPDATE path, and a visitor who changes their mind gets a new row — the
-- latest `created_at` for (site_id, subject_id) is the standing answer. Only
-- three things remove a row: the retention prune, the erasure surface, and the
-- visitor's own withdrawal. All three are removals; none is an edit.
--
-- `subject_id` is minted by the banner in first-party storage on the customer's
-- own origin, so it is caller-supplied and unauthenticated. It is a correlator
-- that lets a visitor be shown and withdraw their own decision; it proves
-- nothing about who they are.
--
-- `ip_hash` is a SALTED SHA-256, never the address. Storing the address would
-- make this table its own processing activity under GDPR while proving little:
-- `requestMeta` reads `cf-connecting-ip` first on every runtime and nothing in
-- the four entry points sets or strips it, so off Cloudflare it is whatever the
-- caller typed. An UNsalted digest would not help either — the IPv4 space is
-- 2^32 and enumerates in seconds.
--
-- `hash_grade` is `current` | `archived` | `unresolved`, resolved once at
-- ingest. "Which text did they agree to" has three answers, not two, and an
-- operator handing a regulator a consent log has to know which rows point at
-- something. An unknown hash never REFUSES the record — refusing does not
-- un-consent anyone, it only destroys the evidence.
--
-- No foreign key on `site_id` or `version_id`, matching every table in this
-- block: D1 runs with foreign keys off, so a constraint that exists only on
-- Postgres is a dialect difference pretending to be an invariant.
--
-- Replay-safe: IF NOT EXISTS on every object.

CREATE TABLE IF NOT EXISTS "consent_records" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "site_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "policy_hash" text,
  "version_id" text,
  "hash_grade" text NOT NULL,
  "decision" text NOT NULL,
  "grants" jsonb NOT NULL,
  "source" text NOT NULL,
  "locale" text,
  "country" text,
  "ip_hash" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_records_site_subject_idx" ON "consent_records" ("site_id","subject_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_records_tenant_subject_idx" ON "consent_records" ("tenant_id","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_records_tenant_created_idx" ON "consent_records" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_records_created_idx" ON "consent_records" ("created_at");
