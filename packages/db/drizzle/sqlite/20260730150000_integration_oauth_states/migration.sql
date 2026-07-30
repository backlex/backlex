-- In-flight OAuth authorization-code flows for workspace integrations.
--
-- `id` is the SHA-256 of the state parameter, not the parameter itself: reading
-- this table must not let anyone complete a pending authorization. Rows are
-- deleted the moment they are consumed, so a replayed callback finds nothing.
CREATE TABLE IF NOT EXISTS integration_oauth_states (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS integration_oauth_states_integration_idx
  ON integration_oauth_states (integration_id);--> statement-breakpoint
-- Sweeping expired rows is a range scan over this column.
CREATE INDEX IF NOT EXISTS integration_oauth_states_expires_idx
  ON integration_oauth_states (expires_at);
