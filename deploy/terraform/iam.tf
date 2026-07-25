# Scoped instance role — deliberately NOT the broad *FullAccess policies. Baseline is: read this
# app's SSM params, decrypt SecureString via the SSM KMS key, and CloudWatch Logs.
#
# Bedrock is added ONLY when llm_provider = "bedrock", because that is the one configuration where
# the app calls an AWS API at runtime. A demo box (llm_provider unset/other, DEMO_MODE=1) replays a
# recording and must NOT carry model-invoke permission — that gating is the whole point of the
# conditional below, so don't collapse it into the baseline.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${var.name_prefix}-app-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = { Name = "${var.name_prefix}-app-role" }
}

data "aws_iam_policy_document" "app" {
  statement {
    sid    = "SsmReadAppParams"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    # Two ARNs: the child params (/<prefix>/env/*) for Get(s)Parameter, and the path node
    # itself (/<prefix>/env) which GetParametersByPath authorizes against.
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }

  statement {
    sid     = "KmsDecryptSsm"
    effect  = "Allow"
    actions = ["kms:Decrypt"]
    # The AWS-managed aws/ssm key ARN is account-generated and can't be named by alias here,
    # so scope by service instead: decrypt is only allowed when the call comes VIA SSM.
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/${var.name_prefix}/*"]
  }

  # DNS-01 for certbot, on boxes that can't answer HTTP-01 (no inbound 80). Split into three
  # statements because the resource scopes genuinely differ: GetChange is on change/*, ListHostedZones
  # cannot be resource-scoped at all (Route 53 rejects anything but "*"), and the actual write is
  # pinned to the ONE hosted zone. Don't merge them — collapsing to a single "*" would hand the box
  # write access to every zone in the account.
  dynamic "statement" {
    for_each = var.certbot_route53_zone_id != "" ? [1] : []
    content {
      sid       = "Route53Dns01ForCertbot"
      effect    = "Allow"
      actions   = ["route53:GetChange"]
      resources = ["arn:aws:route53:::change/*"]
    }
  }

  dynamic "statement" {
    for_each = var.certbot_route53_zone_id != "" ? [1] : []
    content {
      sid       = "Route53ListZones"
      effect    = "Allow"
      actions   = ["route53:ListHostedZones"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.certbot_route53_zone_id != "" ? [1] : []
    content {
      sid       = "Route53WriteAcmeChallenge"
      effect    = "Allow"
      actions   = ["route53:ChangeResourceRecordSets"]
      resources = ["arn:aws:route53:::hostedzone/${var.certbot_route53_zone_id}"]
    }
  }

  # Live-agent boxes only. Invoke is scoped to Anthropic models, and to the cross-region inference
  # PROFILE for us.anthropic.* — a `us.`-prefixed model id resolves through an inference profile, so
  # granting only foundation-model ARNs yields AccessDeniedException at runtime. The extra
  # us-east-1/us-east-2 foundation-model ARNs are required for the same reason: the us-west-2 profile
  # fans out to those regions, and Bedrock authorizes against the destination too.
  dynamic "statement" {
    for_each = var.llm_provider == "bedrock" ? [1] : []
    content {
      sid    = "BedrockInvokeClaude"
      effect = "Allow"
      actions = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      resources = [
        "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.*",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.*",
        "arn:aws:bedrock:us-east-2::foundation-model/anthropic.*",
      ]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${var.name_prefix}-app-policy"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.name_prefix}-app-profile"
  role = aws_iam_role.app.name
}
