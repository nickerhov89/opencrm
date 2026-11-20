#!/bin/sh
# Runs on the server as the forced command of the GitHub Actions deploy key
# (authorized_keys: command="/opt/opencrm-deploy/deploy.sh",restrict ssh-ed25519 ...).
# Reads a tar.gz of the repository on stdin, syncs it into /opt/opencrm (keeping .env)
# and rebuilds/restarts the compose project. Install: copy to /opt/opencrm-deploy/deploy.sh, chmod 755.
set -eu
APP=/opt/opencrm
BASE=/opt/opencrm-deploy
PROJECT=opencrm
LOG="$BASE/deploy.log"

exec 9>"$BASE/deploy.lock"
flock -w 600 9 || { echo "Другой деплой ещё идёт" >&2; exit 1; }

STAGE=$(mktemp -d "$BASE/release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG" >&2; }

# At most 200 MB of compressed code.
head -c 209715200 | tar -xz -C "$STAGE" --no-same-owner --no-same-permissions
test -f "$STAGE/compose.yaml" && test -f "$STAGE/server/index.js" || { log "Архив без compose.yaml/server — отмена"; exit 1; }
REV=$(cat "$STAGE/.revision" 2>/dev/null || echo unknown)
log "Деплой $REV"

rsync -a --delete --exclude=/.env --exclude=/.revision "$STAGE"/ "$APP"/
echo "$REV" > "$APP/.revision"
cd "$APP"
docker compose -p "$PROJECT" build --pull 2>&1 | tail -5 >&2
docker compose -p "$PROJECT" up -d --remove-orphans 2>&1 | tail -5 >&2

i=0
while [ $i -lt 60 ]; do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-opencrm-1" 2>/dev/null || echo missing)
  [ "$STATUS" = healthy ] && break
  i=$((i+1)); sleep 3
done
if [ "$STATUS" != healthy ]; then
  log "CRM не поднялась ($STATUS) после $REV"
  docker compose -p "$PROJECT" logs --tail 40 opencrm >&2
  exit 1
fi
# Remove old OpenCRM image layers left untagged by the rebuild (other projects are not touched).
docker image prune -f --filter label=org.opencontainers.image.title=opencrm >/dev/null 2>&1 || true
log "Готово $REV"
