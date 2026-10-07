import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const retiredTypes = new Set([
  "aws_ecs_cluster",
  "aws_ecs_cluster_capacity_providers",
  "aws_ecs_service",
  "aws_ecs_task_definition",
  "aws_appautoscaling_target",
  "aws_appautoscaling_policy",
  "aws_scheduler_schedule",
  "aws_scheduler_schedule_group",
]);
const supportedTypes = new Set([
  "aws_amplify_app",
  "aws_amplify_branch",
  "aws_apigatewayv2_api",
  "aws_apigatewayv2_integration",
  "aws_apigatewayv2_route",
  "aws_apigatewayv2_stage",
  "aws_athena_workgroup",
  "aws_autoscaling_group_tag",
  "aws_cloudwatch_dashboard",
  "aws_cloudwatch_log_group",
  "aws_cloudwatch_log_metric_filter",
  "aws_cloudwatch_metric_alarm",
  "aws_cognito_user_pool",
  "aws_cognito_user_pool_client",
  "aws_cognito_user_pool_domain",
  "aws_dynamodb_table",
  "aws_ecr_repository",
  "aws_ecr_lifecycle_policy",
  "aws_eip",
  "aws_eks_cluster",
  "aws_eks_access_entry",
  "aws_eks_access_policy_association",
  "aws_eks_node_group",
  "aws_eks_addon",
  "aws_eks_pod_identity_association",
  "aws_flow_log",
  "aws_glue_catalog_database",
  "aws_iam_role",
  "aws_iam_instance_profile",
  "aws_iam_role_policy",
  "aws_iam_role_policy_attachment",
  "aws_iam_openid_connect_provider",
  "aws_instance",
  "aws_internet_gateway",
  "aws_launch_template",
  "aws_lb",
  "aws_lb_listener",
  "aws_lb_target_group",
  "aws_nat_gateway",
  "aws_route",
  "aws_route_table",
  "aws_route_table_association",
  "aws_s3_bucket",
  "aws_s3_bucket_cors_configuration",
  "aws_s3_bucket_versioning",
  "aws_s3_bucket_lifecycle_configuration",
  "aws_s3_bucket_ownership_controls",
  "aws_s3_bucket_policy",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_object",
  "aws_secretsmanager_secret",
  "aws_secretsmanager_secret_version",
  "aws_security_group",
  "aws_security_group_rule",
  "aws_sqs_queue",
  "aws_sqs_queue_redrive_allow_policy",
  "aws_subnet",
  "aws_vpc",
  "aws_vpc_endpoint",
  "random_password",
  "terraform_data",
]);
// In-place updates are fail-closed. These resource classes cannot alter
// application data, identity, network reachability or the cluster runtime.
const auditedUpdateTypes = new Set([
  "terraform_data",
  "aws_cloudwatch_dashboard",
  "aws_s3_bucket_cors_configuration",
  "aws_cloudwatch_log_metric_filter",
  "aws_cloudwatch_metric_alarm",
]);
const retiredAddresses = new Set([
  "aws_security_group.ingestion",
  "aws_iam_role_policy.api_argus_live_sync[0]",
  "aws_iam_role_policy.ingestion_incremental_scheduler[0]",
  "aws_cloudwatch_metric_alarm.scheduler_dlq_depth",
  "aws_cloudwatch_metric_alarm.scheduler_target_errors",
  ...["backfill", "sync"].flatMap((job) =>
    ["cpu", "memory", "storage"].map(
      (metric) =>
        `aws_cloudwatch_metric_alarm.ingestion_resource_utilization["${job}-${metric}"]`,
    ),
  ),
]);
// Only build wrappers without destroy provisioners can be replaced on updates.
const rebuildAddresses = new Set([
  "terraform_data.imagem",
  "terraform_data.ingestion_image[0]",
  "terraform_data.analysis_worker_image[0]",
  "terraform_data.build_painel",
  "terraform_data.painel",
]);
const migrationReplacementAddresses = new Set([
  "aws_cloudwatch_log_metric_filter.import_active_upload_age",
  "aws_cloudwatch_log_metric_filter.import_reconciliation_failures",
  ...[
    "api_import",
    "ingestion_import",
    "ingestion_incremental_export",
    "ingestion_incremental_ingest",
  ].map((name) => `aws_iam_role_policy.${name}[0]`),
]);
const singleActions = new Set([
  "no-op", "read", "create", "update", "delete", "forget",
]);
export function validatePlan(plan, { migration = false, update = false } = {}) {
  if (
    !Array.isArray(plan.resource_changes) ||
    plan.errored ||
    plan.complete === false ||
    (plan.applyable === false &&
      !(plan.complete === true && plan.resource_changes.every(
        (change) => change.change?.actions?.length === 1 &&
          change.change.actions[0] === "no-op",
      )))
  )
    throw new Error("Invalid or failed Terraform plan.");
  const addresses = new Set();
  for (const change of plan.resource_changes) {
    if (
      !change ||
      !["managed", "data"].includes(change.mode) ||
      typeof change.type !== "string" || change.type.length === 0 ||
      typeof change.address !== "string" || change.address.length === 0 ||
      !change.address.startsWith(
        `${change.mode === "data" ? "data." : ""}${change.type}.`,
      )
    )
      throw new Error("Invalid resource identity.");
    if (addresses.has(change.address))
      throw new Error(`Duplicate resource address: ${change.address}`);
    addresses.add(change.address);
    const actions = change.change?.actions;
    if (
      !Array.isArray(actions) ||
      !(
        (actions.length === 1 && singleActions.has(actions[0])) ||
        (actions.length === 2 &&
          ((actions[0] === "create" && actions[1] === "delete") ||
            (actions[0] === "delete" && actions[1] === "create")))
      )
    )
      throw new Error("Invalid actions.");
    if (change.mode === "data") {
      if (actions.every((a) => ["read", "no-op"].includes(a))) continue;
      throw new Error("Data mutation rejected.");
    }
    if (retiredTypes.has(change.type) && actions.includes("create"))
      throw new Error("Creating ECS/EventBridge runtime is forbidden.");
    const retiring =
      migration &&
      actions.length === 1 &&
      actions[0] === "delete" &&
      (retiredTypes.has(change.type) || retiredAddresses.has(change.address));
    if (retiring) continue;
    if (
      migration &&
      actions.length === 1 &&
      actions[0] === "forget" &&
      /^(aws_cloudwatch_log_group\.(api|ingestion_backfill|ingestion_sync|ingestion_incremental_export|ingestion_incremental_ingest|analysis_worker)(\[0\])?|aws_sqs_queue\.ingestion_scheduler_dlq)$/.test(
        change.address,
      )
    )
      continue;
    const replacement =
      actions.length === 2 &&
      actions.includes("create") &&
      actions.includes("delete");
    if (
      replacement &&
      update &&
      (rebuildAddresses.has(change.address) ||
        (migration && migrationReplacementAddresses.has(change.address)))
    )
      continue;
    if (actions.includes("delete"))
      throw new Error(`Deletion/replacement rejected: ${change.address}`);
    if (
      !supportedTypes.has(change.type) ||
      !actions.every((a) =>
        [
          "create",
          "no-op",
          ...(update && auditedUpdateTypes.has(change.type) ? ["update"] : []),
        ].includes(a),
      )
    )
      throw new Error(`Unexpected change: ${change.address}`);
  }
  const clusters = plan.resource_changes.filter(
    (c) => c.mode === "managed" && c.type === "aws_eks_cluster" &&
      c.address === "aws_eks_cluster.principal",
  );
  if (
    clusters.length !== 1 ||
    clusters[0].change.actions.length !== 1 ||
    !["create", "no-op"].includes(clusters[0].change.actions[0])
  )
    throw new Error("EKS cluster missing from plan.");
}
export function main(argv = process.argv.slice(2)) {
  const filename = argv.find((value) => !value.startsWith("--"));
  const input = readFileSync(filename ?? 0, "utf8");
  if (Buffer.byteLength(input) > 32 * 1024 * 1024)
    throw new Error("Plan too large.");
  validatePlan(JSON.parse(input), {
    migration: argv.includes("--migration"),
    update: argv.includes("--update"),
  });
  process.stdout.write(
    "Plano Kubernetes validado; nenhuma exclusão de dados persistentes autorizada.\n",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
