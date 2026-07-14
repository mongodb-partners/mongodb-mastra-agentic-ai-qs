# AWS ↔ Atlas VPC peering.
#
# Flow: Atlas creates a network container (its side of the peered network), then INITIATES
# a peering request to our AWS account/VPC; AWS accepts it; we add a route sending the Atlas
# CIDR over the peering connection; the Atlas access list (atlas.tf) then admits the VPC CIDR.
#
# Dependency ordering (Terraform honors these via attribute references + explicit depends_on):
#   network_container → network_peering (container_id) → accepter (connection_id)
#     → aws_route (accepter id) → project_ip_access_list.app["<vpc_cidr>"] (depends_on route)
#
# CIDR non-overlap (var.atlas_cidr /21 vs var.vpc_cidr) is asserted by the deploy wrapper.

# Existing AWS network containers in the project (a reused project may already have one
# for our region — Atlas allows only one per region+provider, so we reuse it).
data "mongodbatlas_network_containers" "aws" {
  count         = local.use_atlas ? 1 : 0
  project_id    = local.project_id
  provider_name = "AWS"
}

# Create a container only when none exists for our region (see locals.create_container).
resource "mongodbatlas_network_container" "aws" {
  count            = local.create_container ? 1 : 0
  project_id       = local.project_id
  atlas_cidr_block = var.atlas_cidr
  provider_name    = "AWS"
  region_name      = local.atlas_region
}

resource "mongodbatlas_network_peering" "aws" {
  count                  = local.use_atlas ? 1 : 0
  project_id             = local.project_id
  container_id           = local.atlas_container_id
  provider_name          = "AWS"
  accepter_region_name   = var.aws_region
  aws_account_id         = data.aws_caller_identity.current.account_id
  vpc_id                 = aws_vpc.main.id
  route_table_cidr_block = var.vpc_cidr
}

# AWS side accepts the connection Atlas initiated. connection_id is the AWS pcx- id.
resource "aws_vpc_peering_connection_accepter" "atlas" {
  count                     = local.use_atlas ? 1 : 0
  vpc_peering_connection_id = mongodbatlas_network_peering.aws[0].connection_id
  auto_accept               = true
  tags                      = { Name = "${var.name_prefix}-atlas-peer" }
}

# Route Atlas-bound traffic (the /21 container CIDR) over the peering connection.
resource "aws_route" "to_atlas" {
  count                     = local.use_atlas ? 1 : 0
  route_table_id            = aws_route_table.main.id
  destination_cidr_block    = local.atlas_cidr_effective
  vpc_peering_connection_id = aws_vpc_peering_connection_accepter.atlas[0].vpc_peering_connection_id

  depends_on = [aws_vpc_peering_connection_accepter.atlas]
}
