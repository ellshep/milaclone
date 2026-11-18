#!/usr/bin/env bash
# Unattended deploy, run by the milaclone-deploy systemd timer (hourly).
#
#   scripts/autodeploy.sh
#
# Checks origin/main and, when it has moved, runs scripts/deploy.sh (which
# backs up, rebuilds and waits for the app). A commit that fails to deploy is
# tried once and then skipped until a newer commit lands on main, so a broken
# build isn't rebuilt every hour. Run scripts/deploy.sh by hand to retry it.
#
# Optional: set AUTODEPLOY_NOTIFY_URL (in .env.autodeploy, read by the systemd
# unit) to a webhook, e.g. Home Assistant's, to get a JSON POST after each
# deploy or failure: {"status":"deployed"|"failed","commit":"<sha>","host":"<name>"}.
set -euo pipefail

cd "$(dirname "$0")/.."

FAILED=.autodeploy-failed

# Never two timer runs at once (a slow build could overlap the next tick).
exec 9>.autodeploy.lock
if ! flock -n 9; then
  echo "Another auto-deploy is still running; skipping this run."
  exit 0
fi

notify() {
  [[ -n "${AUTODEPLOY_NOTIFY_URL:-}" ]] || return 0
  local body
  body=$(printf '{"status":"%s","commit":"%s","host":"%s"}' "$1" "$2" "$(hostname)")
  curl -fsS -m 10 -o /dev/null -H 'Content-Type: application/json' -d "$body" "$AUTODEPLOY_NOTIFY_URL" ||
    echo "warning: deploy notification to AUTODEPLOY_NOTIFY_URL failed" >&2
}

git fetch --quiet origin main
TARGET=$(git rev-parse origin/main)

# A manual scripts/deploy.sh may have deployed the failed commit since.
if [[ -f "$FAILED" && "$(cat .deployed 2>/dev/null || true)" == "$TARGET" ]]; then
  rm -f "$FAILED"
fi
if [[ -f "$FAILED" && "$(cat "$FAILED")" == "$TARGET" ]]; then
  echo "origin/main ${TARGET:0:7} failed to deploy earlier; waiting for a newer commit."
  echo "Fix it and push, or run scripts/deploy.sh by hand to retry this one."
  exit 0
fi

BEFORE=$(cat .deployed 2>/dev/null || true)
if scripts/deploy.sh; then
  rm -f "$FAILED"
  AFTER=$(cat .deployed 2>/dev/null || true)
  if [[ -n "$AFTER" && "$AFTER" != "$BEFORE" ]]; then
    notify deployed "$AFTER"
  fi
else
  status=$?
  # deploy.sh fetched again, so record the commit it actually tried.
  TRIED=$(git rev-parse origin/main)
  echo "$TRIED" >"$FAILED"
  echo "error: deploy of ${TRIED:0:7} failed; it will be skipped until a newer commit lands." >&2
  notify failed "$TRIED"
  exit "$status"
fi
