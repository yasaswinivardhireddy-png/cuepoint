# Local runs and CI: every AWS call goes to a moto server (https://github.com/getmoto/moto) started
# with S3_IGNORE_SUBDOMAIN_BUCKETNAME=true. localtest.me and all its subdomains resolve to
# 127.0.0.1, which S3 Control needs: it prefixes the account ID to the endpoint's host name.
environment  = "local"
aws_endpoint = "http://localtest.me:5000"
