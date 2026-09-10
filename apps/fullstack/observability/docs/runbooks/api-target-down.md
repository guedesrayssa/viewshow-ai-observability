# API metrics target down

1. Confirm the `view-show-api` target in Prometheus and note the last error.
2. Check `/health` and `/metrics` through the same address configured as the target.
3. In AWS, inspect ALB healthy targets, ECS desired/running tasks and API CloudWatch logs.
4. Roll back the latest task definition if health failed immediately after deploy.
