#!/bin/bash
set -euo pipefail

# SessionStart hook for Claude Code on the web.
# Installs Bun workspace dependencies so tests, linters and typecheck
# are runnable in remote sessions.

# Only run in remote (Claude Code on the web) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Bun monorepo — install all workspace deps (idempotent, cache-friendly).
bun install
