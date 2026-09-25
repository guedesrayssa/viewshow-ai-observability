# Ingestion run slow

## Signal

`ViewShowIngestionRunSlow` fires when the 15-minute p95 of
`ingestion_pipeline_run_duration_seconds` remains above 120 seconds for 15
minutes. Absence of the metric does not fire the alert.

## Triage

1. Split the dashboard by `command` and inspect `ingestion_stage_duration_seconds`.
2. Correlate the slow run with its `trace_id` in Tempo and with
   `{service_name="view-show-ingestion"}` in Loki.
3. For snapshot imports, inspect `MySqlPageDurationMs`, `MySqlRetries` and
   `MySqlPreflightFailures` with `command=import-dump` and
   `source_mode=snapshot`. Page duration identifies cursor degradation, retries
   identify transient 2006/2013 disconnects, and preflight failures mean the
   required cursor plan was rejected before reading data.
4. Interpret public failure codes without consulting private logs or SQL:
   `MYSQL_CONNECTION_LOST` exhausted reconnection attempts,
   `MYSQL_QUERY_TIMEOUT` exhausted attempts after a timed-out query, and
   `QUERY_PLAN_INVALID` means EXPLAIN/index preflight could not guarantee safe
   cursor pagination.
5. Check source lag, record rate, rejected records, schema drift, lease conflicts,
   and downstream throttling before retrying.
6. If the source is healthy, compare the 2,000, 5,000 and 10,000 page-size
   canaries. Phase 1 promoted 10,000; do not tune an import already running.
7. Check `LocalDiskPeakBytes` for `command=import-dump`,
   `source_mode=snapshot`, and `status=SUCCEEDED`. Warning and critical are 80%
   and 90% of the application's 64 GiB spool budget. The task still has 200 GiB
   of ephemeral storage; do not raise the application budget past its 128 GiB
   hard ceiling to mask a leak.

## Canonical evidence

For a canonical-v2 candidate, treat
`canonical/schema_version=1.0/dataset_version=<candidateVersion>/manifest.json`
as the commit marker. Inspect it with S3 checksum mode enabled and require its
SHA-256 response checksum to match the object's `sha256` metadata before using
its contents. The marker must name the same dataset version and source SHA-256.

For every dataset and date partition in the marker:

1. Sum object `rowCount` values and compare them with the partition count.
2. Sum partition counts and compare them with the dataset accepted count.
3. Check every canonical object key, byte count, and SHA-256 against the marker.
4. Recompute or compare the recorded aggregate digest and reconcile total source
   rows as accepted plus rejected rows.

Do not declare the candidate complete from Glue partitions or object presence
alone. The immutable, checksum-valid manifest is the commit boundary, and every
referenced archive partition must be `AVAILABLE` with matching evidence.

The ingestion bucket has no bucket-wide lifecycle rule. Multipart abort and
expired delete-marker cleanup are scoped independently to the mutable raw,
dumps, staging, and Athena-result prefixes. Any lifecycle filter that is empty,
is a parent of `canonical/`, or is inside `canonical/` is a rollout blocker.

To distinguish a source restart from an S3 resume, correlate the same import and
run IDs across MySQL and archive signals. Fresh restore/preflight/page-query
activity (`MySqlPageDurationMs` and source reads) means extraction restarted.
When those counters stay flat while the worker reconciles persisted partition
evidence, HEADs staged/final objects, or promotes objects under
`staging/canonical/`, it is resuming the S3 publication path. A checksum or
persisted-evidence mismatch is reconciliation failure, not permission to erase
objects and start over.

## Recovery

Confirm a subsequent successful run, that source lag is falling, and that the
p95 remains below 120 seconds for a complete 15-minute window. Never mark a
partial run successful to silence the alert.

Rollback canonical-first from the original checkout with
`AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase1-10000`.
This reserves `legacy-v1` only for imports created after the update. It does not
change an existing import's pipeline version, stop its worker, remove lifecycle
or alarms, or delete any object. Never delete `staging/canonical/` or
`canonical/` partitions referenced by a candidate in progress; let the worker
reconcile them, and investigate checksum mismatches before retrying. The wrapper
requires `CONTROL#IMPORT`/`ACTIVE` to be empty immediately before apply.

A buffer-pool, redo, page-size, or flag change creates a new ECS task definition
and cannot recover a task that has already failed. Reconcile or restart that
import separately after confirming no active worker remains and after preserving
its commit marker and partition evidence.
