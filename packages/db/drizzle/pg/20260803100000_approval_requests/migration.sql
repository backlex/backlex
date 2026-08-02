-- Approvals — a record that cannot move until a named human decides.
--
-- Fourteen of the twenty-six schema templates carry a collection whose status
-- goes `pending → approved | rejected`. Every one of them was hand-rolled the
-- same way, and the part that was always missing is the evidence: who decided,
-- in what capacity, when, and why.
--
-- `status` here is WRITTEN on expiry, unlike `signature_requests` where expiry
-- is derived from `expires_at` and nothing has to run. The difference is that
-- expiring an approval has a CONSEQUENCE — a flow parked in `continuation` has
-- to be resumed down its rejected branch — and a status nobody ever writes
-- would leave that continuation parked forever.
CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "title" text NOT NULL,
  "message" text,
  "subject_collection" text,
  "subject_id" text,
  "summary" jsonb,
  "policy" text DEFAULT 'all' NOT NULL,
  "quorum" integer DEFAULT 1 NOT NULL,
  "ordered" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "continuation" jsonb,
  "timeout_task_id" text,
  "write_back" jsonb,
  "notify_emails" jsonb,
  "expires_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "outcome_reason" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_tenant_idx"
  ON "approval_requests" ("tenant_id");
--> statement-breakpoint
-- The admin list is "this workspace's outstanding requests", so status rides
-- along with the tenant rather than being indexed on its own.
CREATE INDEX IF NOT EXISTS "approval_requests_status_idx"
  ON "approval_requests" ("tenant_id", "status");
--> statement-breakpoint
-- "Is there already an approval open on this row?" is asked on every write to
-- a gated collection, so the subject gets its own index.
CREATE INDEX IF NOT EXISTS "approval_requests_subject_idx"
  ON "approval_requests" ("subject_collection", "subject_id");
--> statement-breakpoint
-- One row per approver: a leave request goes to a line manager AND to HR, and
-- each needs their own link, their own timestamp and their own reason.
CREATE TABLE IF NOT EXISTS "approval_approvers" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "role" text,
  "order_index" integer DEFAULT 0 NOT NULL,
  "token_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "sent_at" timestamp with time zone,
  "viewed_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "reason" text,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The token is the whole grant, so the lookup is by its hash and it must be
-- unique — two approvers sharing a token would let either decide as the other.
CREATE UNIQUE INDEX IF NOT EXISTS "approval_approvers_token_idx"
  ON "approval_approvers" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_approvers_request_idx"
  ON "approval_approvers" ("request_id", "order_index");
