variable "region" {
  description = "AWS region for every resource."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment, used in resource names and tags."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase letters, digits or hyphens."
  }
}

variable "aws_endpoint" {
  description = "Custom endpoint for every AWS service, such as a moto server for local runs and CI. Leave null for real AWS."
  type        = string
  default     = null
}

variable "eks_oidc_provider" {
  description = "EKS cluster OIDC provider, so pods can assume the service roles through IRSA. Null makes the roles assumable by the account instead (local runs)."
  type = object({
    arn = string
    url = string
  })
  default = null
}

variable "namespace" {
  description = "Kubernetes namespace of the service accounts that assume the roles."
  type        = string
  default     = "cuepoint"
}

variable "event_max_receive_count" {
  description = "Deliveries of an ad event before SQS moves it to the dead-letter queue."
  type        = number
  default     = 3
}

variable "report_retention_days" {
  description = "Days to keep delivery reports in S3."
  type        = number
  default     = 90
}
