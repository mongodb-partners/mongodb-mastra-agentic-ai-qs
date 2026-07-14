# Latest Amazon Linux 2023 AMI (x86_64), resolved via ec2:DescribeImages (owner=amazon) —
# no stale hardcoded id. Skipped when var.ami_id is set (for IAM that can't DescribeImages,
# or to pin a specific AMI).
data "aws_ami" "al2023" {
  count       = var.ami_id == "" ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023[0].id
}

# Key pair: create from a local public key when key_pair_name is empty, else reuse the named one.
resource "aws_key_pair" "this" {
  count      = var.key_pair_name == "" ? 1 : 0
  key_name   = "${var.name_prefix}-key"
  public_key = file(pathexpand(var.public_key_path))
}

locals {
  key_name = var.key_pair_name != "" ? var.key_pair_name : aws_key_pair.this[0].key_name
}

resource "aws_instance" "app" {
  ami                         = local.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.main.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = true
  key_name                    = local.key_name
  iam_instance_profile        = aws_iam_instance_profile.app.name

  # IMDSv2 required. Hop limit 1 is enough: only the HOST (userdata) reads IMDS — for the
  # SSM param fetch. The app container needs no AWS creds (the LLM is reached over a gateway).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  user_data = templatefile("${path.module}/../scripts/userdata.sh.tftpl", {
    app_repo_url    = var.app_repo_url
    app_repo_ref    = var.app_repo_ref
    ssm_path_prefix = local.ssm_prefix
    aws_region      = var.aws_region
  })
  # Re-provision cleanly if the bootstrap script changes.
  user_data_replace_on_change = true

  # Depend on the network + role being ready. Peering readiness is handled by the wrapper's
  # ACTIVE-poll + health-poll rather than a TF edge (the peering resources are count-gated,
  # and the box can boot while peering propagates — first Atlas calls come from the seed step).
  depends_on = [
    aws_route_table_association.main,
    aws_iam_instance_profile.app,
  ]

  tags = { Name = "${var.name_prefix}-app" }
}
