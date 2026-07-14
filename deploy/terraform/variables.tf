# ─────────────────────────────────────────────────────────────────────────────
# Inputs. Non-secret values live in terraform.tfvars (copy from the .example).
# Secrets (atlas keys, voyage key, gateway key, session/audit secrets, BYO mongo uri)
# come from TF_VAR_* env or a gitignored terraform.tfvars — NEVER commit filled secrets.
# ─────────────────────────────────────────────────────────────────────────────

# ── Toggles / region / naming ────────────────────────────────────────────────
variable "create_atlas_cluster" {
  description = "true: Terraform provisions a new Atlas M10 + VPC peering. false: BYO — skip all Atlas/peering resources and use mongodb_uri_byo."
  type        = bool
  default     = true
}

variable "aws_region" {
  description = "AWS region. Co-locate the EC2 box with the Atlas region for low-latency peering."
  type        = string
  default     = "us-west-2"
}

variable "availability_zone" {
  description = "AZ for the subnet + EC2 instance."
  type        = string
  default     = "us-west-2a"
}

variable "name_prefix" {
  description = "Prefix for resource names, tags, and the SSM parameter path."
  type        = string
  default     = "marshal"
}

# ── Governance tags (required by the account's tag-reaper policy) ─────────────
variable "owner_email" {
  description = "Owner email — applied as owner + OwnerContact tags on every resource. Set to your own."
  type        = string
  default     = ""
}

variable "purpose" {
  description = "purpose tag value."
  type        = string
  default     = "partners"
}

variable "expire_on" {
  description = "expire-on tag (YYYY-MM-DD) read by the account resource-reaper. Set to just after the demo, not far future."
  type        = string
  default     = "2026-08-31"
}

# ── Access control ────────────────────────────────────────────────────────────
variable "admin_cidr" {
  description = "Deploy machine's CIDR (usually its public IP /32) allowed for SSH (22) and, in create mode, added to the Atlas access list so this host can provision + restore the cluster over the public path. The wrapper auto-detects a /32 when unset. All app ports are additionally reachable from office_cidrs."
  type        = string
}

variable "office_cidrs" {
  description = "Corporate/VPN network ranges allowed to reach the app (nginx :80, and :8000 for admins). Nothing is world-open; access is over these ranges. Set the actual list in the gitignored terraform.tfvars; empty ⇒ no office/VPN ingress (admin_cidr SSH only)."
  type        = list(string)
  default     = []
}

# ── Networking (CIDR non-overlap is load-bearing for peering) ─────────────────
variable "vpc_cidr" {
  description = "AWS VPC CIDR. Must NOT overlap atlas_cidr."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "Public subnet CIDR within the VPC."
  type        = string
  default     = "10.0.1.0/24"
}

variable "atlas_cidr" {
  description = "CIDR for the Atlas network container (the peered network). Atlas AWS containers require a /21. Must NOT overlap vpc_cidr."
  type        = string
  default     = "192.168.248.0/21"
}

# ── Atlas ─────────────────────────────────────────────────────────────────────
variable "atlas_public_key" {
  description = "Atlas Programmatic API public key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "atlas_private_key" {
  description = "Atlas Programmatic API private key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "atlas_org_id" {
  description = "Atlas org id — used only when creating a new project (atlas_project_id empty)."
  type        = string
  default     = ""
}

variable "atlas_project_id" {
  description = "Existing Atlas project id to deploy into. Empty ⇒ Terraform creates a project (needs atlas_org_id)."
  type        = string
  default     = ""
}

variable "atlas_project_name" {
  description = "Name for the Atlas project when creating one."
  type        = string
  default     = "marshal"
}

variable "atlas_cluster_name" {
  description = "Atlas cluster name."
  type        = string
  default     = "marshal-cluster"
}

variable "atlas_db_username" {
  description = "Atlas database user for the app."
  type        = string
  default     = "marshal_app"
}

variable "atlas_db_password" {
  description = "Password for the Atlas database user. Leave empty and let the wrapper generate an alphanumeric one (avoids URL-encoding in the connection string)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "mongodb_uri_byo" {
  description = "BYO connection string (mongodb+srv://user:pass@host/...). Used only when create_atlas_cluster = false. Must be a replica set (Marshal uses change streams)."
  type        = string
  default     = ""
  sensitive   = true
}

# ── App config (non-secret) — keys match src/config.ts ────────────────────────
variable "app_name" {
  type    = string
  default = "Marshal"
}

variable "mongodb_db" {
  description = "Database name (→ MONGODB_DB). NOTE: the app reads MONGODB_DB, not MONGODB_DATABASE."
  type        = string
  default     = "marshal"
}

variable "voyage_base_url" {
  type    = string
  default = "https://ai.mongodb.com/v1"
}

variable "llm_provider" {
  description = "LLM provider for the live agent (demo mode makes no LLM calls). 'anthropic' via the gateway is the default path."
  type        = string
  default     = "anthropic"
}

variable "llm_model" {
  type    = string
  default = "claude-haiku-4-5"
}

variable "llm_base_url" {
  description = "Optional gateway base URL for the LLM (e.g. an APIM/Grove Anthropic endpoint). Empty ⇒ direct provider. Only used in live mode."
  type        = string
  default     = ""
}

variable "rrf_k" {
  type    = string
  default = "60"
}

variable "seed_scale_count" {
  description = "Size of the synthetic decided-precedent corpus seeded at provision time (the deployment-at-scale story)."
  type        = string
  default     = "1200"
}

# Demo mode: "1" replays the committed recording (no LLM, safe for hundreds of concurrent
# viewers) — the intended posture for a public demo box. Set "0" for a live-agent box.
variable "demo_mode" {
  type    = string
  default = "1"
}

variable "node_env" {
  description = "NODE_ENV on the box. 'production' enforces real audit/session secrets in LIVE mode; harmless in demo mode (the wrapper generates the secrets regardless)."
  type        = string
  default     = "production"
}

variable "app_port" {
  type    = string
  default = "8000"
}

# ── App secrets (→ SSM SecureString) ──────────────────────────────────────────
variable "voyage_api_key" {
  description = "Voyage API key (used at provision time to embed the corpus; works against the MongoDB-hosted endpoint)."
  type        = string
  sensitive   = true
}

variable "grove_api_key" {
  description = "Gateway API key for the LLM (sent as the api-key header when llm_base_url is a gateway). Only needed for LIVE mode; leave empty for a demo-mode box."
  type        = string
  default     = ""
  sensitive   = true
}

variable "audit_secret" {
  description = "HMAC secret for the tamper-evident audit chain. Leave empty and let the wrapper generate + persist one."
  type        = string
  default     = ""
  sensitive   = true
}

variable "session_secret" {
  description = "HMAC secret for session tokens (distinct from audit_secret). Leave empty and let the wrapper generate + persist one."
  type        = string
  default     = ""
  sensitive   = true
}

# ── Build / instance ──────────────────────────────────────────────────────────
variable "app_repo_url" {
  description = "HTTPS git URL of the app repo to clone + run on the instance."
  type        = string
  default     = "https://github.com/mongodb-partners/mongodb-mastra-agentic-ai-qs.git"
}

variable "app_repo_ref" {
  description = "Branch/tag/sha to deploy."
  type        = string
  default     = "main"
}

variable "instance_type" {
  description = "EC2 instance type. m6i.large (fixed CPU, 8 GiB) handles the on-box docker build comfortably."
  type        = string
  default     = "m6i.large"
}

variable "ami_id" {
  description = "Optional explicit AMI id. Empty ⇒ resolve the latest Amazon Linux 2023 x86_64 via ec2:DescribeImages."
  type        = string
  default     = ""
}

variable "key_pair_name" {
  description = "Existing EC2 key pair to use. Empty ⇒ create one from public_key_path."
  type        = string
  default     = ""
}

variable "public_key_path" {
  description = "Local SSH public key uploaded when key_pair_name is empty."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}
