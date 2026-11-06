# Cuepoint delivery pipeline

`cuepoint-worker` consumes impression events from SQS and counts each one exactly once into DynamoDB.
`cuepoint-report` writes a daily delivery and pacing report and uploads it to S3. See the repository README.
