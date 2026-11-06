# One role per workload, each allowed only the calls its code makes, on the resources it uses.
# On EKS, pods assume their role through IAM Roles for Service Accounts (IRSA).

locals {
  oidc_host = var.eks_oidc_provider == null ? null : replace(var.eks_oidc_provider.url, "https://", "")

  services = {
    api = {
      service_account = "cuepoint-api"
      statements = [
        {
          # Updates are conditional puts on the version number, so UpdateItem is not needed.
          actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan"]
          resources = [aws_dynamodb_table.campaigns.arn, "${aws_dynamodb_table.campaigns.arn}/index/*"]
        },
        {
          actions   = ["dynamodb:BatchGetItem", "dynamodb:Query"]
          resources = [aws_dynamodb_table.delivery.arn]
        },
      ]
    }
    adserver = {
      service_account = "cuepoint-adserver"
      statements = [
        {
          # Also covers SendMessageBatch.
          actions   = ["sqs:SendMessage"]
          resources = [aws_sqs_queue.ad_events.arn]
        },
      ]
    }
    worker = {
      service_account = "cuepoint-worker"
      statements = [
        {
          # DeleteMessage also covers DeleteMessageBatch.
          actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage"]
          resources = [aws_sqs_queue.ad_events.arn]
        },
        {
          # TransactWriteItems is authorized per item: a conditional Put of the event ID...
          actions   = ["dynamodb:PutItem"]
          resources = [aws_dynamodb_table.processed_events.arn]
        },
        {
          # ...and an Update of the campaign's counters.
          actions   = ["dynamodb:UpdateItem"]
          resources = [aws_dynamodb_table.delivery.arn]
        },
      ]
    }
    report = {
      service_account = "cuepoint-report"
      statements = [
        {
          actions   = ["dynamodb:Scan"]
          resources = [aws_dynamodb_table.campaigns.arn]
        },
        {
          actions   = ["dynamodb:BatchGetItem"]
          resources = [aws_dynamodb_table.delivery.arn]
        },
        {
          actions   = ["s3:PutObject"]
          resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
        },
        {
          # SSE-KMS writes need a data key from the bucket's key.
          actions   = ["kms:GenerateDataKey"]
          resources = [aws_kms_key.reports.arn]
        },
      ]
    }
  }
}

data "aws_iam_policy_document" "assume" {
  for_each = local.services

  statement {
    effect = "Allow"

    dynamic "principals" {
      for_each = var.eks_oidc_provider == null ? [] : [var.eks_oidc_provider.arn]
      content {
        type        = "Federated"
        identifiers = [principals.value]
      }
    }

    dynamic "principals" {
      for_each = var.eks_oidc_provider == null ? [data.aws_caller_identity.current.account_id] : []
      content {
        type        = "AWS"
        identifiers = ["arn:aws:iam::${principals.value}:root"]
      }
    }

    actions = var.eks_oidc_provider == null ? ["sts:AssumeRole"] : ["sts:AssumeRoleWithWebIdentity"]

    dynamic "condition" {
      for_each = var.eks_oidc_provider == null ? [] : [1]
      content {
        test     = "StringEquals"
        variable = "${local.oidc_host}:sub"
        values   = ["system:serviceaccount:${var.namespace}:${each.value.service_account}"]
      }
    }

    dynamic "condition" {
      for_each = var.eks_oidc_provider == null ? [] : [1]
      content {
        test     = "StringEquals"
        variable = "${local.oidc_host}:aud"
        values   = ["sts.amazonaws.com"]
      }
    }
  }
}

data "aws_iam_policy_document" "service" {
  for_each = local.services

  dynamic "statement" {
    for_each = each.value.statements
    content {
      effect    = "Allow"
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role" "service" {
  for_each = local.services

  name               = "${local.prefix}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.assume[each.key].json
}

resource "aws_iam_role_policy" "service" {
  for_each = local.services

  name   = "${local.prefix}-${each.key}"
  role   = aws_iam_role.service[each.key].id
  policy = data.aws_iam_policy_document.service[each.key].json
}
