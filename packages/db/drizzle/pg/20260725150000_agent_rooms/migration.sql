-- Agent chat rooms — a thread stops being pinned to one agent and becomes a
-- room several agents can answer in.
--
--  * `agents.handle`      — the stable `@`-mention token (name is free text).
--  * `agent_threads`      — `agent_id` goes nullable (null = a room), plus the
--                           routing mode for messages that mention nobody.
--  * `agent_thread_agents`— room membership.
--  * `agent_messages`     — `agent_id` says WHICH agent wrote an assistant row;
--                           without it a multi-agent transcript is unreadable.
--  * `agent_runs`         — one agent's turn, and the per-agent lock. The old
--                           lock was `agent_threads.status = 'running'`, which
--                           rejected a second agent in the same room; keying it
--                           on (thread, agent) lets them run in parallel.
--
-- Existing threads keep `agent_id` set and are switched to `routing='default'`
-- with that agent as the default, so they behave exactly as they did before.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "handle" text;--> statement-breakpoint

-- Backfill a mention handle from the name: lowercased, whitespace to dashes.
-- Unicode letters are kept (a Turkish-named agent gets a Turkish handle) —
-- mentions are matched against the known handle list, not a strict charset.
UPDATE "agents" SET "handle" = trim(both '-' from regexp_replace(lower("name"), '\s+', '-', 'g'))
 WHERE "handle" IS NULL OR "handle" = '';--> statement-breakpoint
UPDATE "agents" SET "handle" = 'agent-' || substr("id", 1, 8) WHERE "handle" IS NULL OR "handle" = '';--> statement-breakpoint
-- Two names that slugify the same would break the unique index below. Suffix
-- the later row (ordered by id, so the result is deterministic)…
UPDATE "agents" a SET "handle" = a."handle" || '-' || substr(a."id", 1, 4)
 WHERE EXISTS (
   SELECT 1 FROM "agents" b
   WHERE b."tenant_id" IS NOT DISTINCT FROM a."tenant_id"
     AND b."handle" = a."handle" AND b."id" < a."id"
 );--> statement-breakpoint
-- …and fall back to the id itself if even the suffixed handles collide, so the
-- index can never fail to build.
UPDATE "agents" a SET "handle" = 'agent-' || a."id"
 WHERE EXISTS (
   SELECT 1 FROM "agents" b
   WHERE b."tenant_id" IS NOT DISTINCT FROM a."tenant_id"
     AND b."handle" = a."handle" AND b."id" < a."id"
 );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_handle_idx" ON "agents" ("tenant_id","handle");--> statement-breakpoint

ALTER TABLE "agent_threads" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN IF NOT EXISTS "routing" text DEFAULT 'mention' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN IF NOT EXISTS "default_agent_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_threads_tenant_idx" ON "agent_threads" ("tenant_id");--> statement-breakpoint

-- A pre-rooms thread answered on every message; preserve that.
UPDATE "agent_threads" SET "routing" = 'default', "default_agent_id" = "agent_id"
 WHERE "agent_id" IS NOT NULL AND "default_agent_id" IS NULL;--> statement-breakpoint

ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
-- Assistant/tool rows on a pinned thread were all written by its one agent.
UPDATE "agent_messages" m SET "agent_id" = t."agent_id"
  FROM "agent_threads" t
 WHERE m."thread_id" = t."id" AND m."agent_id" IS NULL
   AND m."role" <> 'user' AND t."agent_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_thread_agents" (
  "tenant_id" text,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_thread_agents_pk" ON "agent_thread_agents" ("thread_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_thread_agents_agent_idx" ON "agent_thread_agents" ("agent_id");--> statement-breakpoint

-- Every existing thread becomes a one-participant room.
INSERT INTO "agent_thread_agents" ("tenant_id","thread_id","agent_id")
SELECT "tenant_id","id","agent_id" FROM "agent_threads" WHERE "agent_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" text PRIMARY KEY,
  "tenant_id" text,
  "thread_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "job_id" text,
  "status" text NOT NULL DEFAULT 'queued',
  "started_by" text,
  "trigger_message_id" text,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_thread_idx" ON "agent_runs" ("thread_id","created_at");--> statement-breakpoint
-- The per-agent lock. Partial, so finished runs never block the next turn.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_active_idx" ON "agent_runs" ("thread_id","agent_id")
  WHERE "status" in ('queued','running');
