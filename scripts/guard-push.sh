#!/bin/sh
# Claude Code PreToolUse hook (.claude/settings.json). The scanner checks
# leading words in shell segments to catch direct pushes and PR creation.
# See CONTRIBUTING.md "Shipping a change" for the shipping rule.
# Claude Code cloud sessions (CLAUDE_CODE_REMOTE=true) can't run Treehouse or
# the gate, so they are exempt: they push and open PRs directly, and CI is the gate.
[ "$CLAUDE_CODE_REMOTE" = "true" ] && exit 0
if jq -e '
  def push_remote:
    if length == 0 then null
    elif .[0] == "--" then .[1]
    elif .[0] | test("^(--(repo|push-option|receive-pack|exec|recurse-submodules)|-[vqdnfu46]*o)$") then
      .[2:] | push_remote
    elif .[0] | startswith("-") then .[1:] | push_remote
    else .[0]
    end;

  def blocked:
    (.[0:2] == ["git", "push"] and (.[2:] | push_remote) != "no-mistakes")
    or .[0:3] == ["gh", "pr", "create"];

  (.tool_input.command // "")
  | reduce scan("#[^\n]*|[;&|()\n]|(?:[^ \t\n;&|()\\\\\u0027\"]|\\\\.|\u0027[^\u0027]*\u0027|\"(?:[^\"\\\\]|\\\\.)*\")+") as $token (
      {words: [], denied: false};
      if $token | test("^[;&|()\n]$") then
        {words: [], denied: (.denied or (.words | blocked))}
      elif $token | startswith("#") then
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
