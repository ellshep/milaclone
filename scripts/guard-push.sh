#!/bin/sh
# Claude Code PreToolUse hook (.claude/settings.json): blocks direct pushes and
# PR creation so every change ships through the no-mistakes gate. See
# CONTRIBUTING.md "Shipping a change".
cmd=$(jq -r '.tool_input.command // empty')
case "$cmd" in
  *no-mistakes*) exit 0 ;;
esac
if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])git push([^[:alnum:]_-]|$)|gh pr create'; then
  echo "Blocked: ship through the gate instead. Run /no-mistakes (or git push no-mistakes <branch>) from a treehouse worktree; see CONTRIBUTING.md 'Shipping a change'." >&2
  exit 2
fi
