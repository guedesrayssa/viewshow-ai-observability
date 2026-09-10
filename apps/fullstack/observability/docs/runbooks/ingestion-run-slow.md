# Ingestion run slow

## Signal

`ViewShowIngestionRunSlow` fires when the 15-minute p95 of
`ingestion_pipeline_run_duration_seconds` remains above 120 seconds for 15
minutes. Absence of the metric does not fire the alert.

## Triage

1. Split the dashboard by `command` and inspect `ingestion_stage_duration_seconds`.
2. Correlate the slow run with its `trace_id` in Tempo and with
   `{service_name="view-show-ingestion"}` in Loki.
3. Check source lag, record rate, rejected records, schema drift, lease conflicts,
   and downstream throttling before retrying.
4. If the source is healthy, reduce chunk size or concurrency only after checking
   write capacity and the active lease.

## Recovery

Confirm a subsequent successful run, that source lag is falling, and that the
p95 remains below 120 seconds for a complete 15-minute window. Never mark a
partial run successful to silence the alert.
