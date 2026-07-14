# App config + secrets to SSM Parameter Store. UserData reads this whole path at boot
# (get-parameters-by-path --with-decryption) and writes /opt/app/.env. Secrets never
# appear in UserData — only the path prefix does.

resource "aws_ssm_parameter" "plain" {
  for_each = local.plain_params
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "String"
  value    = each.value
  tags     = { Name = "${var.name_prefix}-${each.key}" }
}

resource "aws_ssm_parameter" "secure" {
  for_each = local.secure_keys
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "SecureString" # encrypted with the account default aws/ssm KMS key
  value    = local.secure_values[each.key]
  tags     = { Name = "${var.name_prefix}-${each.key}" }
}
