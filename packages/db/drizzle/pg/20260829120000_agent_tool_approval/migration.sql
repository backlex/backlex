-- A tool call an agent may not make without a person's yes.
--
-- Until now the boundary on an agent was what it COULD reach: its own
-- admin-authored tool list, the caller's permission rules, and (since the guard
-- fix) the caller's MCP allowlist. All three answer "is this allowed at all".
-- None of them can express "allowed, but not without someone looking" — which
-- is the shape every 2026 write-up of agent safety puts third on the list,
-- after tool allowlisting and identity binding.
--
-- `approval_tools` holds tool-name globs in the same grammar as an MCP
-- allowlist (`collections.delete`, `collections.*`, `*`). Empty is the default
-- and means no gate: an approval flow nobody configured must never start
-- silently refusing work on an existing agent.
--
-- `approvers` is who gets asked. It is a separate column rather than a lookup
-- because the people who sign off for an agent are not necessarily users of
-- this instance — the existing approvals service already addresses approvers by
-- email and hands each one a tokenised decision link.
--
-- Both default to empty, so every agent that exists today keeps behaving
-- exactly as it does.
--
-- Replayable: `IF NOT EXISTS`, because the boot-time runner re-applies every
-- migration file on every start.

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "approval_tools" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "approvers" jsonb NOT NULL DEFAULT '[]'::jsonb;
