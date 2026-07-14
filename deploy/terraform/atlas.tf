# MongoDB Atlas: project (optional) + M10 cluster + db user + IP access list.
# All count-gated on create_atlas_cluster so BYO mode provisions nothing here.
#
# The cluster is a 3-node REPLICASET on purpose: Marshal's live feed uses MongoDB CHANGE
# STREAMS, which require a replica set. M10 is also the floor for VPC peering (M0/Flex can't peer).

resource "mongodbatlas_project" "this" {
  count  = local.use_atlas && var.atlas_project_id == "" ? 1 : 0
  name   = var.atlas_project_name
  org_id = var.atlas_org_id
}

resource "mongodbatlas_advanced_cluster" "cluster" {
  count        = local.use_atlas ? 1 : 0
  project_id   = local.project_id
  name         = var.atlas_cluster_name
  cluster_type = "REPLICASET"

  # Off so `destroy` can tear the demo down without a manual console step.
  termination_protection_enabled = false

  replication_specs = [
    {
      region_configs = [
        {
          electable_specs = {
            instance_size = "M10" # M10+ is REQUIRED for VPC peering (M0/Flex cannot peer).
            node_count    = 3
            disk_size_gb  = 10
          }
          provider_name = "AWS"
          priority      = 7
          region_name   = local.atlas_region
        }
      ]
    }
  ]

  tags = local.atlas_tags

  # M10 normally provisions in 7–15 min; a 30m cap surfaces stuck states sooner than the
  # 3h default so the wrapper fails fast instead of hanging on stage.
  timeouts = {
    create = "30m"
    update = "30m"
    delete = "20m"
  }
}

resource "mongodbatlas_database_user" "app" {
  count              = local.use_atlas ? 1 : 0
  project_id         = local.project_id
  username           = var.atlas_db_username
  password           = var.atlas_db_password
  auth_database_name = "admin"

  roles {
    role_name     = "atlasAdmin"
    database_name = "admin"
  }

  depends_on = [mongodbatlas_advanced_cluster.cluster]
}

# Access list: the peered AWS VPC CIDR (private path used by the box) + the deploy machine /32
# (so the laptop can provision + restore the recording over the public path). One resource per
# CIDR (provider requirement) via for_each. depends_on the peering route so the private entry
# only opens once the route exists.
resource "mongodbatlas_project_ip_access_list" "app" {
  for_each   = local.use_atlas ? toset([var.vpc_cidr, var.admin_cidr]) : toset([])
  project_id = local.project_id
  cidr_block = each.value
  comment    = "${var.name_prefix} (${each.value})"

  depends_on = [aws_route.to_atlas]
}
