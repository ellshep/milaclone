#!/usr/bin/env bash
# Pull the latest origin/main and redeploy it to Docker.
#
#   scripts/deploy.sh          # skips the rebuild when the running app is already this commit
#   scripts/deploy.sh --force  # rebuild and restart anyway
#
# "Already deployed" means the commit recorded in .deployed (written after the
# last successful deploy) matches HEAD and the app is answering, so a manual
# `git pull` before running this can't make it skip a needed rebuild.
# Before rebuilding it saves a database snapshot (/api/backup) to backups/,
# keeping the newest 10. Uploads live in their own volume and aren't included.
set -euo pipefail

cd "$(dirname "$0")/.."

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "error: on branch '$BRANCH', switch to main first" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "error: uncommitted changes to tracked files; commit or stash them first" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

echo "==> Fetching origin"
git fetch --prune origin

OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)

if [[ "$OLD" != "$NEW" ]]; then
  echo "==> Pulling ${OLD:0:7}..${NEW:0:7}"
  git log --oneline "$OLD..$NEW"
  git merge --ff-only origin/main
fi

STATE=.deployed
DEPLOYED=$(cat "$STATE" 2>/dev/null || true)
answering() { curl -fsS -o /dev/null http://127.0.0.1:8182/; }

if [[ "$DEPLOYED" == "$NEW" && "$FORCE" -eq 0 ]] && answering; then
  echo "Already deployed at ${NEW:0:7}; nothing to do (use --force to rebuild anyway)."
  exit 0
fi
if [[ -n "$DEPLOYED" && "$DEPLOYED" != "$NEW" ]]; then
  echo "==> Running app is ${DEPLOYED:0:7}; deploying ${NEW:0:7}"
fi

# Snapshot the database before the new code (and any boot-time migration) runs.
# Skipped only when nothing is answering yet, e.g. the very first deploy.
BACKUP_DIR=backups
KEEP=10
if answering; then
  mkdir -p "$BACKUP_DIR"
  PREV=${DEPLOYED:0:7}
  BACKUP="$BACKUP_DIR/board-$(date +%Y%m%d-%H%M%S)-${PREV:-unknown}.db"
  echo "==> Backing up the database to $BACKUP"
  curl -fsS -o "$BACKUP" http://127.0.0.1:8182/api/backup
  if [[ "$(head -c 15 "$BACKUP")" != "SQLite format 3" ]]; then
    echo "error: backup is not a SQLite database; not deploying" >&2
    rm -f "$BACKUP"
    exit 1
  fi
  ls -1t "$BACKUP_DIR"/board-*.db | tail -n +$((KEEP + 1)) | xargs -r rm -f
else
  echo "==> App not running; skipping the database backup"
fi

echo "==> Building and restarting containers"
docker compose up -d --build --remove-orphans

echo "==> Waiting for the app on http://127.0.0.1:8182"
for _ in $(seq 1 30); do
  if answering; then
    git rev-parse HEAD >"$STATE"
    echo "Deployed $(git rev-parse --short HEAD) and the app is answering."
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

echo "error: app did not answer within 60s; recent logs:" >&2
docker compose logs --tail=50 app >&2
exit 1
