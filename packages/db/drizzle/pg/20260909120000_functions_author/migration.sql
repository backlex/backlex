-- Who authored a function, and which side of the operator boundary they were on.
--
-- `functions` recorded `tenant_id` and nothing else, which is why the soft
-- sandbox had to be a DEPLOYMENT flag: `FUNCTIONS_SANDBOX=bun-worker` grants
-- host access — `node:fs`, `node:process`, `Bun.spawnSync` — to every function
-- on the instance, because nothing in the schema could say which of them the
-- operator wrote. On a multi-tenant self-host, "author a function" and "run
-- commands on the API host" were the same permission. #335.
--
-- `author_kind` is 'operator' / 'tenant', decided at write time by
-- `isInstanceOperator` — deliberately NOT the workspace `admin` role, which
-- `POST /api/tenants` grants to whoever creates a workspace.
--
-- BOTH COLUMNS ARE NULLABLE WITH NO DEFAULT, AND THAT IS THE BACKFILL DECISION.
-- Backfilling to 'tenant' is the safe-sounding label and would drop every
-- existing function on a `bun-worker` deployment to the in-isolate sandbox,
-- which has no host I/O at all — so the upgrade would break working code on the
-- strength of a value nobody wrote. Backfilling to 'operator' asserts something
-- untrue about rows nobody can now attribute. NULL says what is actually known,
-- keeps those rows on the behaviour they have today, and lets the run path name
-- them in a warning instead of guessing.
--
-- Replayable: `IF NOT EXISTS` on both, because the boot-time runner re-applies
-- every migration file on every start.

ALTER TABLE "functions" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
ALTER TABLE "functions" ADD COLUMN IF NOT EXISTS "author_kind" text;
