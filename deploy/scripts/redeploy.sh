#!/usr/bin/env bash
# Redeploy the latest code onto an ALREADY-RUNNING box (an existing app box or any
# self-hosted host) WITHOUT Terraform. Counterpart to deploy.sh (which stands a box up from
# nothing): it pulls new code, rebuilds the container, and re-applies data (indexes + the
# committed recording).
#
#   deploy/scripts/redeploy.sh [user@host] [git-ref]
#   deploy/scripts/redeploy.sh ec2-user@1.2.3.4 main      # ref defaults to main
#
# Assumes the deploy.sh layout: checkout at /opt/app/src, .env seeded at /opt/app/.env, and a DB
# user that can write. A box laid out differently (or running a read-only DB user, which makes
# `pnpm provision` fail on createIndexes) needs the steps run by hand.
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

# 0. Discover the box's compose layering. A TLS box keeps its override OUTSIDE this repo (the
#    checkout is frozen and kept git-clean), so the file list is a property of the HOST, not of
#    the source tree. Omitting it recreates nginx without :443 and the box silently drops to
#    plain HTTP — see /opt/app/src/READ-ME-BEFORE-COMPOSE.txt on the box.
TLS_OVERRIDE="/opt/marshal-tls/compose.tls.yml"
COMPOSE_FILES="-f docker-compose.yml -f deploy/compose.nginx.yml"
HAS_TLS=0
if rsh "test -f '$TLS_OVERRIDE'"; then
  COMPOSE_FILES="$COMPOSE_FILES -f $TLS_OVERRIDE"
  HAS_TLS=1
  ok "TLS override found — layering $TLS_OVERRIDE (keeps :443 up)"
fi

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
  sudo docker compose $COMPOSE_FILES up -d --build" \
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

# 4. Health. :8000 is the app container direct — it proves the app booted but says NOTHING about
#    the edge, because it bypasses nginx. On a TLS box that gap is the whole failure mode: nginx
#    recreated without the override answers :80 fine and :443 not at all, so an app-only check
#    reports a clean redeploy while the public URL is unreachable.
log "health check"
for i in $(seq 1 20); do
  if rsh 'curl -fsS localhost:8000/api/health >/dev/null 2>&1'; then ok "app healthy"; break; fi
  [[ $i -eq 20 ]] && warn "health did not pass after ~2.5 min; check: ssh $HOST 'sudo docker compose $COMPOSE_FILES logs app' (from $APP_DIR)"
  sleep 8
done

if [[ $HAS_TLS -eq 1 ]]; then
  log "edge check (through nginx, since :8000 cannot see a missing :443)"
  if rsh 'curl -fsS -k -o /dev/null -w "%{http_code}" https://localhost/api/health 2>/dev/null | grep -q 200'; then
    ok "TLS edge serving on :443"
  else
    die "app is up but :443 is NOT serving — nginx likely lost the TLS override. Recover with:
     ssh $HOST 'sudo /opt/marshal-tls/compose.sh up -d'"
  fi
fi

echo ""
ok "Redeploy done — $LANDED"
echo "   Open: $([[ $HAS_TLS -eq 1 ]] && echo https || echo http)://${HOST#*@}/?tour=0"
