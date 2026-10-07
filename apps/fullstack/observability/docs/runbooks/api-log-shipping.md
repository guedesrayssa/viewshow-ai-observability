# API logs are not reaching Loki

`stdout` (and CloudWatch on Fargate) still has every line. Only the Grafana copy is affected.

1. Check `log_shipping_failures_total` and `log_shipping_buffered_lines`: failures mean Loki is unreachable or rejecting writes; a full buffer means a sustained outage.
2. From the API network, run `curl -s -o /dev/null -w '%{http_code}' $LOKI_PUSH_URL` (expect 405 for GET, 204 for a valid push).
3. Check Loki health (`/ready`) and its disk; the lab EC2 has a single volume.
4. Query the missing window in CloudWatch Logs (`/ecs/<service>`); the JSON lines are identical.
