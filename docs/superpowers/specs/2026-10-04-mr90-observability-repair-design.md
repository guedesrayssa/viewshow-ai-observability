# MR 90 Observability Repair Design

## Objective

Make merge request 90 safe to merge by correcting the ingestion Grafana
dashboard, restoring the standalone Learner Lab bootstrap, aligning the written
claims with reproducible evidence, and adding regression coverage for each
confirmed defect.

The branch is considered merge-ready only when its local validation passes and
the AWS-facing queries have been validated with fresh Learner Lab credentials.

## Current State

The MR source is commit `44066e7b8a03de48729e0001bbd2dd9a11281ecf` in the
isolated worktree `g05.worktrees/mr-90-review`.

The review confirmed these blockers:

1. The standalone renderer does not populate `ingestion_dashboard_gzip`, so
   `deploy-learner-lab.sh --validate-only` fails.
2. The throughput and error panels apply `PERIOD()` to CloudWatch search
   results (`TS[]`), which the CloudWatch metric-math API rejects.
3. The throughput panel uses `MySqlPageRows` instead of the documented
   `RecordsRead` and `RecordsWritten` contract.
4. Independent `Comando` and `Task ECS` variables can correlate application
   metrics from one operation with CPU from another task family.
5. The documentation claims broader AWS/Grafana validation than the committed
   raw evidence supports.
6. The task plan describes dashboard implementation and AWS execution as out of
   scope even though the MR contains both.

The Terraform configuration itself formats and validates. The existing
fullstack API, frontend, and load-balancer target were healthy during the
review. An external operation updated the shared Terraform state after the
review began, so no previously saved plan may be reused.

## Scope

### Included

- Correct the ingestion dashboard queries and their labels.
- Replace the two independent operation selectors with one correlated selector.
- Restore the standalone AWS bootstrap and keep its EC2 user-data payload under
  the 16 KiB API limit by sending gzip-compressed user data.
- Add deterministic regression tests for template rendering, dashboard
  semantics, expression structure, selector mapping, and payload size.
- Correct the MR documentation and evidence claims.
- Re-run local validation with machine-safe concurrency.
- With renewed Learner Lab credentials, generate a fresh Terraform plan,
  constrain the AWS change set to observability, validate the deployed
  dashboard, and preserve sanitized evidence.

### Excluded

- Redesigning the LGTM stack or introducing another metrics backend.
- Changing ingestion runtime instrumentation or adding new metrics.
- Refactoring unrelated Terraform resources or existing application services.
- Fixing the two pre-existing Terraform test failures unless the repaired files
  directly cause or expose a new failure.
- Destroying or modifying AWS resources before a fresh plan is reviewed.

## Design

### Dashboard metric queries

The dashboard will keep a fixed CloudWatch period of 300 seconds. Application
metrics whose Grafana query expands to a CloudWatch `SEARCH` result will be
reduced with `SUM(query_id)` and divided by the scalar `300`; `PERIOD()` will
not be called on a time-series array.

The throughput panel will contain hidden raw queries for `RecordsRead` and
`RecordsWritten`, filtered by the selected command, and two visible expressions:

```text
SUM(records_read) / 300
SUM(records_written) / 300
```

`MySqlPageRows` remains a diagnostic metric outside the required throughput
panel. `RecordsUnchanged` and `RecordsRejected` remain visible in the
reconciliation panel.

The error panel will use:

```text
(SUM(failed_runs) + SUM(partial_runs)) / 300
SUM(rejected_records) / 300
```

Panel titles, labels, and documentation will describe the exact metric,
statistic, and unit shown. The latency panel will not call a stage duration the
maximum run duration, and the CPU documentation will not promise a maximum if
the panel only queries an average.

### Correlated operation selector

The dashboard will expose one custom variable named `operation`. Each option
maps a command label to its ECS task-definition family:

```text
backfill : view-show-ingestion-backfill
sync : view-show-ingestion-sync
export-incremental : view-show-ingestion-incremental-export
ingest-incremental : view-show-ingestion-incremental-ingest
```

Application metric queries use the option text through
`$${operation:text}` in the Terraform template, which renders as
`${operation:text}` in Grafana. Container Insights queries use `$operation`,
whose value is the task family. One selection therefore controls both sides of
the correlation.

### Standalone bootstrap

`validate-user-data.sh` will render `view-show-ingestion.json.tftpl` with the
same logical values used by the standalone stack, gzip and base64-encode the
dashboard, and substitute `ingestion_dashboard_gzip` in the shell template.

The script will continue validating the rendered shell with `sh -n` and
rejecting unresolved placeholders. It will additionally produce a gzip file of
the complete user data and enforce the 16 KiB limit against those compressed
bytes. `deploy-learner-lab.sh` will pass that binary gzip payload to
`aws ec2 run-instances` using the AWS CLI binary-file form. Cloud-init detects
and expands gzip user data before execution.

The Terraform path continues using `user_data_base64 = base64gzip(...)`; it
does not depend on the standalone renderer.

### Tests

Regression tests will execute without AWS credentials and will verify:

- the standalone renderer exits successfully;
- the rendered user data contains no template placeholders;
- the compressed payload is no larger than 16,384 bytes;
- the rendered ingestion dashboard is valid JSON;
- throughput queries use `RecordsRead` and `RecordsWritten`;
- no expression calls `PERIOD()` on a search-result identifier;
- error-rate expressions divide by the configured 300-second period;
- only one operation selector exists and its text/value mapping covers all four
  command/task-family pairs;
- every panel uses the provisioned CloudWatch data-source UID;
- panel IDs and target `refId` values remain unique within their scopes.

The repository-level verification remains:

- `terraform fmt -check -recursive`;
- `terraform validate`;
- `terraform test -parallelism=2`;
- the focused Node or shell regression test command;
- the frontend production build using Node.js 22;
- `git diff --check`.

The two previously observed Terraform test failures will be compared against
the MR base. They will be reported separately when unchanged by this repair.

### Documentation and evidence

`artefatos/testes-carga-finais.md`, `tasks/plan.md`, `tasks/todo.md`, and the
dated Grafana validation record will distinguish these states:

- configured in code;
- validated locally;
- accepted by the AWS API;
- deployed in AWS;
- observed with data in a specific UTC window.

Claims of deployment or measured behavior require a committed sanitized raw
response or screenshot. Until the AWS rerun exists, the documents will state
that deployment validation is pending rather than treating an uncommitted
browser view as durable evidence.

### AWS rollout and safety

AWS validation starts only after the Learner Lab credentials are renewed. The
operator must confirm the `voclabs` identity, account `992648496097`, region
`us-east-1`, current state serial, and current observability instance before
planning.

A fresh plan will be generated from the checkout that owns the current local
state. The plan is rejected if it proposes unrelated application, frontend,
ingestion-task, data, or network changes. Expected observability changes may
include replacement of `aws_instance.observabilidade[0]` because its user data
uses `user_data_replace_on_change = true`.

After apply, validation will check:

1. EC2 and SSM health;
2. cloud-init completion;
3. all five observability containers;
4. Grafana `/api/health`;
5. the provisioned dashboard UID;
6. CloudWatch data-source health;
7. every metric-math query through the data-source or CloudWatch API;
8. command/task-family correlation for all four operation options.

The evidence bundle will contain sanitized query specifications, raw response
metadata and values, the exact UTC window, and a screenshot with readable
titles, units, filters, and legends. Secrets, signed URLs, tokens, and the
Grafana administrator password must not be committed.

## Error Handling

- Any unresolved template placeholder fails local validation.
- Any payload larger than 16,384 compressed bytes fails local validation.
- Any CloudWatch validation error blocks AWS apply or merge readiness.
- Any unrelated Terraform plan action blocks apply until separately explained
  and authorized.
- Expired AWS credentials stop the rollout without changing infrastructure.
- A failed cloud-init or unhealthy data source is collected through SSM logs
  and treated as a failed validation, not as a partial success.

## Merge Criteria

The MR is ready for merge only when:

- all four confirmed functional defects have regression coverage and are fixed;
- standalone rendering and Terraform rendering both succeed;
- local checks pass, with pre-existing baseline failures clearly separated;
- the documentation no longer overstates evidence;
- a fresh AWS validation accepts every dashboard query; and
- the final review finds no critical or important issue in the repaired diff.
