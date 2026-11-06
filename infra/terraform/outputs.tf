output "ad_events_queue_url" {
  value = aws_sqs_queue.ad_events.url
}

output "ad_events_dlq_url" {
  value = aws_sqs_queue.ad_events_dlq.url
}

output "campaigns_table" {
  value = aws_dynamodb_table.campaigns.name
}

output "delivery_table" {
  value = aws_dynamodb_table.delivery.name
}

output "processed_events_table" {
  value = aws_dynamodb_table.processed_events.name
}

output "reports_bucket" {
  value = aws_s3_bucket.reports.bucket
}

output "service_role_arns" {
  description = "Annotate each Kubernetes service account with its role (eks.amazonaws.com/role-arn)."
  value       = { for name, role in aws_iam_role.service : name => role.arn }
}
