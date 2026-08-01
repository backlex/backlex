#!/bin/bash
set -uo pipefail

# PreToolUse(Bash) hook — hold the first `git commit` attempt for each distinct
# working-tree diff so the security review happens BEFORE the commit lands.
#
# Reads the hook payload on stdin, and for a commit command:
#   1. hashes the staged + unstaged diff,
#   2. on a hash it has not seen, records it and DENIES the tool call with the
#      review instructions (this is what puts the reminder in Claude's context),
#   3. on a hash it has already seen, stays out of the way — so the retry after
#      the review goes through untouched.
#
# Changing files during the review changes the hash, so the new diff is gated
# once more. State lives in the shared git dir, so worktrees share one ledger.

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

# Match `git commit` at a command boundary — not `git log --grep=commit` etc.
printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|&&|\|\|)[[:space:]]*git( +-[^ ]+)* +commit([[:space:]]|$)' || exit 0

diff=$(git diff --cached; git diff)
[ -n "$diff" ] || exit 0

hash=$(printf '%s' "$diff" | shasum | cut -d' ' -f1)
git_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
state="$git_dir/claude-security-reviewed"

# Already gated this exact diff — let the commit through.
grep -qxF "$hash" "$state" 2>/dev/null && exit 0

printf '%s\n' "$hash" >>"$state"
# Keep the ledger bounded.
if [ "$(wc -l <"$state")" -gt 200 ]; then
  tail -n 100 "$state" >"$state.tmp" && mv "$state.tmp" "$state"
fi

reason='Security review gate: this diff has not been security-reviewed yet.

Review the FULL diff about to be committed (`git diff --cached` plus any unstaged changes, or run /security-review) before committing. Look for the classes that have actually shipped in this repo: cross-tenant leakage (missing tenant scoping in a query), fail-open auth/permission arms, path traversal, stored XSS, secrets or tokens in logs/responses, and raw SQL built from user input.

Then re-run the exact same commit command — this gate fires once per distinct diff, so the retry will go through. If the review turns up problems, fix them first (that changes the diff, and the new diff gets gated once more).

NOTE: this denial drops the WHOLE command, so anything chained ahead of the commit never ran either. If you used `git add … && git commit …`, nothing is staged now and the retry will fail with "no changes added to commit". Stage in a separate call, then commit on its own.'

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  },
  systemMessage: "Security review gate: commit held for one pass over this diff."
}'
exit 0
