-- The cookie-consent policy a site publishes.
--
-- `site_id` is the PRIMARY KEY, not a unique column beside a synthetic `id`.
-- "Exactly one consent policy per site" is a real invariant, and encoding it in
-- the key means an upsert is one atomic `ON CONFLICT (site_id)` rather than a
-- check-then-insert that loses to a concurrent writer — a race this repo has
-- already shipped once, where it surfaced as an intermittent 500.
--
-- `undecided_behaviour` and `tracker_category` are NOT NULL with NO DEFAULT,
-- and that is the point. Both encode a compliance posture where neither answer
-- is safe to pick on an operator's behalf (see the schema comment and
-- `services/captcha.ts` for the same reasoning applied to `onError`). A column
-- default here would be a legal position nobody chose, applied silently.
--
--   undecided_behaviour  'block'  — nothing optional fires until the visitor
--                                   decides. Correct under GDPR/ePrivacy.
--                        'allow'  — optional fires until they decline. The
--                                   CCPA/CPRA model; NOT lawful in the EU.
--   tracker_category     'none'      — backlex's own cookieless tag is treated
--                                      as strictly necessary.
--                        'analytics' — it is gated like any other tag.
--
-- No FK to `analytics_sites`: the rest of the analytics schema declares none
-- either (D1 has foreign keys off by default, so a constraint that exists only
-- on Postgres is a dialect difference pretending to be an invariant).
--
-- Replay safety: `IF NOT EXISTS` throughout.

CREATE TABLE IF NOT EXISTS "consent_policies" (
  "site_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "categories_offered" jsonb,
  "undecided_behaviour" text NOT NULL,
  "tracker_category" text NOT NULL,
  "wording" jsonb,
  "default_locale" text DEFAULT 'en' NOT NULL,
  "policy_url" text,
  "position" text DEFAULT 'bottom' NOT NULL,
  "theme" jsonb,
  "cookie_max_age_days" integer DEFAULT 180 NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_policies_tenant_idx" ON "consent_policies" ("tenant_id");
