provider "aws" {
  region = var.aws_region
  # Applied to every taggable AWS resource. Includes the reaper-policy tags
  # (owner / OwnerContact / purpose / expire-on). See local.common_tags.
  default_tags {
    tags = local.common_tags
  }
}

# MongoDB Atlas Programmatic API Key (org- or project-scoped). Passed as sensitive vars
# (TF_VAR_atlas_public_key / TF_VAR_atlas_private_key), never committed.
provider "mongodbatlas" {
  public_key  = var.atlas_public_key
  private_key = var.atlas_private_key
}

# AWS account id — needed as the peer-VPC owner when Atlas initiates the peering request.
data "aws_caller_identity" "current" {}
