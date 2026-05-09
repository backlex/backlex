-- Persistent queue for delayed flow continuations. Mirrors the pg
-- migration; SQLite uses INTEGER for unix-ms timestamps.

CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
  "id" text PRIMARY KEY,
  "tenant_id" text,
  "flow_id" text,
  "payload" text NOT NULL,
  "run_at" integer NOT NULL,
  "claimed_at" integer,
  "created_at" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "scheduled_tasks_run_idx"
  ON "scheduled_tasks" ("run_at", "claimed_at");
CREATE INDEX IF NOT EXISTS "scheduled_tasks_flow_idx"
  ON "scheduled_tasks" ("flow_id");
