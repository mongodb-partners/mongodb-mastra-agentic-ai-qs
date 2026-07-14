#!/usr/bin/env bash
# Redeploy the latest code onto an ALREADY-RUNNING box (an existing app box or any
# self-hosted host) WITHOUT Terraform. Counterpart to deploy.sh (which stands a box up from
# nothing): it pulls new code, rebuilds the container, and re-applies data (indexes + the
# committed recording).
#
#   deploy/scripts/redeploy.sh [user@host] [git-ref]
#   deploy/scripts/redeploy.sh ec2-user@1.2.3.4 main      # ref defaults to main
set -euo pipefail

HOST="${1:?usage: redeploy.sh user@host [git-ref]}"
REF="${2:-main}"
APP_DIR="/opt/app/src"
CONTAINER="marshal-app-1"   # compose project `marshal` (docker-compose.yml `name:`) → <project>-app-1

if [[ -t 1 ]]; then C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_0=$'\033[0m'; else C_G=; C_Y=; C_R=; C_B=; C_0=; fi
log()  { echo "${C_B}▸${C_0} $*"; }
ok()   { echo "${C_G}✓${C_0} $*"; }
warn() { echo "${C_Y}!${C_0} $*"; }
die()  { echo "${C_R}✗ $*${C_0}" >&2; exit 1; }

rsh() { ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$HOST" "$@"; }

echo "${C_B}=== redeploy ${REF} → ${HOST} ===${C_0}"
command -v ssh >/dev/null || die "ssh not found"
rsh 'command -v docker >/dev/null' || die "docker not found on $HOST"

# 1. Pull new code — fetch FIRST so reset lands on the true remote tip, not a stale cached ref.
log "fetching + resetting $APP_DIR to origin/$REF"
LANDED=$(rsh "cd '$APP_DIR' \
  && sudo git config --global --add safe.directory '$APP_DIR' 2>/dev/null; \
  sudo git fetch --depth 1 origin '$REF' \
  && sudo git reset --hard 'origin/$REF' \
  && sudo git log --oneline -1") || die "git update failed on $HOST"
ok "landed: $LANDED"

# 2. Rebuild + restart. Refresh the container .env from the box's SSM-seeded /opt/app/.env
#    first (a no-op if identical) so new env keys are present.
log "rebuilding + restarting containers (this can take a few minutes)"
rsh "cd '$APP_DIR' \
  && sudo cp /opt/app/.env src/.env 2>/dev/null || true; \
  sudo docker compose -f docker-compose.yml -f deploy/compose.nginx.yml up -d --build" \
  || die "docker compose build/up failed on $HOST"
ok "containers rebuilt"

# 3. Re-apply data (idempotent). The image build never provisions, so an index/corpus change
#    or a fresh recording is applied here. The app container carries the source + deps + .env.
log "re-provisioning indexes + restoring the recording (inside $CONTAINER)"
if rsh "sudo docker exec $CONTAINER sh -lc 'pnpm provision && pnpm restore:replay'"; then
  ok "data re-applied (indexes deduped, recording restored)"
else
  warn "data step via $CONTAINER failed — run it manually against the cluster:"
  warn "  MONGODB_URI=... MONGODB_DB=... VOYAGE_API_KEY=... pnpm provision && pnpm restore:replay"
fi

# 4. Health.
log "health check"
for i in $(seq 1 20); do
  if rsh 'curl -fsS localhost:8000/api/health >/dev/null 2>&1'; then ok "app healthy"; break; fi
  [[ $i -eq 20 ]] && warn "health did not pass after ~2.5 min; check: ssh $HOST 'sudo docker compose -f $APP_DIR/docker-compose.yml -f $APP_DIR/deploy/compose.nginx.yml logs app'"
  sleep 8
done

echo ""
ok "Redeploy done — $LANDED"
echo "   Open: http://${HOST#*@}/?tour=0"
