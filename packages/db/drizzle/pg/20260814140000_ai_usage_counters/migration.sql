-- AI usage joins the ledger.
--
-- `usage_counters` measured requests, errors, stored bytes and row counts —
-- everything the product spends EXCEPT the one thing that costs per call. A
-- workspace could not answer "how much AI did I use this month", and neither
-- could a plan limit.
--
-- Four columns rather than one, because the two generation paths do not measure
-- the same quantity and pretending otherwise would produce a number nobody can
-- reconcile with a bill:
--
--   * `ai_calls`     — generations. The only figure BOTH paths always have.
--   * `ai_tokens_in`
--   * `ai_tokens_out`— the direct-provider path, which reports tokens.
--   * `ai_neurons`   — the managed-cloud gateway, which meters in neurons and
--                      does not return token counts at all.
--
-- Deliberately NOT a subset of `requests`: a flow step, an agent turn and a
-- sync hook each generate without a request of their own, so AI usage is not
-- derivable from the request count no matter how it is sliced.
--
-- Every statement is additive with a NOT NULL DEFAULT 0, so existing rows read
-- as "no AI recorded" rather than NULL, and a replay fails on "duplicate
-- column" — which `auto-migrate.ts` tolerates by design.

ALTER TABLE "usage_counters" ADD COLUMN IF NOT EXISTS "ai_calls" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN IF NOT EXISTS "ai_tokens_in" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN IF NOT EXISTS "ai_tokens_out" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN IF NOT EXISTS "ai_neurons" bigint NOT NULL DEFAULT 0;
