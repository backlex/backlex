-- Role-scoped MCP guards. Until now the only tool-level restriction lived on an
-- API key (`api_keys.mcp_tools` / `mcp_read_only`), which meant the limit was a
-- property of the credential rather than of the person: mint a fresh key and the
-- restriction evaporated. These two columns move the same contract onto roles,
-- so an operator can say "support agents may only call the read tools" once.
--
-- Both default to the permissive value, so every existing role keeps behaving
-- exactly as it did before this migration.

ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "mcp_tools" jsonb;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "mcp_read_only" boolean DEFAULT false NOT NULL;
