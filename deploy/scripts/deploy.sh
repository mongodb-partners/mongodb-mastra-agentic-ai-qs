#!/usr/bin/env bash
# One-command deploy of Marshal: AWS (VPC/EC2/SSM/IAM) + MongoDB Atlas M10 + VPC peering.
#
#   TF_VAR_atlas_public_key=... TF_VAR_atlas_private_key=... TF_VAR_atlas_org_id=... \
#   TF_VAR_voyage_api_key=... deploy/scripts/deploy.sh
#
# Reads non-secret config from deploy/terraform/terraform.tfvars (copy the .example).
# Secrets come from TF_VAR_* env or a gitignored terraform.tfvars. Pass --yes to skip
# the apply confirmation. Deploys DEMO mode by default (no LLM at runtime); the data
# bootstrap loads the corpus + the committed recording, so the box needs no LLM to run.
set -euo pipefail

# ── paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
TF_DIR="$DEPLOY_DIR/terraform"
LOG="$DEPLOY_DIR/deploy.log"
: > "$LOG"

# Persisted generated secrets (gitignored). The Atlas DB password and the app's audit/session
# secrets are generated once and stored here so every subsequent run — and any bare
# `terraform apply` that sources this — reuses the SAME values. Without this a re-apply would
# see them empty and reset the DB user / rotate the audit chain key. Sourced early.
SECRETS_FILE="$DEPLOY_DIR/.deploy-secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  set -a; # shellcheck disable=SC1090
  . "$SECRETS_FILE"; set +a
fi

AUTO_YES=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && AUTO_YES=true

# ── output helpers (color only on a TTY; everything also tee'd to the log) ──────
if [[ -t 1 ]]; then C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_0=$'\033[0m'; else C_G=; C_Y=; C_R=; C_B=; C_0=; fi
log()  { echo "${C_B}▸${C_0} $*" | tee -a "$LOG"; }
ok()   { echo "${C_G}✓${C_0} $*" | tee -a "$LOG"; }
warn() { echo "${C_Y}!${C_0} $*" | tee -a "$LOG"; }
die()  { echo "${C_R}✗ $*${C_0}" | tee -a "$LOG" >&2; exit 1; }

tf() { terraform -chdir="$TF_DIR" "$@"; }

# ── read a var from terraform.tfvars (non-secret config) ────────────────────────
tfvar() {
  local key="$1" f="$TF_DIR/terraform.tfvars"
  [[ -f "$f" ]] || return 0
  grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" "$f" 2>/dev/null \
    | sed -E "s/^[^=]*=[[:space:]]*//; s/^\"//; s/\"[[:space:]]*(#.*)?$//; s/[[:space:]]*(#.*)?$//" || true
}

# ── generate + persist a secret TF_VAR once (reused on later runs) ───────────────
persist_secret() {
  local varname="$1" value="$2"
  umask 077
  echo "TF_VAR_${varname}=${value}" >> "$SECRETS_FILE"
}

# ── CIDRs don't overlap (peering breaks silently if they do) ────────────────────
assert_no_overlap() {
  local a="$1" b="$2"
  local oa=${a%%.*} ob=${b%%.*}
  [[ "$oa" != "$ob" ]] || die "atlas_cidr ($a) and vpc_cidr ($b) may overlap (same first octet). Pick non-overlapping ranges."
}

# ── vpc_cidr must not collide with an EXISTING peer in the (possibly shared) Atlas project ──
# Atlas rejects a second peer whose route_table_cidr_block duplicates an existing one
# (HTTP 409 OVERLAPPING_CIDR_BLOCK) — a reused/shared project may already peer our chosen CIDR
# from another stack. terraform surfaces this only mid-apply (after ~11 min of cluster build), so
# probe the project's existing AWS peers up front and fail fast with a fix. Requires the Atlas API
# keys + a project id; best-effort (skips quietly if the API is unreachable — apply still guards it).
assert_no_atlas_peer_overlap() {
  local vpc_cidr="$1" proj="${TF_VAR_atlas_project_id:-$(tfvar atlas_project_id)}"
  [[ -n "$proj" ]] || return 0   # creating a NEW project ⇒ no pre-existing peers
  [[ -n "${TF_VAR_atlas_public_key:-}" && -n "${TF_VAR_atlas_private_key:-}" ]] || return 0
  # Skip on a RE-RUN of this stack: if our own peering is already in state, the existing peer at
  # vpc_cidr is ours, not a collision. Only fresh deploys (no peering in state) need this guard.
  if tf state list 2>/dev/null | grep -q '^mongodbatlas_network_peering\.aws'; then
    return 0
  fi
  local resp existing
  resp=$(curl -s --max-time 20 --user "${TF_VAR_atlas_public_key}:${TF_VAR_atlas_private_key}" --digest \
    "https://cloud.mongodb.com/api/atlas/v2/groups/${proj}/peers?providerName=AWS" \
    -H "Accept: application/vnd.atlas.2023-11-15+json" 2>/dev/null) || return 0
  # Non-JSON (auth error / rate limit) ⇒ skip; the apply-time 409 guard remains the backstop.
  echo "$resp" | jq -e . >/dev/null 2>&1 || return 0
  existing=$(echo "$resp" | jq -r '.results[]?.routeTableCidrBlock // empty' 2>/dev/null)
  if echo "$existing" | grep -qxF "$vpc_cidr"; then
    die "vpc_cidr ($vpc_cidr) is ALREADY peered by another stack in Atlas project $proj. Atlas 409s on a duplicate peer CIDR (this fails ~11 min into apply). Pick a different vpc_cidr/subnet_cidr in terraform.tfvars (existing peer CIDRs: $(echo "$existing" | paste -sd, -))."
  fi
  ok "vpc_cidr $vpc_cidr does not collide with existing Atlas peers"
}

# ────────────────────────────────────────────────────────────────────────────────
# 1. PREFLIGHT
# ────────────────────────────────────────────────────────────────────────────────
preflight() {
  log "preflight"
  for bin in terraform aws jq ssh curl; do command -v "$bin" >/dev/null || die "missing required tool: $bin"; done
  command -v pnpm >/dev/null || warn "pnpm not found — the data-bootstrap step (provision/restore) will be skipped; run it manually later."

  aws sts get-caller-identity >/dev/null 2>&1 || die "AWS credentials not configured (aws sts get-caller-identity failed)."
  local acct; acct=$(aws sts get-caller-identity --query Account --output text)
  ok "AWS account $acct"

  local create; create=$(tfvar create_atlas_cluster); create=${create:-true}

  # Required inputs by mode.
  if [[ "$create" == "true" ]]; then
    [[ -n "${TF_VAR_atlas_public_key:-}"  ]] || die "TF_VAR_atlas_public_key is required (create mode)."
    [[ -n "${TF_VAR_atlas_private_key:-}" ]] || die "TF_VAR_atlas_private_key is required (create mode)."
    [[ -n "${TF_VAR_atlas_project_id:-}" || -n "$(tfvar atlas_project_id)" || -n "${TF_VAR_atlas_org_id:-}" ]] || die "Set TF_VAR_atlas_project_id (deploy into an existing project) or TF_VAR_atlas_org_id (create a new project, needs the Project-Creator org role)."
    assert_no_overlap "$(tfvar atlas_cidr | grep -o '[0-9.]*/[0-9]*' || echo 192.168.248.0/21)" "$(tfvar vpc_cidr | grep -o '[0-9.]*/[0-9]*' || echo 10.0.0.0/16)"
    assert_no_atlas_peer_overlap "$(tfvar vpc_cidr | grep -o '[0-9.]*/[0-9]*' || echo 10.0.0.0/16)"
  else
    [[ -n "${TF_VAR_mongodb_uri_byo:-}" ]] || die "create_atlas_cluster=false requires TF_VAR_mongodb_uri_byo (a replica-set URI — Marshal uses change streams)."
  fi
  [[ -n "${TF_VAR_voyage_api_key:-}" ]] || die "TF_VAR_voyage_api_key is required (used to embed the corpus at provision time)."

  # App repo must be ANONYMOUSLY cloneable: the EC2 box clones it over HTTPS with no credentials
  # (userdata.sh: git clone <url>). If the repo is private, that clone fails with "could not read
  # Username for 'https://github.com'" and the box comes up with no app. Probe the exact repo+ref
  # from here with credential prompts disabled, so a private/typo'd repo fails fast (before ~15 min
  # of provisioning) instead of on the box. Only meaningful for https:// URLs.
  local repo ref; repo=$(tfvar app_repo_url); repo=${repo:-https://github.com/mongodb-partners/mongodb-mastra-agentic-ai-qs.git}
  ref=$(tfvar app_repo_ref); ref=${ref:-main}
  if [[ "$repo" == https://* ]]; then
    if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true git ls-remote "$repo" "$ref" >/dev/null 2>&1; then
      ok "app repo reachable anonymously ($repo @ $ref)"
    else
      die "app repo not anonymously cloneable: $repo @ $ref. The EC2 box clones with no credentials, so the repo must be PUBLIC and the ref must exist. Make it public (or point app_repo_url at a public mirror) and re-run."
    fi
  fi

  # admin_cidr: auto-detect the deploy machine's public IP as /32 if not set.
  if [[ -z "${TF_VAR_admin_cidr:-}" && -z "$(tfvar admin_cidr)" ]]; then
    local ip; ip=$(curl -fsS https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
    [[ -n "$ip" ]] || die "Could not auto-detect your public IP; set admin_cidr in tfvars or TF_VAR_admin_cidr."
    export TF_VAR_admin_cidr="${ip}/32"
    warn "admin_cidr auto-detected as $TF_VAR_admin_cidr (SSH + Atlas provision access)."
  fi

  # Atlas DB password: generate an alphanumeric one (avoids URL-encoding) ONCE and persist it.
  if [[ "$create" == "true" && -z "${TF_VAR_atlas_db_password:-}" && -z "$(tfvar atlas_db_password)" ]]; then
    export TF_VAR_atlas_db_password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28)
    [[ -f "$SECRETS_FILE" ]] || echo "# Generated by deploy.sh — DO NOT COMMIT. Reused across runs so credentials stay stable." > "$SECRETS_FILE"
    persist_secret atlas_db_password "$TF_VAR_atlas_db_password"
    ok "generated Atlas DB password (28 alnum chars) → deploy/.deploy-secrets.env"
  fi

  # App HMAC secrets (audit chain + session tokens). Generate + persist once so the audit
  # chain key and session signing key stay stable across re-applies (a rotated audit secret
  # would make the existing chain fail verification). Kept SEPARATE — neither can forge the other.
  #
  # AUDIT_SECRET is DEMO-MODE-AWARE. The committed demo recording (data/replay/) was baked with
  # the app's dev fallback secret (config.ts DEV_AUDIT_SECRET); a demo box replays that recording
  # and verifies its audit chain. Injecting a freshly generated secret would make every replayed
  # link fail HMAC verification → a false "AUDIT CHAIN BROKEN" alarm on a box that isn't tampered.
  # So in demo mode we deliberately leave AUDIT_SECRET unset and let the app fall back to the same
  # dev secret the recording carries. Live mode (no recording) still gets a generated secret.
  local demo; demo=$(tfvar demo_mode); demo=${demo:-1}
  if [[ "$demo" == "1" || "$demo" == "true" ]]; then
    if [[ -n "${TF_VAR_audit_secret:-}" ]]; then
      warn "demo mode: ignoring the provided AUDIT_SECRET — the box must verify the committed recording with the secret it was baked with (app dev fallback). Unsetting."
      unset TF_VAR_audit_secret
    fi
    ok "demo mode: AUDIT_SECRET left unset (app falls back to the recording's bake secret; audit chain verifies)"
  elif [[ -z "${TF_VAR_audit_secret:-}" ]]; then
    export TF_VAR_audit_secret=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)
    persist_secret audit_secret "$TF_VAR_audit_secret"
    ok "generated AUDIT_SECRET → deploy/.deploy-secrets.env"
  fi
  if [[ -z "${TF_VAR_session_secret:-}" ]]; then
    export TF_VAR_session_secret=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)
    persist_secret session_secret "$TF_VAR_session_secret"
    ok "generated SESSION_SECRET → deploy/.deploy-secrets.env"
  fi

  ok "preflight passed"
}

# ────────────────────────────────────────────────────────────────────────────────
# 2. APPLY (with transient-error retry for Atlas/peering propagation)
# ────────────────────────────────────────────────────────────────────────────────
apply_with_retry() {
  local attempt=1 max=3
  while :; do
    if tf apply -auto-approve tfplan 2>&1 | tee -a "$LOG"; then return 0; fi
    if (( attempt < max )) && tail -n 40 "$LOG" | grep -qiE "CANNOT_.*_YET|PEER.*PENDING|Throttling|RequestLimitExceeded|timeout|try again"; then
      warn "transient error on apply (attempt $attempt/$max); re-planning + retrying in $((30*attempt))s"
      sleep $((30 * attempt)); attempt=$((attempt + 1))
      tf plan -out tfplan >>"$LOG" 2>&1 || die "re-plan failed"
      continue
    fi
    die "terraform apply failed (see $LOG)"
  done
}

# ────────────────────────────────────────────────────────────────────────────────
# 3. WAITS + BOOTSTRAP + HEALTH
# ────────────────────────────────────────────────────────────────────────────────
wait_peering_active() {
  local create; create=$(tfvar create_atlas_cluster); create=${create:-true}
  [[ "$create" == "true" ]] || return 0
  local pcx region i
  pcx=$(tf output -raw vpc_peering_connection_id 2>/dev/null || echo "")
  region=$(tfvar aws_region); region=${region:-us-west-2}
  [[ -n "$pcx" ]] || { warn "no peering connection id in outputs; skipping ACTIVE wait"; return 0; }
  log "waiting for VPC peering $pcx to become active"
  for i in $(seq 1 30); do
    local st; st=$(aws ec2 describe-vpc-peering-connections --region "$region" \
      --vpc-peering-connection-ids "$pcx" --query 'VpcPeeringConnections[0].Status.Code' --output text 2>/dev/null || echo "")
    [[ "$st" == "active" ]] && { ok "peering active"; return 0; }
    sleep 10
  done
  warn "peering not active after ~5 min; continuing (bootstrap may need a retry)."
}

wait_boot() {
  local ip; ip=$(tf output -raw public_ip)
  log "waiting for EC2 bootstrap (ssh ec2-user@$ip; tailing /var/log/deploy.log)"
  local i
  for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "ec2-user@$ip" \
        'grep -q "== userdata done ==" /var/log/deploy.log 2>/dev/null' 2>/dev/null; then
      ok "instance bootstrap complete"; return 0
    fi
    sleep 15
  done
  warn "bootstrap marker not seen after ~15 min; check: ssh ec2-user@$ip 'tail -f /var/log/deploy.log'"
}

# Load the corpus + the demo recording into Atlas from THIS machine (admin_cidr is allowlisted).
# provision = indexes + seed cases + synthetic corpus (embeds via Voyage). restore:replay =
# load the committed recording into the immutable replay_* collections (no LLM needed).
bootstrap_data() {
  command -v pnpm >/dev/null || { warn "pnpm missing — skipping data bootstrap. Run against Atlas manually."; return 0; }
  local uri db voyage
  uri=$(get_mongodb_uri)
  db=$(tfvar mongodb_db); db=${db:-marshal}
  voyage="${TF_VAR_voyage_api_key:-}"
  [[ -n "$uri" ]] || { warn "no MONGODB_URI available; skipping data bootstrap."; return 0; }
  log "seeding Atlas from this machine (provision → restore:replay)"
  ( cd "$REPO_DIR" \
      && pnpm install --frozen-lockfile >>"$LOG" 2>&1 \
      && MONGODB_URI="$uri" MONGODB_DB="$db" VOYAGE_API_KEY="$voyage" pnpm provision \
      && MONGODB_URI="$uri" MONGODB_DB="$db" pnpm restore:replay ) 2>&1 | tee -a "$LOG" \
    || warn "data bootstrap had errors — inspect $LOG; you can re-run it from the repo root."
  ok "data bootstrap done"
}

# Rebuild the authed URI locally for the bootstrap step (never printed to stdout).
get_mongodb_uri() {
  local create; create=$(tfvar create_atlas_cluster); create=${create:-true}
  if [[ "$create" != "true" ]]; then echo "${TF_VAR_mongodb_uri_byo:-}"; return; fi
  local srv host user pass
  srv=$(tf output -raw atlas_srv 2>/dev/null || echo "")
  [[ -n "$srv" ]] || { echo ""; return; }
  host=${srv#mongodb+srv://}
  user=$(tfvar atlas_db_username); user=${user:-marshal_app}
  pass="${TF_VAR_atlas_db_password:-}"
  [[ -n "$pass" ]] || pass=$(tfvar atlas_db_password)
  echo "mongodb+srv://${user}:${pass}@${host}/?retryWrites=true&w=majority"
}

health_poll() {
  local ip; ip=$(tf output -raw public_ip)
  log "waiting for the app to answer on http://$ip/api/health"
  local i
  for i in $(seq 1 40); do
    if curl -fsS "http://$ip/api/health" >/dev/null 2>&1; then ok "app healthy"; return 0; fi
    sleep 15
  done
  warn "health check did not pass after ~10 min; check: ssh ec2-user@$ip 'docker compose -f /opt/app/src/docker-compose.yml -f /opt/app/src/deploy/compose.nginx.yml logs'"
}

# ────────────────────────────────────────────────────────────────────────────────
main() {
  echo "${C_B}=== Marshal → AWS one-command deploy ===${C_0}"
  preflight
  log "terraform init"; tf init -input=false >>"$LOG" 2>&1 || die "terraform init failed"
  log "terraform validate"; tf validate >>"$LOG" 2>&1 || die "terraform validate failed"
  log "terraform plan"; tf plan -input=false -out tfplan 2>&1 | tee -a "$LOG" || die "terraform plan failed"
  if ! $AUTO_YES; then
    read -r -p "Apply this plan? (creates billable AWS + Atlas resources) [y/N] " a
    [[ "$a" == "y" || "$a" == "Y" ]] || die "aborted before apply."
  fi
  warn "provisioning — the Atlas M10 takes ~7–15 min; the on-box docker build ~3–5 min. Sit tight."
  apply_with_retry
  wait_peering_active
  wait_boot
  bootstrap_data
  health_poll

  local dns; dns=$(tf output -raw public_dns)
  echo ""
  ok "Deployed."
  echo "   App URL : ${C_G}http://$dns/?tour=0${C_0}   (add ?tour=0 to suppress the auto-tour on stage)"
  echo "   Health  : http://$dns/api/health"
  echo "   SSH     : ssh ec2-user@$dns"
  echo "   Logs    : ssh ec2-user@$dns 'tail -f /var/log/deploy.log'"
  echo "   Beats   : run pnpm beat:policy / beat:tamper / beat:restore against the cluster (see deploy/README.md)"
}
main "$@"
