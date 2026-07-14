# Terraform + provider version pins. Single root module with a LOCAL backend (state in
# deploy/terraform/terraform.tfstate — gitignored). One `terraform apply` builds AWS
# (VPC/EC2/SSM/IAM) and MongoDB Atlas (cluster + VPC peering) together, so dependency
# ordering is enforced by the resource graph rather than a multi-step wrapper.
terraform {
  required_version = ">= 1.13"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 2.0"
    }
  }
}
