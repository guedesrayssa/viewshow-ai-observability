# Analysis worker failures or DLQ backlog

## Signal

`ViewShowAgenticHighFailureRate` fires when more than 5% of analysis messages
fail for ten minutes. `ViewShowAgenticDlqNotEmpty` fires when the analysis DLQ
is non-empty for five minutes. Absent worker metrics do not fire either alert.

## Triage

1. Split `analysis_messages_total` by `event_type` and inspect the queue age.
2. Correlate failed `analysis.message` traces in Tempo with
   `{service_name="view-show-agentic"}` logs in Loki.
3. Inspect `bedrock_invocations_total`, invocation latency, fallback reasons,
   throttling, model access, and token usage.
4. Validate the event schema and idempotency before replaying any DLQ message.

## Recovery

Fix the dependency or payload issue, replay only validated messages, and verify
that the DLQ returns to zero and the failure ratio stays below 5% for ten
minutes. Keep failed payload content out of logs; use message IDs for correlation.
