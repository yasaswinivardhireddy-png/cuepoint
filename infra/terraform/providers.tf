locals {
  emulated = var.aws_endpoint != null
}

provider "aws" {
  region = var.region

  # An emulator such as moto accepts any credentials and has no instance metadata.
  skip_credentials_validation = local.emulated
  skip_metadata_api_check     = local.emulated
  s3_use_path_style           = local.emulated

  dynamic "endpoints" {
    for_each = local.emulated ? [var.aws_endpoint] : []
    content {
      dynamodb  = endpoints.value
      iam       = endpoints.value
      kms       = endpoints.value
      s3        = endpoints.value
      s3control = endpoints.value
      sqs       = endpoints.value
      sts       = endpoints.value
    }
  }

  default_tags {
    tags = {
      Project     = "cuepoint"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
