-- Per-key MCP metadata. Two columns, both nullable / defaulted so existing
-- rows pre-MCP keep their previous behaviour (every tool exposed; writes
-- allowed when permissions allow).
--   mcp_tools     — JSONB array of allowed tool names, or NULL = all tools.
--   mcp_read_only — when true, the MCP layer refuses every write tool (insert
--                   / update / delete / grant / revoke / invoke / assign) for
--                   requests authenticated with this key. The REST surface
--                   for the same identity stays open.
ALTER TABLE api_keys ADD COLUMN mcp_tools JSONB;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN mcp_read_only BOOLEAN NOT NULL DEFAULT false;
