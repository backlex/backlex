-- Auth hooks — the app taking part in its own end-users' authentication.
--
-- `sync_hooks` lets an app participate in an item write; flow triggers see
-- item / cron / manual / webhook events. Neither can reach the four moments
-- that decide who an end-user IS: nothing could put `plan` or `tenant` into an
-- access token, veto a sign-up on the app's own rules, react to a password
-- check, or deliver an auth mail through the app's own transport.
--
-- Scoped to the workspace (app) plane on purpose. `tenant_id` is NOT NULL —
-- unlike `sync_hooks`, there is no instance-wide spelling at all, because a
-- hook on the platform plane would let one customer of a managed instance
-- observe and veto the operator sign-ins of the instance they live on.
--
-- One hook per (workspace, event): each event carries a different payload and
-- a different verdict, and two hooks answering `custom-access-token` would
-- fight over the same claim. Chaining belongs in the app's own endpoint.
--
-- `target_type` is `url` (an HTTPS endpoint called with Standard Webhooks
-- headers) or `function` (a backlex function run in the sandbox). The second
-- exists for `custom-access-token`, which sits on the token mint path where a
-- network round trip is the dominant cost.
--
-- Re-runnable: every statement is IF NOT EXISTS, so the boot runner replaying
-- this file is a no-op.

CREATE TABLE IF NOT EXISTS "auth_hooks" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "target_type" text NOT NULL,
  "url" text,
  "function_name" text,
  "secret" text,
  "headers" jsonb,
  "timeout_ms" integer DEFAULT 2000 NOT NULL,
  "on_error" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_failure_at" timestamp with time zone,
  "disabled_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_hooks_tenant_event_idx"
  ON "auth_hooks" ("tenant_id","event");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_hooks_tenant_idx"
  ON "auth_hooks" ("tenant_id");
