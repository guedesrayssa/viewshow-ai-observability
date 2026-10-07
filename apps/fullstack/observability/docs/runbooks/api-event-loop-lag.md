# Event loop lag above 500 ms

1. Compare `view_show_nodejs_eventloop_lag_p99_seconds` with the process CPU panel. A task near 100% CPU is saturated; the Fargate task has 0.25 vCPU.
2. Open slow traces (`{ resource.service.name = "view-show-api" && duration > 2s }`): the time should be in the route handler, not in DynamoDB.
3. If the ALB health check starts failing, ECS replaces the task and capacity drops to zero; scale out before that point.
4. Reduce the query window or scale out; do not raise the rate limit to hide the saturation.
