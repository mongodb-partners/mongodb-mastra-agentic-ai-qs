locals {
  use_atlas = var.create_atlas_cluster

  # Atlas region form: us-west-2 → US_WEST_2.
  atlas_region = upper(replace(var.aws_region, "-", "_"))

  # Atlas permits only ONE network container per (project, provider, region). A reused
  # project may already have one for our region (from prior peering); creating another
  # 409s (OVERLAPPING_ATLAS_CIDR_BLOCK / DUPLICATE). So look up existing AWS containers
  # and, if one matches our region, reuse it (its id + its CIDR) instead of creating.
  _existing_containers = local.use_atlas ? [
    for c in data.mongodbatlas_network_containers.aws[0].results : c
    if c.region_name == local.atlas_region
  ] : []
  # NOTE: the data source's element id field is `id` (the resource's is `container_id`).
  _existing_container_id   = length(local._existing_containers) > 0 ? local._existing_containers[0].id : ""
  _existing_container_cidr = length(local._existing_containers) > 0 ? local._existing_containers[0].atlas_cidr_block : ""

  create_container   = local.use_atlas && local._existing_container_id == ""
  atlas_container_id = local.create_container ? (local.use_atlas ? mongodbatlas_network_container.aws[0].container_id : "") : local._existing_container_id
  # CIDR actually routed to Atlas: the new container uses var.atlas_cidr; a reused one
  # keeps whatever CIDR it was created with.
  atlas_cidr_effective = local.create_container ? var.atlas_cidr : local._existing_container_cidr

  # Project id: reuse the passed-in id, else the project Terraform creates.
  project_id = var.create_atlas_cluster && var.atlas_project_id == "" ? mongodbatlas_project.this[0].id : var.atlas_project_id

  ssm_prefix = "/${var.name_prefix}/env"

  # Governance tags required by the account's reaper policy. Applied to AWS resources via
  # the provider default_tags, and to the Atlas cluster via its own tags block.
  common_tags = {
    Project      = var.name_prefix
    ManagedBy    = "terraform"
    Env          = "demo"
    owner        = var.owner_email
    OwnerContact = var.owner_email
    purpose      = var.purpose
    "expire-on"  = var.expire_on
  }

  # Compose the authenticated SRV URI from the cluster's standard_srv output. standard_srv is
  # "mongodb+srv://<host>" (no creds); we splice in user:pass@ after the scheme. The password
  # is alphanumeric (wrapper-generated) so no URL-encoding is needed. This value only ever
  # flows into an SSM SecureString — never an output.
  _srv_host   = local.use_atlas ? replace(mongodbatlas_advanced_cluster.cluster[0].connection_strings.standard_srv, "mongodb+srv://", "") : ""
  mongodb_uri = local.use_atlas ? "mongodb+srv://${var.atlas_db_username}:${var.atlas_db_password}@${local._srv_host}/?retryWrites=true&w=majority" : var.mongodb_uri_byo

  # Atlas rejects tags with blank values (HTTP 400 TAG_VALUE_BLANK), so drop any empty value.
  atlas_tags = { for k, v in local.common_tags : k => v if v != null && v != "" }

  # Non-secret env → SSM String params. Keys match what src/config.ts reads. Empty values are
  # dropped so optional keys (e.g. LLM_BASE_URL) don't land as empty strings.
  plain_params = { for k, v in {
    APP_NAME         = var.app_name
    MONGODB_DB       = var.mongodb_db
    VOYAGE_BASE_URL  = var.voyage_base_url
    LLM_PROVIDER     = var.llm_provider
    LLM_MODEL        = var.llm_model
    LLM_BASE_URL     = var.llm_base_url
    RRF_K            = var.rrf_k
    SEED_SCALE_COUNT = var.seed_scale_count
    DEMO_MODE        = var.demo_mode
    NODE_ENV         = var.node_env
    PORT             = var.app_port
  } : k => v if v != "" }

  # Secret env → SSM SecureString params. for_each keys must be non-sensitive, but the SECRET
  # VALUES are sensitive — so key the resource on a presence SET (which optional secrets exist)
  # and look the value up separately. nonsensitive() is applied only to the emptiness check
  # (presence isn't the secret), never to a value. Optional secrets absent ⇒ no empty param,
  # and the app falls back to its dev defaults (fine in demo mode).
  secure_keys = toset(concat(
    ["MONGODB_URI", "VOYAGE_API_KEY"], # always set
    nonsensitive(var.grove_api_key != "") ? ["GROVE_API_KEY"] : [],
    nonsensitive(var.audit_secret != "") ? ["AUDIT_SECRET"] : [],
    nonsensitive(var.session_secret != "") ? ["SESSION_SECRET"] : [],
  ))
  secure_values = {
    MONGODB_URI    = local.mongodb_uri
    VOYAGE_API_KEY = var.voyage_api_key
    GROVE_API_KEY  = var.grove_api_key
    AUDIT_SECRET   = var.audit_secret
    SESSION_SECRET = var.session_secret
  }
}
