data "aws_caller_identity" "current" {}

locals {
  prefix = "cuepoint-${var.environment}"
}

# Ad events (impressions) flow from the ad server to the delivery worker. Messages the worker
# cannot process are retried, then parked in the dead-letter queue for inspection.

resource "aws_sqs_queue" "ad_events_dlq" {
  name                      = "${local.prefix}-ad-events-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "ad_events" {
  name                       = "${local.prefix}-ad-events"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 10
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ad_events_dlq.arn
    maxReceiveCount     = var.event_max_receive_count
  })
}

# Campaigns, keyed by ID, with an index to list one advertiser's campaigns.
resource "aws_dynamodb_table" "campaigns" {
  name         = "${local.prefix}-campaigns"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "advertiserId"
    type = "S"
  }

  global_secondary_index {
    name            = "byAdvertiser"
    projection_type = "ALL"

    key_schema {
      attribute_name = "advertiserId"
      key_type       = "HASH"
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# Delivered impressions per campaign: one item per hour ("2026-11-06T09") and per day ("2026-11-06").
resource "aws_dynamodb_table" "delivery" {
  name         = "${local.prefix}-delivery"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "campaignId"
  range_key    = "period"

  attribute {
    name = "campaignId"
    type = "S"
  }

  attribute {
    name = "period"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# IDs of events already counted. SQS delivers at least once; this makes counting exactly once.
resource "aws_dynamodb_table" "processed_events" {
  name         = "${local.prefix}-processed-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventId"

  attribute {
    name = "eventId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # Losing this table would let replayed events be counted twice, so it can be restored too.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# Customer-managed key for the reports: rotated yearly, and only roles granted it in IAM
# (the report job) can write reports.
resource "aws_kms_key" "reports" {
  description             = "${local.prefix} delivery reports"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "reports" {
  name          = "alias/${local.prefix}-reports"
  target_key_id = aws_kms_key.reports.key_id
}

# Daily delivery reports written by the reporting job.
resource "aws_s3_bucket" "reports" {
  bucket        = "${local.prefix}-delivery-reports-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.environment != "prod"
}

resource "aws_s3_bucket_ownership_controls" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket                  = aws_s3_bucket.reports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "reports" {
  bucket = aws_s3_bucket.reports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.reports.arn
    }
    # One data key per bucket instead of per object: far fewer KMS calls.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    id     = "expire-old-reports"
    status = "Enabled"

    filter {
      prefix = "reports/"
    }

    expiration {
      days = var.report_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}
