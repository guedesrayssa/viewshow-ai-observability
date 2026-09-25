import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const PRESETS = Object.freeze({
  baseline: Object.freeze({
    ingestion_snapshot_page_size: "500",
    ingestion_snapshot_prepare_enabled: "false",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  }),
  "phase1-2000": Object.freeze({
    ingestion_snapshot_page_size: "2000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  }),
  "phase1-5000": Object.freeze({
    ingestion_snapshot_page_size: "5000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  }),
  "phase1-10000": Object.freeze({
    ingestion_snapshot_page_size: "10000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  }),
  "phase2-2000": Object.freeze({
    ingestion_snapshot_page_size: "2000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "true",
    import_hot_materialization_enabled: "false",
  }),
  "phase2-5000": Object.freeze({
    ingestion_snapshot_page_size: "5000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "true",
    import_hot_materialization_enabled: "false",
  }),
  "phase2-10000": Object.freeze({
    ingestion_snapshot_page_size: "10000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "true",
    import_hot_materialization_enabled: "false",
  }),
});
const BASE_VARIABLES = Object.freeze({
  deployment_namespace: "view-show",
  regiao: "us-east-1",
  ambiente: "learner-lab",
  bedrock_habilitado: "false",
  observabilidade_habilitada: "false",
  grafana_cidr_acesso: null,
  bastion_admin_cidr: null,
  bastion_key_name: "vockey",
  tipo_instancia_bastion: "t3.micro",
  cpu_task: "256",
  memoria_task: "512",
  quantidade_tasks: "1",
  ecs_capacidade_minima: "1",
  ecs_capacidade_maxima: "4",
  ingestion_backfill_cpu: "2048",
  ingestion_backfill_memoria: "8192",
  ingestion_backfill_ephemeral_storage_gib: "200",
  ingestion_sync_cpu: "1024",
  ingestion_sync_memoria: "2048",
  scheduler_ingestao_habilitado: "false",
  force_destroy_bucket_ingestao: "true",
  force_delete_ecr_ingestao: "true",
  import_canonical_first_production_approved: "false",
  acoes_alarme_ingestao: [],
});
const CHANGE_ALLOWLIST = new Set([
  "terraform_data.ingestion_image[0]",
  "terraform_data.imagem",
  "terraform_data.build_painel",
  "terraform_data.painel",
  "aws_ecs_task_definition.api",
  "aws_ecs_task_definition.ingestion_backfill",
  "aws_ecs_task_definition.ingestion_import",
  "aws_ecs_task_definition.ingestion_sync",
  "aws_ecs_task_definition.ingestion_incremental_export",
  "aws_ecs_task_definition.ingestion_incremental_ingest",
  "aws_ecs_service.api",
  "aws_scheduler_schedule.ingestion_sync",
  "aws_scheduler_schedule.ingestion_incremental_export",
  "aws_scheduler_schedule.ingestion_incremental_ingest",
  "aws_cloudwatch_dashboard.ingestion",
  "aws_cloudwatch_metric_alarm.ingestion_mysql_retries",
  "aws_cloudwatch_metric_alarm.ingestion_mysql_preflight_failures",
  "aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration",
  "aws_s3_bucket_lifecycle_configuration.ingestion",
  "aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning",
  "aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical",
  "aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures",
]);
const REPLACEMENT_ALLOWLIST = new Set(
  [...CHANGE_ALLOWLIST].filter(
    (address) =>
      address.startsWith("terraform_data.") ||
      address.startsWith("aws_ecs_task_definition."),
  ),
);
const PLAN_TOP_LEVEL_KEYS = new Set([
  "format_version",
  "terraform_version",
  "variables",
  "planned_values",
  "proposed_unknown",
  "resource_changes",
  "resource_drift",
  "deferred_changes",
  "deferred_action_invocations",
  "output_changes",
  "action_invocations",
  "prior_state",
  "configuration",
  "relevant_attributes",
  "checks",
  "timestamp",
  "applyable",
  "complete",
  "errored",
]);
const REQUIRED_PLAN_KEYS = [
  "format_version",
  "terraform_version",
  "variables",
  "planned_values",
  "resource_changes",
  "prior_state",
  "configuration",
  "timestamp",
  "applyable",
  "complete",
  "errored",
];
const OUTPUT_CHANGE_ALLOWLIST = new Set([
  "imagem_ecr",
  "ingestion_runbook",
  "comando_ingestion_backfill",
]);
const KNOWN_OUTPUTS = new Set([
  "api_url",
  "api_url_https",
  "aviso_custo",
  "bastion_acesso",
  "cognito_client_id",
  "cognito_client_secret",
  "cognito_hosted_ui_base_url",
  "cognito_issuer_url",
  "cognito_user_pool_id",
  "comando_ingestion_backfill",
  "comando_logs",
  "comando_status_observabilidade",
  "comandos_logs_ingestao",
  "deployment_namespace",
  "ecs_auto_scaling",
  "flow_logs",
  "grafana_acesso",
  "grafana_senha",
  "imagem_ecr",
  "ingestion_runbook",
  "observabilidade_instancia_id",
  "observabilidade_loki_push_url",
  "observabilidade_otlp_workers_endpoint",
  "painel_url",
  "rede_vpc",
  "tabelas_dynamodb",
]);
const PROTECTED_TASK_CONTRACTS = Object.freeze({
  "aws_ecs_task_definition.api": Object.freeze({
    containerName: "view-show-api",
    diskBudgetBytes: null,
    snapshot: false,
    ephemeralStorage: false,
  }),
  "aws_ecs_task_definition.ingestion_backfill": Object.freeze({
    containerName: "ingestion",
    diskBudgetBytes: "68719476736",
    snapshot: true,
    ephemeralStorage: true,
  }),
  "aws_ecs_task_definition.ingestion_import": Object.freeze({
    containerName: "ingestion",
    diskBudgetBytes: "68719476736",
    snapshot: true,
    ephemeralStorage: true,
  }),
  "aws_ecs_task_definition.ingestion_sync": Object.freeze({
    containerName: "ingestion",
    diskBudgetBytes: "8589934592",
    snapshot: false,
    ephemeralStorage: true,
  }),
  "aws_ecs_task_definition.ingestion_incremental_export": Object.freeze({
    containerName: "ingestion",
    diskBudgetBytes: "8589934592",
    snapshot: false,
    ephemeralStorage: true,
  }),
  "aws_ecs_task_definition.ingestion_incremental_ingest": Object.freeze({
    containerName: "ingestion",
    diskBudgetBytes: "17179869184",
    snapshot: false,
    ephemeralStorage: true,
  }),
});
const MUTABLE_LIFECYCLE_PREFIXES = Object.freeze({
  "raw-argus-incremental": "raw/argus/incremental/",
  dumps: "dumps/",
  staging: "staging/",
  "athena-results": "athena-results/",
});

function reject(reason, address = "plan") {
  process.stderr.write(`${address}: rejected ${reason}\n`);
  process.exitCode = 1;
}

function readLimitedInput() {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= MAX_INPUT_BYTES) {
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - totalBytes),
    );
    const bytesRead = fs.readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > MAX_INPUT_BYTES) throw new Error("input exceeds 20 MiB");
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function expectedProvider(type) {
  if (type === "terraform_data") return "terraform.io/builtin/terraform";
  if (type === "archive_file") return "registry.terraform.io/hashicorp/archive";
  if (type.startsWith("aws_")) return "registry.terraform.io/hashicorp/aws";
  if (type.startsWith("random_")) return "registry.terraform.io/hashicorp/random";
  return null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderEmpty(value) {
  if (value === null || value === undefined || value === false || value === "") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isProviderEmpty);
  if (isObject(value)) return Object.values(value).every(isProviderEmpty);
  return false;
}

function containsProtectedUnknown(value) {
  if (Array.isArray(value)) return value.some(containsProtectedUnknown);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([name, child]) =>
      (["container_definitions", "ephemeral_storage"].includes(name) &&
        !isProviderEmpty(child)) ||
      containsProtectedUnknown(child),
  );
}

function environmentMap(container) {
  if (!Array.isArray(container?.environment)) return null;
  const environment = new Map();
  for (const item of container.environment) {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      typeof item.value !== "string" ||
      environment.has(item.name)
    ) {
      return null;
    }
    environment.set(item.name, item.value);
  }
  return environment;
}

function validatesProtectedTaskContract(change, address, preset) {
  const contract = PROTECTED_TASK_CONTRACTS[address];
  if (!contract || !isObject(change.after)) return false;

  const storageIsValid =
    !contract.ephemeralStorage ||
    (Array.isArray(change.after.ephemeral_storage) &&
      change.after.ephemeral_storage.length === 1 &&
      isObject(change.after.ephemeral_storage[0]) &&
      change.after.ephemeral_storage[0].size_in_gib === 200);
  if (!storageIsValid) return false;

  const afterUnknown = change.after_unknown ?? {};
  if (afterUnknown.container_definitions !== undefined) return false;
  if (containsProtectedUnknown(afterUnknown)) return false;
  if (typeof change.after.container_definitions !== "string") return false;

  let containers;
  try {
    containers = JSON.parse(change.after.container_definitions);
  } catch {
    return false;
  }
  if (!Array.isArray(containers)) return false;
  const matching = containers.filter(
    (container) => isObject(container) && container.name === contract.containerName,
  );
  if (matching.length !== 1) return false;
  const environment = environmentMap(matching[0]);
  if (environment === null) return false;

  const selected = PRESETS[preset];
  const expectedEnvironment =
    address === "aws_ecs_task_definition.api"
      ? {
          IMPORT_CANONICAL_FIRST_ENABLED: selected.import_canonical_first_enabled,
        }
      : {
          INGESTION_DISK_BUDGET_BYTES: contract.diskBudgetBytes,
          ...(contract.snapshot
            ? {
                PAGE_SIZE: selected.ingestion_snapshot_page_size,
                MYSQL_SNAPSHOT_PREPARE_ENABLED:
                  selected.ingestion_snapshot_prepare_enabled,
                IMPORT_HOT_MATERIALIZATION_ENABLED:
                  selected.import_hot_materialization_enabled,
              }
            : {}),
        };
  if (
    Object.entries(expectedEnvironment).some(
      ([name, value]) => environment.get(name) !== String(value),
    )
  ) {
    return false;
  }

  return true;
}

function hasOnlyExpectedOrEmptyProperties(value, expected) {
  if (!isObject(value)) return false;
  for (const [name, actual] of Object.entries(value)) {
    if (Object.hasOwn(expected, name)) {
      const allowed = expected[name];
      if (
        allowed instanceof Set
          ? !allowed.has(actual)
          : !isDeepStrictEqual(actual, allowed)
      ) {
        return false;
      }
    } else if (!isProviderEmpty(actual)) {
      return false;
    }
  }
  return Object.keys(expected).every((name) => Object.hasOwn(value, name));
}

function isExactCanonicalStagingRule(rule) {
  if (!isObject(rule)) return false;
  if (
    rule.id !== "staging-canonical-expiration" ||
    rule.status !== "Enabled" ||
    !Array.isArray(rule.filter) ||
    rule.filter.length !== 1 ||
    !hasOnlyExpectedOrEmptyProperties(rule.filter[0], {
      prefix: "staging/canonical/",
    }) ||
    !Array.isArray(rule.expiration) ||
    rule.expiration.length !== 1 ||
    !hasOnlyExpectedOrEmptyProperties(rule.expiration[0], {
      days: 7,
      expired_object_delete_marker: new Set([null, false]),
    }) ||
    !Array.isArray(rule.noncurrent_version_expiration) ||
    rule.noncurrent_version_expiration.length !== 1 ||
    !hasOnlyExpectedOrEmptyProperties(rule.noncurrent_version_expiration[0], {
      noncurrent_days: 7,
    }) ||
    !Array.isArray(rule.abort_incomplete_multipart_upload) ||
    rule.abort_incomplete_multipart_upload.length !== 1 ||
    !hasOnlyExpectedOrEmptyProperties(rule.abort_incomplete_multipart_upload[0], {
      days_after_initiation: 1,
    })
  ) {
    return false;
  }

  const known = new Set([
    "id",
    "status",
    "filter",
    "expiration",
    "noncurrent_version_expiration",
    "abort_incomplete_multipart_upload",
  ]);
  return Object.entries(rule).every(
    ([name, value]) => known.has(name) || isProviderEmpty(value),
  );
}

function lifecyclePrefix(rule) {
  if (!isObject(rule) || !Array.isArray(rule.filter) || rule.filter.length !== 1) {
    return null;
  }
  const prefix = rule.filter[0]?.prefix;
  return typeof prefix === "string" && prefix.length > 0 ? prefix : null;
}

function lifecycleRuleIsolatedFromCanonical(rule) {
  const prefix = lifecyclePrefix(rule);
  return (
    prefix !== null &&
    !prefix.startsWith("canonical/") &&
    !"canonical/".startsWith(prefix)
  );
}

function lifecycleRuleHasOnlyKnownProperties(rule) {
  const known = new Set([
    "id",
    "status",
    "filter",
    "expiration",
    "noncurrent_version_expiration",
    "abort_incomplete_multipart_upload",
  ]);
  return Object.entries(rule).every(
    ([name, value]) => known.has(name) || isProviderEmpty(value),
  );
}

function isExactLegacyGlobalCleanupRule(rule) {
  if (
    !isObject(rule) ||
    rule.status !== "Enabled" ||
    !lifecycleRuleHasOnlyKnownProperties(rule)
  ) {
    return false;
  }
  const globalFilter =
    (Array.isArray(rule.filter) && rule.filter.length === 0) ||
    (Array.isArray(rule.filter) &&
      rule.filter.length === 1 &&
      hasOnlyExpectedOrEmptyProperties(rule.filter[0], {
        prefix: new Set([null, ""]),
      }));
  if (!globalFilter) return false;

  if (rule.id === "abort-incomplete-multipart") {
    return (
      Array.isArray(rule.expiration) &&
      rule.expiration.length === 0 &&
      Array.isArray(rule.noncurrent_version_expiration) &&
      rule.noncurrent_version_expiration.length === 0 &&
      Array.isArray(rule.abort_incomplete_multipart_upload) &&
      rule.abort_incomplete_multipart_upload.length === 1 &&
      hasOnlyExpectedOrEmptyProperties(rule.abort_incomplete_multipart_upload[0], {
        days_after_initiation: 1,
      })
    );
  }
  if (rule.id === "expired-delete-markers") {
    return (
      Array.isArray(rule.expiration) &&
      rule.expiration.length === 1 &&
      hasOnlyExpectedOrEmptyProperties(rule.expiration[0], {
        days: new Set([null, 0]),
        expired_object_delete_marker: true,
      }) &&
      Array.isArray(rule.noncurrent_version_expiration) &&
      rule.noncurrent_version_expiration.length === 0 &&
      Array.isArray(rule.abort_incomplete_multipart_upload) &&
      rule.abort_incomplete_multipart_upload.length === 0
    );
  }
  return false;
}

function isExactScopedCleanupRule(rule) {
  if (
    !isObject(rule) ||
    rule.status !== "Enabled" ||
    !lifecycleRuleHasOnlyKnownProperties(rule)
  ) {
    return false;
  }
  for (const [baseId, prefix] of Object.entries(MUTABLE_LIFECYCLE_PREFIXES)) {
    if (
      !Array.isArray(rule.filter) ||
      rule.filter.length !== 1 ||
      !hasOnlyExpectedOrEmptyProperties(rule.filter[0], { prefix }) ||
      !Array.isArray(rule.noncurrent_version_expiration) ||
      rule.noncurrent_version_expiration.length !== 0
    ) {
      continue;
    }
    if (rule.id === `${baseId}-abort-multipart`) {
      return (
        Array.isArray(rule.expiration) &&
        rule.expiration.length === 0 &&
        Array.isArray(rule.abort_incomplete_multipart_upload) &&
        rule.abort_incomplete_multipart_upload.length === 1 &&
        hasOnlyExpectedOrEmptyProperties(rule.abort_incomplete_multipart_upload[0], {
          days_after_initiation: 1,
        })
      );
    }
    if (rule.id === `${baseId}-expired-delete-markers`) {
      return (
        Array.isArray(rule.expiration) &&
        rule.expiration.length === 1 &&
        hasOnlyExpectedOrEmptyProperties(rule.expiration[0], {
          days: new Set([null, 0]),
          expired_object_delete_marker: true,
        }) &&
        Array.isArray(rule.abort_incomplete_multipart_upload) &&
        rule.abort_incomplete_multipart_upload.length === 0
      );
    }
  }
  return false;
}

function ruleMap(rules) {
  const mapped = new Map();
  for (const rule of rules) {
    if (!isObject(rule) || typeof rule.id !== "string" || mapped.has(rule.id)) {
      return null;
    }
    mapped.set(rule.id, rule);
  }
  return mapped;
}

function validatesScopedCanonicalLifecycleMigration(change) {
  if (!isDeepStrictEqual(change.actions, ["update"])) return false;
  if (!isObject(change.before) || !isObject(change.after)) return false;
  if (Object.hasOwn(change, "after_unknown") && !isProviderEmpty(change.after_unknown)) {
    return false;
  }

  const beforeRules = change.before.rule;
  const afterRules = change.after.rule;
  if (!Array.isArray(beforeRules) || !Array.isArray(afterRules)) return false;
  const beforeById = ruleMap(beforeRules);
  const afterById = ruleMap(afterRules);
  if (beforeById === null || afterById === null) return false;

  const beforeOuter = { ...change.before };
  const afterOuter = { ...change.after };
  delete beforeOuter.rule;
  delete afterOuter.rule;
  if (!isDeepStrictEqual(beforeOuter, afterOuter)) return false;

  for (const rule of afterRules) {
    if (!lifecycleRuleIsolatedFromCanonical(rule)) return false;
  }
  for (const rule of beforeRules) {
    if (lifecycleRuleIsolatedFromCanonical(rule)) {
      if (!isDeepStrictEqual(afterById.get(rule.id), rule)) return false;
    } else if (!isExactLegacyGlobalCleanupRule(rule)) {
      return false;
    }
  }
  if (
    afterById.has("abort-incomplete-multipart") ||
    afterById.has("expired-delete-markers") ||
    !isExactCanonicalStagingRule(afterById.get("staging-canonical-expiration"))
  ) {
    return false;
  }

  const requiredAdditions = new Set(["staging-canonical-expiration"]);
  for (const baseId of Object.keys(MUTABLE_LIFECYCLE_PREFIXES)) {
    requiredAdditions.add(`${baseId}-abort-multipart`);
    requiredAdditions.add(`${baseId}-expired-delete-markers`);
  }
  for (const id of requiredAdditions) {
    const rule = afterById.get(id);
    if (
      rule === undefined ||
      (id !== "staging-canonical-expiration" && !isExactScopedCleanupRule(rule))
    ) {
      return false;
    }
  }
  for (const rule of afterRules) {
    if (!beforeById.has(rule.id) && !requiredAdditions.has(rule.id)) return false;
  }
  return true;
}

function validatesSafeLifecycleState(change) {
  if (!isObject(change.after) || !Array.isArray(change.after.rule)) return false;
  if (Object.hasOwn(change, "after_unknown") && !isProviderEmpty(change.after_unknown)) {
    return false;
  }
  const afterById = ruleMap(change.after.rule);
  if (
    afterById === null ||
    change.after.rule.some((rule) => !lifecycleRuleIsolatedFromCanonical(rule)) ||
    !isExactCanonicalStagingRule(afterById.get("staging-canonical-expiration"))
  ) {
    return false;
  }
  for (const baseId of Object.keys(MUTABLE_LIFECYCLE_PREFIXES)) {
    for (const suffix of ["abort-multipart", "expired-delete-markers"]) {
      if (!isExactScopedCleanupRule(afterById.get(`${baseId}-${suffix}`))) return false;
    }
  }
  return true;
}

function validateOutputChanges(outputChanges) {
  if (!isObject(outputChanges)) {
    reject("invalid output_changes structure");
    return false;
  }
  for (const [name, change] of Object.entries(outputChanges)) {
    if (!isObject(change)) {
      reject("unexpected output change");
      return false;
    }
    if (
      !Array.isArray(change.actions) ||
      change.actions.length !== 1 ||
      !["no-op", "update"].includes(change.actions[0])
    ) {
      reject("output action must be update or no-op");
      return false;
    }
    if (!KNOWN_OUTPUTS.has(name)) {
      reject("unexpected output change");
      return false;
    }
    if (change.actions[0] === "no-op") continue;
    if (!OUTPUT_CHANGE_ALLOWLIST.has(name)) {
      reject("unexpected output change");
      return false;
    }
    if (change.before_sensitive !== false || change.after_sensitive !== false) {
      reject("sensitive output changes are not allowed");
      return false;
    }
  }
  return true;
}

function validateChecks(checks) {
  if (!Array.isArray(checks)) return false;
  return checks.every((check) => {
    if (
      !isObject(check) ||
      !isObject(check.address) ||
      !["pass", "unknown"].includes(check.status)
    ) {
      return false;
    }
    if (!Object.hasOwn(check, "instances")) return true;
    return (
      Array.isArray(check.instances) &&
      check.instances.every(
        (instance) =>
          isObject(instance) && ["pass", "unknown"].includes(instance.status),
      )
    );
  });
}

function validatePlanEnvelope(plan) {
  if (!isObject(plan)) {
    reject("invalid plan structure");
    return false;
  }
  if (plan.format_version !== "1.2") {
    reject("unsupported format_version");
    return false;
  }
  if (Object.keys(plan).some((key) => !PLAN_TOP_LEVEL_KEYS.has(key))) {
    reject("unknown top-level plan category");
    return false;
  }
  if (REQUIRED_PLAN_KEYS.some((key) => !Object.hasOwn(plan, key))) {
    reject("incomplete plan structure");
    return false;
  }
  if (
    typeof plan.terraform_version !== "string" ||
    plan.terraform_version.length === 0 ||
    !isObject(plan.variables) ||
    !isObject(plan.planned_values) ||
    !Array.isArray(plan.resource_changes) ||
    !isObject(plan.prior_state) ||
    !isObject(plan.configuration) ||
    typeof plan.timestamp !== "string" ||
    Number.isNaN(Date.parse(plan.timestamp)) ||
    plan.applyable !== true ||
    plan.complete !== true ||
    plan.errored !== false
  ) {
    reject("invalid or unsafe plan structure");
    return false;
  }
  if (Object.hasOwn(plan, "proposed_unknown") && !isObject(plan.proposed_unknown)) {
    reject("invalid proposed_unknown structure");
    return false;
  }
  if (
    Object.hasOwn(plan, "resource_drift") &&
    (!Array.isArray(plan.resource_drift) || plan.resource_drift.length > 0)
  ) {
    reject("resource drift is not allowed");
    return false;
  }
  for (const category of [
    "deferred_changes",
    "deferred_action_invocations",
    "action_invocations",
  ]) {
    if (
      Object.hasOwn(plan, category) &&
      (!Array.isArray(plan[category]) || plan[category].length > 0)
    ) {
      reject("deferred changes and action invocations are not allowed");
      return false;
    }
  }
  if (
    Object.hasOwn(plan, "relevant_attributes") &&
    (!Array.isArray(plan.relevant_attributes) ||
      plan.relevant_attributes.some(
        (item) =>
          !isObject(item) ||
          typeof item.resource !== "string" ||
          !Array.isArray(item.attribute),
      ))
  ) {
    reject("invalid relevant_attributes structure");
    return false;
  }
  if (Object.hasOwn(plan, "checks") && !validateChecks(plan.checks)) {
    reject("invalid or failed checks structure");
    return false;
  }
  return validateOutputChanges(plan.output_changes ?? {});
}

function variablesMatch(plan, preset) {
  const expected = { ...BASE_VARIABLES, ...PRESETS[preset] };
  return Object.entries(expected).every(
    ([name, value]) =>
      Object.hasOwn(plan.variables ?? {}, name) &&
      JSON.stringify(plan.variables[name]?.value) === JSON.stringify(value),
  );
}

const preset = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(PRESETS, preset)) {
  reject("expected exactly one hardcoded preset");
}

let plan;
if (process.exitCode === undefined) {
  try {
    plan = JSON.parse(readLimitedInput());
  } catch (error) {
    reject(error instanceof Error ? error.message : "invalid JSON document");
  }
}

if (process.exitCode === undefined) {
  if (!validatePlanEnvelope(plan)) {
    // validatePlanEnvelope reports a generic reason without echoing plan values.
  } else if (!variablesMatch(plan, preset)) {
    reject("variables do not match the safe Learner Lab preset");
  } else if (containsProtectedUnknown(plan.proposed_unknown ?? {})) {
    reject("protected task values cannot remain unknown");
  }
}

if (process.exitCode === undefined) {
  const seen = new Set();
  for (const resourceChange of plan.resource_changes) {
    if (
      resourceChange === null ||
      typeof resourceChange !== "object" ||
      Array.isArray(resourceChange)
    ) {
      reject("invalid resource change");
      break;
    }
    const address = resourceChange.address;
    if (typeof address !== "string" || address.length === 0) {
      reject("invalid resource address");
      break;
    }
    if (seen.has(address)) {
      reject("duplicate address", address);
      break;
    }
    seen.add(address);

    const change = resourceChange.change;
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      reject("invalid change", address);
      break;
    }
    if (
      Object.hasOwn(resourceChange, "previous_address") ||
      Object.hasOwn(change, "previous_address")
    ) {
      reject("previous_address is not allowed", address);
      break;
    }
    if (Object.hasOwn(change, "importing")) {
      reject("importing is not allowed", address);
      break;
    }

    const provider = expectedProvider(resourceChange.type ?? "");
    if (provider === null || resourceChange.provider_name !== provider) {
      reject("provider change or unknown provider", address);
      break;
    }
    const actions = change.actions;
    if (!Array.isArray(actions) || actions.some((action) => typeof action !== "string")) {
      reject("invalid actions", address);
      break;
    }
    if (resourceChange.mode === "data") {
      if (
        actions.length !== 1 ||
        !["read", "no-op"].includes(actions[0])
      ) {
        reject("data action must be read or no-op", address);
        break;
      }
      continue;
    }
    if (resourceChange.mode !== "managed") {
      reject("unexpected resource mode", address);
      break;
    }
    if (actions.length === 1 && actions[0] === "delete") {
      reject("isolated delete is not allowed", address);
      break;
    }
    if (
      Object.hasOwn(PROTECTED_TASK_CONTRACTS, address) &&
      !validatesProtectedTaskContract(change, address, preset)
    ) {
      reject("task budget, flags, storage, or unknown values violate the rollout contract", address);
      break;
    }
    if (actions.length === 1 && actions[0] === "no-op") {
      if (
        address === "aws_s3_bucket_lifecycle_configuration.ingestion" &&
        !validatesSafeLifecycleState(change)
      ) {
        reject("lifecycle state contains a bucket-wide or canonical prefix", address);
        break;
      }
      continue;
    }
    if (!CHANGE_ALLOWLIST.has(address)) {
      reject("change is outside the update allowlist", address);
      break;
    }
    if (address === "aws_s3_bucket_lifecycle_configuration.ingestion") {
      if (!validatesScopedCanonicalLifecycleMigration(change)) {
        reject("lifecycle change must migrate exact global cleanup to scoped safe rules", address);
        break;
      }
      continue;
    }
    if (
      actions.length === 1 &&
      ["create", "update"].includes(actions[0])
    ) {
      continue;
    }
    const replacement =
      actions.length === 2 &&
      actions.includes("create") &&
      actions.includes("delete");
    if (replacement && REPLACEMENT_ALLOWLIST.has(address)) continue;
    reject(replacement ? "replacement is not allowed" : "unexpected actions", address);
    break;
  }
}

if (process.exitCode === undefined) {
  process.stdout.write(`update plan accepted for preset ${preset}\n`);
}
