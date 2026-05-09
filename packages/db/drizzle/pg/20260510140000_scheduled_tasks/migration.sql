-- Persistent queue for delayed flow continuations.
--
-- Long delays (> 30s) on a `delay` flow op are persisted here and the
-- scheduler resumes them on its next tick whose clock has caught up.
-- `claimed_at` is the idempotency hook — atomic `UPDATE ... WHERE
-- claimed_at IS NULL ... RETURNING *` lets a single tick win each row.

CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
  "id" text PRIMARY KEY,
  "tenant_id" text,
  "flow_id" text,
  "payload" jsonb NOT NULL,
  "run_at" timestamptz NOT NULL,
  "claimed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "scheduled_tasks_run_idx"
  ON "scheduled_tasks" ("run_at", "claimed_at");
CREATE INDEX IF NOT EXISTS "scheduled_tasks_flow_idx"
  ON "scheduled_tasks" ("flow_id");
