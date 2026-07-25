-- Per-agent reasoning effort (`low` | `medium` | `high`; null = the provider
-- default). Lower effort means fewer thinking tokens and fewer, more
-- consolidated tool calls — the cheapest quality/cost dial an operator has.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "effort" text;
