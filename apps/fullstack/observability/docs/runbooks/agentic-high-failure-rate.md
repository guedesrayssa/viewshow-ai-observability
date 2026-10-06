# Analysis worker failures or DLQ backlog

## Signal

`ViewShowAgenticHighFailureRate` fires when more than 5% of analysis messages
fail for ten minutes. `ViewShowLlmHighFailureRate` applies the same threshold to
model calls. `ViewShowAgenticDlqNotEmpty` fires when the analysis DLQ is
non-empty for five minutes. Absent worker metrics do not fire these alerts.

## Triage

1. Split `analysis_messages_total` by `event_type` and inspect the queue age.
2. Correlate failed `analysis.message` traces in Tempo with
   `{service_name="view-show-agentic"}` logs in Loki.
3. Inspect `llm_requests_total`, `llm_request_duration_seconds`, and
   `llm_response_stop_total` by provider and model.
4. Validate the event schema and idempotency before replaying any DLQ message.
5. In the local stack, use the correlated Tempo trace and container logs. In
   AWS, use the equivalent trace and CloudWatch log identifiers.

## Recovery

Fix the dependency or payload issue, replay only validated messages, and verify
that the DLQ returns to zero and the failure ratio stays below 5% for ten
minutes. Keep failed payload content out of logs; use message IDs for correlation.
