provider "aws" {
  region = var.aws_region
  # Applied to every taggable AWS resource. Includes the reaper-policy tags
  # (owner / OwnerContact / purpose / expire-on). See local.common_tags.
  default_tags {
    tags = local.common_tags
  }

  # MongoDB's corporate auto-tagger stamps `mongodb:infosec:*` tags (WhatIsThis, creatorIAMUser,
  # lastModifiedTime) onto resources after creation. Terraform doesn't know them, so every plan wants
  # to REMOVE them and the tagger puts them straight back — permanent phantom drift that hides real
  # diffs. Ignore the whole prefix rather than trying to model tags we don't own.
  ignore_tags {
    key_prefixes = ["mongodb:infosec:"]
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
