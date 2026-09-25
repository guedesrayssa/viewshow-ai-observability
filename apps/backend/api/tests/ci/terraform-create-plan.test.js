const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "../../../../../");
const validatorPath = path.join(
  repositoryRoot,
  "scripts/ci/validate-terraform-create-plan.mjs",
);
const maxPlanBytes = 20 * 1024 * 1024;
const auxiliaryDataAddresses = [
  "data.archive_file.painel",
  "data.aws_availability_zones.disponiveis",
  "data.aws_caller_identity.atual",
  "data.aws_ecr_image.ingestion[0]",
  "data.aws_iam_instance_profile.lab",
  "data.aws_iam_role.lab",
  "data.aws_region.atual",
  "data.aws_ssm_parameter.amazon_linux_2023",
];

const apiExpectedAddresses = [
  "aws_amplify_app.painel",
  "aws_amplify_branch.principal",
  "aws_appautoscaling_policy.cpu_api",
  "aws_appautoscaling_target.api",
  "aws_apigatewayv2_api.tls",
  "aws_apigatewayv2_integration.alb",
  "aws_apigatewayv2_route.proxy",
  "aws_apigatewayv2_stage.default",
  "aws_cloudwatch_log_group.api",
  "aws_cognito_user_pool.principal",
  "aws_cognito_user_pool_client.backend",
  "aws_cognito_user_pool_domain.principal",
  "aws_dynamodb_table.golden_set",
  "aws_dynamodb_table.operacional",
  "aws_ecr_repository.api",
  "aws_eip.nat",
  "aws_ecs_cluster.principal",
  "aws_ecs_cluster_capacity_providers.principal",
  "aws_ecs_service.api",
  "aws_ecs_task_definition.api",
  "aws_flow_log.vpc",
  "aws_instance.bastion",
  "aws_internet_gateway.principal",
  "aws_lb.principal",
  "aws_lb_listener.http",
  "aws_lb_target_group.api",
  "aws_nat_gateway.principal",
  "aws_route.privada_internet",
  "aws_route.publica_internet",
  "aws_route_table.privada",
  "aws_route_table.publica",
  'aws_route_table_association.privada["a"]',
  'aws_route_table_association.privada["b"]',
  'aws_route_table_association.publica["a"]',
  'aws_route_table_association.publica["b"]',
  "aws_s3_bucket_lifecycle_configuration.flow_logs",
  "aws_s3_bucket_ownership_controls.flow_logs",
  "aws_s3_bucket_policy.flow_logs",
  "aws_s3_bucket_public_access_block.flow_logs",
  "aws_s3_bucket_server_side_encryption_configuration.flow_logs",
  "aws_security_group.alb",
  "aws_security_group.bastion",
  "aws_security_group.servico",
  'aws_subnet.privada["a"]',
  'aws_subnet.privada["b"]',
  'aws_subnet.publica["a"]',
  'aws_subnet.publica["b"]',
  "aws_vpc.principal",
  "aws_vpc_endpoint.dynamodb",
  "aws_vpc_endpoint.s3",
  "random_password.auth_cookie_secret",
  "random_password.cursor_secret",
  "terraform_data.build_painel",
  "terraform_data.flow_logs_bucket",
  "terraform_data.imagem",
  "terraform_data.painel",
];

const ingestionExpectedAddresses = [
  "aws_athena_workgroup.ingestion",
  "aws_cloudwatch_dashboard.ingestion",
  "aws_cloudwatch_log_group.ingestion_backfill",
  "aws_cloudwatch_log_group.ingestion_incremental_export",
  "aws_cloudwatch_log_group.ingestion_incremental_ingest",
  "aws_cloudwatch_log_group.ingestion_sync",
  "aws_cloudwatch_log_metric_filter.import_active_upload_age",
  "aws_cloudwatch_log_metric_filter.import_reconciliation_failures",
  "aws_cloudwatch_metric_alarm.analysis_dlq_depth",
  "aws_cloudwatch_metric_alarm.analysis_queue_backlog",
  "aws_cloudwatch_metric_alarm.analysis_queue_oldest_age",
  "aws_cloudwatch_metric_alarm.import_active_upload_age",
  "aws_cloudwatch_metric_alarm.import_reconciliation_failures",
  "aws_cloudwatch_metric_alarm.import_worker_failures",
  "aws_cloudwatch_metric_alarm.incremental_batch_quarantined",
  "aws_cloudwatch_metric_alarm.incremental_dlq_depth",
  "aws_cloudwatch_metric_alarm.incremental_queue_backlog",
  "aws_cloudwatch_metric_alarm.incremental_queue_oldest_age",
  "aws_cloudwatch_metric_alarm.incremental_watermark_lag",
  "aws_cloudwatch_metric_alarm.ingestion_athena_failures",
  "aws_cloudwatch_metric_alarm.ingestion_athena_processed_bytes",
  "aws_cloudwatch_metric_alarm.ingestion_backfill_failures",
  "aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures",
  "aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical",
  "aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning",
  "aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration",
  "aws_cloudwatch_metric_alarm.ingestion_mysql_preflight_failures",
  "aws_cloudwatch_metric_alarm.ingestion_mysql_retries",
  "aws_cloudwatch_metric_alarm.ingestion_outbox_oldest_age",
  'aws_cloudwatch_metric_alarm.ingestion_partial_runs["backfill"]',
  'aws_cloudwatch_metric_alarm.ingestion_partial_runs["sync"]',
  "aws_cloudwatch_metric_alarm.ingestion_projecting_duration",
  "aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures",
  'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-cpu"]',
  'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-memory"]',
  'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-storage"]',
  'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["sync-cpu"]',
  'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["sync-memory"]',
  'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["sync-storage"]',
  'aws_cloudwatch_metric_alarm.ingestion_schema_drift["backfill"]',
  'aws_cloudwatch_metric_alarm.ingestion_schema_drift["sync"]',
  'aws_cloudwatch_metric_alarm.ingestion_stage_failures["archiving"]',
  'aws_cloudwatch_metric_alarm.ingestion_stage_failures["projecting"]',
  "aws_cloudwatch_metric_alarm.ingestion_sync_failures",
  "aws_cloudwatch_metric_alarm.scheduler_dlq_depth",
  "aws_cloudwatch_metric_alarm.scheduler_target_errors",
  "aws_ecr_repository.ingestion",
  "aws_ecs_task_definition.ingestion_backfill",
  "aws_ecs_task_definition.ingestion_import",
  "aws_ecs_task_definition.ingestion_incremental_export",
  "aws_ecs_task_definition.ingestion_incremental_ingest",
  "aws_ecs_task_definition.ingestion_sync",
  "aws_glue_catalog_database.ingestion",
  "aws_s3_bucket_lifecycle_configuration.ingestion",
  "aws_s3_bucket_public_access_block.ingestion",
  "aws_s3_bucket_server_side_encryption_configuration.ingestion",
  "aws_s3_bucket_versioning.ingestion",
  "aws_scheduler_schedule.ingestion_sync",
  "aws_scheduler_schedule.ingestion_incremental_export",
  "aws_scheduler_schedule.ingestion_incremental_ingest",
  "aws_scheduler_schedule_group.ingestion",
  "aws_secretsmanager_secret.live_mysql[0]",
  "aws_secretsmanager_secret.snapshot_mysql[0]",
  "aws_security_group.ingestion",
  "aws_sqs_queue.analysis",
  "aws_sqs_queue.analysis_dlq",
  "aws_sqs_queue.incremental_batches",
  "aws_sqs_queue.incremental_batches_dlq",
  "aws_sqs_queue.ingestion_scheduler_dlq",
  "aws_sqs_queue_redrive_allow_policy.incremental_batches_dlq",
  "terraform_data.ingestion_bucket_learner_lab[0]",
  "terraform_data.ingestion_guardrails",
  "terraform_data.ingestion_image[0]",
];

const expectedAddresses = [
  ...apiExpectedAddresses,
  ...ingestionExpectedAddresses,
].sort();

const analysisWorkerAddresses = [
  "aws_cloudwatch_log_group.analysis_worker[0]",
  "aws_ecr_repository.analysis_worker[0]",
  "aws_ecs_service.analysis_worker[0]",
  "aws_ecs_task_definition.analysis_worker[0]",
  "aws_s3_object.analysis_catalog[0]",
  "aws_s3_object.analysis_model[0]",
  "terraform_data.analysis_worker_image[0]",
];
const workerExpectedAddresses = [
  ...expectedAddresses,
  ...analysisWorkerAddresses,
].sort();

function createPlan(overrides = {}, addresses = expectedAddresses) {
  const resourceChanges = addresses.map((address) => ({
    address,
    mode: "managed",
    type: address.split(".")[0],
    name: address.split(".").slice(1).join("."),
    change: {
      actions: ["create"],
      before: null,
      after: { secret: "do-not-print" },
      after_unknown: { secret: true },
    },
  }));

  return {
    format_version: "1.2",
    terraform_version: "1.15.9",
    resource_changes: resourceChanges,
    ...overrides,
  };
}

function runValidator(input) {
  const result = spawnSync(process.execPath, [validatorPath], {
    input,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, result.error?.message);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("accepts exactly the frozen fresh-stack create plan", () => {
  const result = runValidator(JSON.stringify(createPlan()));

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, expectedAddresses.length + 1);
  assert.deepEqual(
    lines.slice(0, -1).map((line) => line.replace(/: create or no-op$/, "")),
    expectedAddresses,
  );
  assert.equal(
    lines.at(-1),
    `create/no-op plan accepted: ${expectedAddresses.length} resources; auxiliary data reads/no-ops: 0`,
  );
  assert.match(result.stdout, /create/);
  assert.doesNotMatch(result.stdout, /do-not-print/);
});

test("accepts no-op for a re-execution of the exact known stack", () => {
  const plan = createPlan();
  for (const resourceChange of plan.resource_changes) {
    resourceChange.change.actions = ["no-op"];
  }

  const result = runValidator(JSON.stringify(plan));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    new RegExp(`create/no-op plan accepted: ${expectedAddresses.length} resources`),
  );
});

test("rejects updates, deletes, replacements, and other managed actions", () => {
  for (const actions of [
    ["update"],
    ["delete"],
    ["delete", "create"],
    ["forget"],
    ["read"],
  ]) {
    const plan = createPlan();
    plan.resource_changes[0].change.actions = actions;
    const result = runValidator(JSON.stringify(plan));

    assert.notEqual(result.status, 0, actions.join(","));
    assert.match(result.stdout + result.stderr, /aws_amplify_app\.painel/);
    assert.match(result.stdout + result.stderr, /rejected|action/i);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print/);
  }
});

test("accepts only known auxiliary data reads and counts them without addresses", () => {
  const auxiliaryChanges = auxiliaryDataAddresses.map((address) => ({
    address,
    mode: "data",
    change: { actions: ["read"] },
  }));
  const result = runValidator(
    JSON.stringify(
      createPlan({
        resource_changes: [
          ...createPlan().resource_changes,
          ...auxiliaryChanges,
        ],
      }),
    ),
  );

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    new RegExp(
      `create/no-op plan accepted: ${expectedAddresses.length} resources; auxiliary data reads/no-ops: ${auxiliaryDataAddresses.length}`,
    ),
  );
  assert.doesNotMatch(
    result.stdout,
    new RegExp(auxiliaryDataAddresses.join("|")),
  );
});

test("rejects arbitrary data reads and non-read auxiliary actions", () => {
  for (const resourceChange of [
    {
      address: "sensitive-arbitrary-data-source-canary",
      mode: "data",
      change: { actions: ["read"] },
    },
    {
      address: "data.aws_vpc.default",
      mode: "data",
      change: { actions: ["update"] },
    },
  ]) {
    const plan = createPlan({
      resource_changes: [...createPlan().resource_changes, resourceChange],
    });
    const result = runValidator(JSON.stringify(plan));

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /sensitive-arbitrary-data-source-canary/,
    );
  }
});

test("rejects importing and address metadata", () => {
  for (const mutate of [
    (resourceChange) => {
      resourceChange.change.importing = { id: "sensitive-import-id" };
    },
    (resourceChange) => {
      resourceChange.previous_address = "aws_sensitive.previous";
    },
  ]) {
    const plan = createPlan();
    mutate(plan.resource_changes[0]);
    const result = runValidator(JSON.stringify(plan));

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /aws_amplify_app\.painel/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /sensitive-import-id|aws_sensitive\.previous|do-not-print/,
    );
  }

  for (const mutate of [
    (plan) => {
      plan.resource_changes.pop();
      return plan;
    },
    (plan) => {
      plan.resource_changes.push({
        address: "sensitive-extra-address-canary",
        change: { actions: ["create"] },
      });
      return plan;
    },
    (plan) => {
      plan.resource_changes.push({
        ...plan.resource_changes[0],
        address: plan.resource_changes[0].address,
      });
      return plan;
    },
  ]) {
    const result = runValidator(JSON.stringify(mutate(createPlan())));
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /sensitive-extra-address-canary/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print/);
  }
});

test("rejects absent or invalid JSON without echoing input", () => {
  for (const input of ["", '{"secret":"do-not-print"']) {
    const result = runValidator(input);

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print/);
  }
});

test("rejects stdin larger than 20 MiB without echoing its contents", () => {
  const input = `${JSON.stringify({
    resource_changes: [],
    canary: "sensitive-oversized-plan-canary",
  })}${" ".repeat(maxPlanBytes + 1)}`;
  const result = runValidator(input);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /20 MiB/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /sensitive-oversized-plan-canary/,
  );
});

test("stops reading an oversized stdin stream without waiting for EOF", async () => {
  const input = `${JSON.stringify({
    resource_changes: [],
    canary: "sensitive-stream-canary",
  })}${" ".repeat(maxPlanBytes + 1)}`;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [validatorPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 2000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.write(input);
  });

  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /20 MiB/);
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-stream-canary/);
});

function withWorkerVariable(value) {
  return { variables: { analysis_worker_habilitado: { value } } };
}

test("accepts the base plan when the analysis worker is explicitly disabled", () => {
  const result = runValidator(
    JSON.stringify(createPlan(withWorkerVariable(false))),
  );

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    new RegExp(`accepted: ${expectedAddresses.length} resources`),
  );
  assert.doesNotMatch(result.stdout, /analysis_worker/);
});

test("requires exactly the worker addresses when the analysis worker is enabled", () => {
  for (const value of [true, "true"]) {
    const result = runValidator(
      JSON.stringify(
        createPlan(withWorkerVariable(value), workerExpectedAddresses),
      ),
    );

    assert.equal(result.status, 0, String(value));
    assert.equal(result.stderr, "");
    const lines = result.stdout.trim().split("\n");
    assert.deepEqual(
      lines.slice(0, -1).map((line) => line.replace(/: create or no-op$/, "")),
      workerExpectedAddresses,
    );
    assert.equal(
      lines.at(-1),
      `create/no-op plan accepted: ${workerExpectedAddresses.length} resources; auxiliary data reads/no-ops: 0`,
    );
  }
});

test("rejects an enabled worker plan that misses a worker address", () => {
  for (const missing of analysisWorkerAddresses) {
    const addresses = workerExpectedAddresses.filter(
      (address) => address !== missing,
    );
    const result = runValidator(
      JSON.stringify(createPlan(withWorkerVariable(true), addresses)),
    );

    assert.notEqual(result.status, 0, missing);
    assert.match(result.stderr, /rejected missing address/);
    assert.equal(result.stdout, "");
  }
});

test("rejects worker addresses when the analysis worker is not enabled", () => {
  for (const overrides of [
    {},
    withWorkerVariable(false),
    withWorkerVariable("false"),
  ]) {
    const result = runValidator(
      JSON.stringify(createPlan(overrides, workerExpectedAddresses)),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rejected unexpected address/);
    assert.equal(result.stdout, "");
  }
});

test("keeps the create-or-no-op rule for worker resources", () => {
  const plan = createPlan(withWorkerVariable(true), workerExpectedAddresses);
  const service = plan.resource_changes.find(
    (change) => change.address === "aws_ecs_service.analysis_worker[0]",
  );
  service.change.actions = ["delete", "create"];

  const result = runValidator(JSON.stringify(plan));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /aws_ecs_service\.analysis_worker\[0\]/);
  assert.match(result.stderr, /action must be create or no-op/);
});
