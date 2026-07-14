#!/usr/bin/env bash
# Tear down everything deploy.sh created. Single root module ⇒ Terraform destroys in the
# correct reverse-graph order: access-list → route → accepter → peering → container →
# cluster/user/project, and EC2/SSM/IAM/VPC via the AWS graph.
#
#   deploy/scripts/destroy.sh [--yes]
#
# Requires the same TF_VAR_* secrets that deploy.sh used (the mongodbatlas provider needs
# its keys to delete Atlas resources).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
TF_DIR="$DEPLOY_DIR/terraform"
tf() { terraform -chdir="$TF_DIR" "$@"; }

# Reuse the generated Atlas DB password + app secrets persisted by deploy.sh so the providers
# don't see spurious diffs mid-destroy.
SECRETS_FILE="$DEPLOY_DIR/.deploy-secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  set -a; # shellcheck disable=SC1090
  . "$SECRETS_FILE"; set +a
fi

if [[ -t 1 ]]; then C_R=$'\033[31m'; C_Y=$'\033[33m'; C_0=$'\033[0m'; else C_R=; C_Y=; C_0=; fi
AUTO_YES=false; [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && AUTO_YES=true

if ! $AUTO_YES; then
  echo "${C_Y}This destroys the EC2 box, VPC/peering, SSM params, IAM, AND the Atlas cluster (all data).${C_0}"
  read -r -p "Type 'destroy' to confirm: " a
  [[ "$a" == "destroy" ]] || { echo "aborted."; exit 1; }
fi

# Retry once: Atlas can return a transient 400 while a resource is mid-state-transition.
if ! tf destroy -auto-approve; then
  echo "${C_Y}destroy hit an error; retrying once in 30s (transient Atlas state transition?)${C_0}"
  sleep 30
  tf destroy -auto-approve || { echo "${C_R}destroy failed — inspect state and re-run.${C_0}"; exit 1; }
fi

# Best-effort sweep for a dangling AWS peering connection (rare race where the Atlas side
# was removed but the AWS pcx- lingered).
region=$(grep -m1 -E '^[[:space:]]*aws_region' "$TF_DIR/terraform.tfvars" 2>/dev/null | sed -E 's/.*=[[:space:]]*"?([^"#]*)"?.*/\1/' | tr -d '[:space:]')
region=${region:-us-west-2}
dangling=$(aws ec2 describe-vpc-peering-connections --region "$region" \
  --filters "Name=tag:Name,Values=*-atlas-peer" "Name=status-code,Values=active,pending-acceptance,provisioning" \
  --query 'VpcPeeringConnections[].VpcPeeringConnectionId' --output text 2>/dev/null || echo "")
for pcx in $dangling; do
  echo "sweeping dangling peering $pcx"
  aws ec2 delete-vpc-peering-connection --region "$region" --vpc-peering-connection-id "$pcx" || true
done

echo "teardown complete."
