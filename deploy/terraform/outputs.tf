output "public_ip" {
  description = "EC2 public IP."
  value       = aws_instance.app.public_ip
}

output "public_dns" {
  description = "EC2 public DNS."
  value       = aws_instance.app.public_dns
}

output "app_url" {
  description = "Marshal console URL (nginx on :80 → app:8000), addressed by the EC2 public DNS."
  value       = "http://${aws_instance.app.public_dns}/"
}

output "ssh_command" {
  description = "SSH to the box."
  value       = "ssh ec2-user@${aws_instance.app.public_dns}"
}

output "ssm_prefix" {
  description = "SSM parameter path prefix for the app's env."
  value       = local.ssm_prefix
}

# Bare SRV host for debugging only (no credentials). The authed URI is never output —
# it lives solely in the SSM SecureString. Guarded so BYO mode doesn't error.
output "atlas_srv" {
  description = "Atlas standard SRV (no credentials); empty in BYO mode."
  value       = local.use_atlas ? mongodbatlas_advanced_cluster.cluster[0].connection_strings.standard_srv : ""
  sensitive   = true
}

output "vpc_peering_connection_id" {
  description = "AWS peering connection id (empty in BYO mode)."
  value       = local.use_atlas ? aws_vpc_peering_connection_accepter.atlas[0].vpc_peering_connection_id : ""
}
