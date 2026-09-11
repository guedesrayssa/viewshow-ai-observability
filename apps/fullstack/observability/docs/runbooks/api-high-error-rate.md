# API high error rate

1. Break down `http_requests_total` by route and status code in Grafana.
2. Open a failing trace and follow its `trace_id` into Loki or CloudWatch logs.
3. Check DynamoDB throttling and dependency errors before scaling the API.
4. Roll back when the increase aligns with a deployment and no external dependency is failing.
