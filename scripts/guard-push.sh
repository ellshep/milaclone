#!/bin/sh
# Claude Code PreToolUse hook (.claude/settings.json): blocks direct pushes and
# PR creation so every change ships through the no-mistakes gate. See
# CONTRIBUTING.md "Shipping a change".
if jq -e '
  def blocked:
    (.[0:2] == ["git", "push"] and .[2] != "no-mistakes")
    or .[0:3] == ["gh", "pr", "create"];

  (.tool_input.command // "")
  | reduce scan("#[^\n]*|[;&|()\n]|(?:[^ \t\n;&|()\\\\\u0027\"]|\\\\.|\u0027[^\u0027]*\u0027|\"(?:[^\"\\\\]|\\\\.)*\")+") as $token (
      {words: [], denied: false};
      if $token | test("^[;&|()\n]$") then
        {words: [], denied: (.denied or (.words | blocked))}
      elif ($token | startswith("#")) or (.words | length >= 3) then
        .
      else
        .words += [$token | sub("^[\u0027\"](?<literal>[a-z-]+)[\u0027\"]$"; "\(.literal)")]
      end
    )
  | .denied or (.words | blocked)
' >/dev/null; then
  echo "Blocked: ship through the gate instead. Run /no-mistakes (or git push no-mistakes <branch>) from a treehouse worktree; see CONTRIBUTING.md 'Shipping a change'." >&2
  exit 2
fi
