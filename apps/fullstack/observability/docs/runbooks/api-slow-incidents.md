# Slow incident queries

1. Confirm the p95 increase for the route template `/api/v1/incidents`.
2. Inspect traces for DynamoDB query duration and returned/scanned item counts.
3. Check ECS CPU, memory and event-loop lag.
4. Reduce the query window or roll back a regression; do not add an unbounded scan.
