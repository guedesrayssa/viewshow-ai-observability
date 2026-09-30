import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "../terraform/validate-create-plan.mjs";
const resource = (type, address, actions) => ({
  mode: "managed",
  type,
  address,
  change: { actions },
});
const cluster = resource("aws_eks_cluster", "aws_eks_cluster.principal", [
  "create",
]);
const plan = (...changes) => ({ resource_changes: [cluster, ...changes] });
test("Kubernetes creation and updates pass", () => {
  validatePlan(
    plan(
      resource("aws_eks_node_group", "aws_eks_node_group.principal", [
        "create",
      ]),
    ),
  );
  validatePlan(
    plan(
      resource("aws_eks_node_group", "aws_eks_node_group.principal", [
        "update",
      ]),
    ),
    { update: true },
  );
});
test("ECS removal requires migration flag; new ECS never passes", () => {
  const old = resource("aws_ecs_service", "aws_ecs_service.api", ["delete"]);
  assert.throws(() => validatePlan(plan(old)));
  validatePlan(plan(old), { migration: true });
  assert.throws(() =>
    validatePlan(
      plan(resource("aws_ecs_service", "aws_ecs_service.api", ["create"])),
      { migration: true },
    ),
  );
});
test("persistent resources cannot be deleted or replaced even during migration", () => {
  for (const type of [
    "aws_dynamodb_table",
    "aws_s3_bucket",
    "aws_cognito_user_pool",
    "aws_sqs_queue",
    "aws_lb",
    "aws_secretsmanager_secret",
  ])
    for (const actions of [
      ["delete"],
      ["delete", "create"],
      ["create", "delete"],
    ])
      assert.throws(() =>
        validatePlan(plan(resource(type, `${type}.principal`, actions)), {
          migration: true,
          update: true,
        }),
      );
});
test("unknown mutation and missing cluster fail closed", () => {
  assert.throws(() =>
    validatePlan(
      plan(
        resource("aws_lambda_function", "aws_lambda_function.unexpected", [
          "create",
        ]),
      ),
    ),
  );
  assert.throws(() => validatePlan({ resource_changes: [] }));
});

test("update can rebuild images without replacing bucket wrappers", () => {
  for (const address of [
    "terraform_data.imagem",
    "terraform_data.ingestion_image[0]",
    "terraform_data.analysis_worker_image[0]",
  ])
    validatePlan(
      plan(resource("terraform_data", address, ["delete", "create"])),
      { update: true },
    );
  for (const address of [
    "terraform_data.imagem",
    "terraform_data.flow_logs_bucket",
    "terraform_data.ingestion_bucket_learner_lab[0]",
  ])
    assert.throws(() =>
      validatePlan(
        plan(resource("terraform_data", address, ["delete", "create"])),
        address.endsWith("imagem") ? {} : { update: true, migration: true },
      ),
    );
});
test("migration retires named legacy alarms and relocates named policies/filters only", () => {
  validatePlan(
    plan(
      resource(
        "aws_cloudwatch_metric_alarm",
        'aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-cpu"]',
        ["delete"],
      ),
      resource(
        "aws_cloudwatch_log_metric_filter",
        "aws_cloudwatch_log_metric_filter.import_active_upload_age",
        ["delete", "create"],
      ),
      resource("aws_iam_role_policy", "aws_iam_role_policy.api_import[0]", [
        "create",
        "delete",
      ]),
    ),
    { update: true, migration: true },
  );
  assert.throws(() =>
    validatePlan(
      plan(
        resource(
          "aws_cloudwatch_log_metric_filter",
          "aws_cloudwatch_log_metric_filter.other",
          ["delete", "create"],
        ),
      ),
      { migration: true, update: true },
    ),
  );
});
