// Contract tests for the local Terraform update-plan validator.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VALIDATOR = path.join(
  ROOT,
  "apps",
  "scripts",
  "terraform",
  "validate-learner-update-plan.mjs",
);

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

const PRESETS = Object.freeze({
  baseline: {
    ingestion_snapshot_page_size: "500",
    ingestion_snapshot_prepare_enabled: "false",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  },
  "phase1-2000": {
    ingestion_snapshot_page_size: "2000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  },
  "phase1-5000": {
    ingestion_snapshot_page_size: "5000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  },
  "phase1-10000": {
    ingestion_snapshot_page_size: "10000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "false",
    import_hot_materialization_enabled: "false",
  },
  "phase2-2000": {
    ingestion_snapshot_page_size: "2000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "true",
    import_hot_materialization_enabled: "false",
  },
  "phase2-5000": {
    ingestion_snapshot_page_size: "5000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "true",
    import_hot_materialization_enabled: "false",
  },
  "phase2-10000": {
    ingestion_snapshot_page_size: "10000",
    ingestion_snapshot_prepare_enabled: "true",
    import_canonical_first_enabled: "true",
    import_hot_materialization_enabled: "false",
  },
});

const MUTABLE_PREFIXES = Object.freeze({
  "raw-argus-incremental": "raw/argus/incremental/",
  dumps: "dumps/",
  staging: "staging/",
  "athena-results": "athena-results/",
});

function expirationRule(id, prefix, days, noncurrentDays) {
  return {
    id,
    status: "Enabled",
    filter: [{ prefix }],
    expiration: [{ days, expired_object_delete_marker: false }],
    noncurrent_version_expiration: [{ noncurrent_days: noncurrentDays }],
    abort_incomplete_multipart_upload: [],
  };
}

const EXISTING_LIFECYCLE_RULES = Object.freeze([
  expirationRule("raw-argus-incremental", "raw/argus/incremental/", 89, 1),
  expirationRule("dumps", "dumps/", 30, 30),
  expirationRule("staging", "staging/", 7, 7),
  expirationRule("athena-results", "athena-results/", 7, 7),
]);
const LEGACY_GLOBAL_ABORT_RULE = Object.freeze({
  id: "abort-incomplete-multipart",
  status: "Enabled",
  filter: [{ prefix: null }],
  expiration: [],
  noncurrent_version_expiration: [],
  abort_incomplete_multipart_upload: [{ days_after_initiation: 1 }],
});
const LEGACY_GLOBAL_DELETE_MARKER_RULE = Object.freeze({
  id: "expired-delete-markers",
  status: "Enabled",
  filter: [{ prefix: null }],
  expiration: [{ days: null, expired_object_delete_marker: true }],
  noncurrent_version_expiration: [],
  abort_incomplete_multipart_upload: [],
});
const CANONICAL_STAGING_RULE = Object.freeze({
  id: "staging-canonical-expiration",
  status: "Enabled",
  filter: [{ prefix: "staging/canonical/" }],
  expiration: [{ days: 7, expired_object_delete_marker: null }],
  noncurrent_version_expiration: [{ noncurrent_days: 7 }],
  abort_incomplete_multipart_upload: [{ days_after_initiation: 1 }],
});

function scopedCleanupRules() {
  return Object.entries(MUTABLE_PREFIXES).flatMap(([baseId, prefix]) => [
    {
      id: `${baseId}-abort-multipart`,
      status: "Enabled",
      filter: [{ prefix }],
      expiration: [],
      noncurrent_version_expiration: [],
      abort_incomplete_multipart_upload: [{ days_after_initiation: 1 }],
    },
    {
      id: `${baseId}-expired-delete-markers`,
      status: "Enabled",
      filter: [{ prefix }],
      expiration: [{ days: null, expired_object_delete_marker: true }],
      noncurrent_version_expiration: [],
      abort_incomplete_multipart_upload: [],
    },
  ]);
}

function variablesFor(preset, overrides = {}) {
  return Object.fromEntries(
    Object.entries({ ...BASE_VARIABLES, ...PRESETS[preset], ...overrides }).map(
      ([name, value]) => [name, { value }],
    ),
  );
}

function resourceChange(
  address,
  actions = ["update"],
  providerName = address.startsWith("terraform_data.")
    ? "terraform.io/builtin/terraform"
    : "registry.terraform.io/hashicorp/aws",
) {
  const [type, name] = address.split(".");
  return {
    address,
    mode: "managed",
    type,
    name,
    provider_name: providerName,
    change: { actions, before: {}, after: {} },
  };
}

function protectedEnvironment(address, preset) {
  const selected = PRESETS[preset];
  if (address === "aws_ecs_task_definition.api") {
    return [
      {
        name: "IMPORT_CANONICAL_FIRST_ENABLED",
        value: String(selected.import_canonical_first_enabled),
      },
    ];
  }
  const diskBudgets = {
    "aws_ecs_task_definition.ingestion_backfill": "68719476736",
    "aws_ecs_task_definition.ingestion_import": "68719476736",
    "aws_ecs_task_definition.ingestion_sync": "8589934592",
    "aws_ecs_task_definition.ingestion_incremental_export": "8589934592",
    "aws_ecs_task_definition.ingestion_incremental_ingest": "17179869184",
  };
  const environment = [
    { name: "INGESTION_DISK_BUDGET_BYTES", value: diskBudgets[address] },
  ];
  if (
    address === "aws_ecs_task_definition.ingestion_backfill" ||
    address === "aws_ecs_task_definition.ingestion_import"
  ) {
    environment.push(
      { name: "PAGE_SIZE", value: String(selected.ingestion_snapshot_page_size) },
      {
        name: "MYSQL_SNAPSHOT_PREPARE_ENABLED",
        value: String(selected.ingestion_snapshot_prepare_enabled),
      },
      {
        name: "IMPORT_HOT_MATERIALIZATION_ENABLED",
        value: String(selected.import_hot_materialization_enabled),
      },
    );
  }
  return environment;
}

function taskDefinitionChange(address, preset, actions = ["update"]) {
  const change = resourceChange(address, actions);
  const primaryName = address === "aws_ecs_task_definition.api" ? "view-show-api" : "ingestion";
  change.change.after = {
    container_definitions: JSON.stringify([
      {
        name: primaryName,
        image: "example.invalid/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        environment: protectedEnvironment(address, preset),
      },
    ]),
    ...(address === "aws_ecs_task_definition.api"
      ? {}
      : { ephemeral_storage: [{ size_in_gib: 200 }] }),
  };
  change.change.after_unknown = {};
  return change;
}

function unknownTaskDefinitionChange(address, actions = ["delete", "create"]) {
  const change = resourceChange(address, actions);
  change.change.after = {
    ...(address === "aws_ecs_task_definition.api"
      ? {}
      : { ephemeral_storage: [{ size_in_gib: 200 }] }),
  };
  change.change.after_unknown = {
    container_definitions: true,
    ...(address === "aws_ecs_task_definition.api"
      ? { ephemeral_storage: [] }
      : { ephemeral_storage: [{}] }),
  };
  return change;
}

function configureUnknownTask(planDocument, address, references) {
  planDocument.configuration.root_module.resources = [
    {
      address,
      mode: "managed",
      type: "aws_ecs_task_definition",
      name: address.split(".").at(-1),
      expressions: {
        container_definitions: { references },
      },
    },
  ];
  return planDocument;
}

function lifecycleMigrationChange() {
  const change = resourceChange("aws_s3_bucket_lifecycle_configuration.ingestion");
  const shared = {
    bucket: "view-show-ingestion-111122223333-us-east-1",
    expected_bucket_owner: null,
  };
  change.change.before = {
    ...shared,
    rule: [
      ...structuredClone(EXISTING_LIFECYCLE_RULES),
      structuredClone(LEGACY_GLOBAL_ABORT_RULE),
      structuredClone(LEGACY_GLOBAL_DELETE_MARKER_RULE),
    ],
  };
  change.change.after = {
    ...shared,
    rule: [
      ...structuredClone(EXISTING_LIFECYCLE_RULES),
      structuredClone(CANONICAL_STAGING_RULE),
      ...scopedCleanupRules(),
    ],
  };
  change.change.after_unknown = {};
  return change;
}

function safeLifecycleNoOpChange() {
  const change = lifecycleMigrationChange();
  change.change.actions = ["no-op"];
  change.change.before = structuredClone(change.change.after);
  return change;
}

function plan(preset, resourceChanges = [], overrides = {}) {
  return {
    format_version: "1.2",
    terraform_version: "1.14.3",
    planned_values: { root_module: { resources: [] } },
    variables: variablesFor(preset, overrides),
    resource_changes: resourceChanges,
    resource_drift: [],
    output_changes: {},
    prior_state: { terraform_version: "1.14.3", values: {} },
    configuration: { provider_config: {}, root_module: {} },
    relevant_attributes: [],
    checks: [],
    timestamp: "2026-09-21T12:34:56Z",
    applyable: true,
    complete: true,
    errored: false,
  };
}

function validate(payload, preset = "phase1-5000", extraArgs = []) {
  return spawnSync("node", [VALIDATOR, preset, ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("the seven hardcoded presets accept only their exact rollout flags and page size", () => {
  for (const preset of Object.keys(PRESETS)) {
    const result = validate(
      plan(preset, [taskDefinitionChange("aws_ecs_task_definition.ingestion_import", preset)]),
      preset,
    );

    assert.equal(result.status, 0, `${preset}: ${result.stderr}`);
    assert.match(result.stdout, /update plan accepted/i);
  }
});

test("a missing or changed base/preset variable fails closed without exposing values", () => {
  const secret = "must-not-be-printed";
  const cases = [
    plan("phase1-5000", [], { quantidade_tasks: 2 }),
    plan("phase1-5000", [], { ingestion_snapshot_page_size: 4999 }),
    plan("phase1-5000", [], { ingestion_snapshot_prepare_enabled: false }),
    plan("phase1-5000", [], { import_canonical_first_enabled: true }),
    plan("phase2-5000", [], { import_canonical_first_enabled: false }),
    plan("phase2-5000", [], { import_hot_materialization_enabled: true }),
    plan("phase2-5000", [], { import_canonical_first_production_approved: true }),
  ];
  delete cases[0].variables.regiao;
  cases.push(plan("phase1-5000", [], { imagem_ingestao: secret, ambiente: secret }));

  for (const candidate of cases) {
    const result = validate(candidate);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  }
});

test("only the documented stateless update allowlist can change", () => {
  const addresses = [
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
    "aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning",
    "aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical",
    "aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures",
  ];
  const result = validate(
    plan("phase2-5000", [
      ...addresses.map((address) =>
        address.startsWith("aws_ecs_task_definition.")
          ? taskDefinitionChange(address, "phase2-5000")
          : resourceChange(address),
      ),
      lifecycleMigrationChange(),
    ]),
    "phase2-5000",
  );

  assert.equal(result.status, 0, result.stderr);
});

test("phase1 rollback presets preserve phase2 storage and alarms while disabling only canonical-first", () => {
  const preserved = [
    safeLifecycleNoOpChange(),
    resourceChange("aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning", ["no-op"]),
    resourceChange("aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical", ["no-op"]),
    resourceChange("aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures", ["no-op"]),
    taskDefinitionChange("aws_ecs_task_definition.api", "phase1-10000"),
  ];
  const result = validate(plan("phase1-10000", preserved), "phase1-10000");

  assert.equal(result.status, 0, result.stderr);
});

test("the lifecycle allowlist accepts only the exact migration to scoped cleanup rules", () => {
  const accepted = validate(
    plan("phase2-10000", [lifecycleMigrationChange()]),
    "phase2-10000",
  );
  assert.equal(accepted.status, 0, accepted.stderr);

  const mutations = [
    (change) => {
      change.change.after.rule[0].expiration[0].days = 1;
    },
    (change) => {
      change.change.after.rule = [structuredClone(CANONICAL_STAGING_RULE)];
    },
    (change) => {
      change.change.after.rule.find(
        (rule) => rule.id === "staging-canonical-expiration",
      ).filter[0].prefix = "canonical/";
    },
    (change) => {
      change.change.after.rule.find(
        (rule) => rule.id === "staging-canonical-expiration",
      ).expiration[0].days = 30;
    },
    (change) => {
      change.change.after.rule.find(
        (rule) => rule.id === "staging-canonical-expiration",
      ).abort_incomplete_multipart_upload[0].days_after_initiation = 7;
    },
    (change) => {
      change.change.after.rule.push({
        ...structuredClone(CANONICAL_STAGING_RULE),
        id: "unexpected-extra-rule",
      });
    },
    (change) => {
      change.change.after_unknown = { rule: true };
    },
    (change) => {
      change.change.after.rule.find(
        (rule) => rule.id === "staging-abort-multipart",
      ).filter[0].prefix = null;
    },
    (change) => {
      change.change.after.rule.find(
        (rule) => rule.id === "staging-expired-delete-markers",
      ).filter[0].prefix = "";
    },
    (change) => {
      change.change.after.rule.find(
        (rule) => rule.id === "dumps-abort-multipart",
      ).filter[0].prefix = "canonical/archive/";
    },
    (change) => {
      change.change.after.rule.push(structuredClone(LEGACY_GLOBAL_ABORT_RULE));
    },
  ];

  for (const mutate of mutations) {
    const change = lifecycleMigrationChange();
    mutate(change);
    const result = validate(
      plan("phase2-10000", [change]),
      "phase2-10000",
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lifecycle|additive|rule|unknown/i);
  }

  for (const actions of [["create"], ["delete"], ["delete", "create"]]) {
    const change = lifecycleMigrationChange();
    change.change.actions = actions;
    const result = validate(
      plan("phase2-10000", [change]),
      "phase2-10000",
    );
    assert.notEqual(result.status, 0, String(actions));
  }

  const unsafeNoOp = safeLifecycleNoOpChange();
  unsafeNoOp.change.after.rule.find(
    (rule) => rule.id === "athena-results-abort-multipart",
  ).filter[0].prefix = null;
  const unsafeNoOpResult = validate(
    plan("phase1-10000", [unsafeNoOp]),
    "phase1-10000",
  );
  assert.notEqual(unsafeNoOpResult.status, 0);
  assert.match(unsafeNoOpResult.stderr, /bucket-wide|canonical|lifecycle/i);
});

test("the lifecycle gate accepts AWS provider normalization without widening prefixes", () => {
  const change = lifecycleMigrationChange();
  for (const state of [change.change.before, change.change.after]) {
    for (const rule of state.rule) {
      for (const filter of rule.filter) {
        if (filter.prefix === null) filter.prefix = "";
      }
      for (const expiration of rule.expiration) {
        if (expiration.days === null) expiration.days = 0;
        if (expiration.expired_object_delete_marker === null) {
          expiration.expired_object_delete_marker = false;
        }
      }
    }
  }

  const result = validate(plan("phase2-10000", [change]), "phase2-10000");
  assert.equal(result.status, 0, result.stderr);
});

test("no-op managed resources and read-only data sources outside the allowlist remain harmless", () => {
  const dataRead = {
    address: "data.aws_caller_identity.atual",
    mode: "data",
    type: "aws_caller_identity",
    name: "atual",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions: ["read"], before: null, after: {} },
  };
  const result = validate(
    plan("baseline", [resourceChange("aws_s3_bucket.ingestion", ["no-op"]), dataRead]),
    "baseline",
  );

  assert.equal(result.status, 0, result.stderr);
});

test("stateful, identity, network and hosting resources fail closed when changed", () => {
  for (const address of [
    "aws_s3_bucket.ingestion",
    "aws_dynamodb_table.operacional",
    "aws_glue_catalog_database.ingestion",
    "aws_cognito_user_pool.principal",
    "aws_vpc.principal",
    "aws_ecr_repository.ingestion",
    "aws_amplify_app.painel",
    "aws_amplify_branch.principal",
  ]) {
    const result = validate(plan("phase1-5000", [resourceChange(address)]));
    assert.notEqual(result.status, 0, address);
    assert.match(result.stderr, /unexpected address|outside.*allowlist/i, address);
  }
});

test("an isolated delete is always rejected", () => {
  const result = validate(
    plan("phase1-5000", [resourceChange("aws_ecs_task_definition.ingestion_import", ["delete"])]),
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /delete/i);
});

test("replacement is limited to terraform_data and task definitions in either action order", () => {
  for (const actions of [["delete", "create"], ["create", "delete"]]) {
    for (const address of [
      "terraform_data.ingestion_image[0]",
      "aws_ecs_task_definition.ingestion_import",
    ]) {
      const acceptedChange = address.startsWith("aws_ecs_task_definition.")
        ? taskDefinitionChange(address, "phase1-5000", actions)
        : resourceChange(address, actions);
      const accepted = validate(plan("phase1-5000", [acceptedChange]));
      assert.equal(accepted.status, 0, `${address} ${actions}: ${accepted.stderr}`);
    }

    const rejected = validate(
      plan("phase1-5000", [resourceChange("aws_ecs_service.api", actions)]),
    );
    assert.notEqual(rejected.status, 0, String(actions));
    assert.match(rejected.stderr, /replacement/i);
  }
});

test("task definitions fail closed on changed budgets, flags, storage, duplicates, and unknowns", () => {
  const preset = "phase2-5000";
  const taskAddresses = [
    "aws_ecs_task_definition.api",
    "aws_ecs_task_definition.ingestion_backfill",
    "aws_ecs_task_definition.ingestion_import",
    "aws_ecs_task_definition.ingestion_sync",
    "aws_ecs_task_definition.ingestion_incremental_export",
    "aws_ecs_task_definition.ingestion_incremental_ingest",
  ];
  const accepted = validate(
    plan(preset, taskAddresses.map((address) => taskDefinitionChange(address, preset))),
    preset,
  );
  assert.equal(accepted.status, 0, accepted.stderr);

  const mutations = [
    (change) => {
      const containers = JSON.parse(change.change.after.container_definitions);
      containers[0].environment.find(
        (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
      ).value = "1";
      change.change.after.container_definitions = JSON.stringify(containers);
    },
    (change) => {
      change.change.after.ephemeral_storage[0].size_in_gib = 199;
    },
    (change) => {
      delete change.change.after.ephemeral_storage;
    },
    (change) => {
      const containers = JSON.parse(change.change.after.container_definitions);
      containers[0].environment.push({
        name: "INGESTION_DISK_BUDGET_BYTES",
        value: "68719476736",
      });
      change.change.after.container_definitions = JSON.stringify(containers);
    },
    (change) => {
      change.change.after_unknown = { container_definitions: true };
    },
    (change) => {
      change.change.after_unknown = { ephemeral_storage: [{ size_in_gib: true }] };
    },
  ];
  for (const mutate of mutations) {
    const change = taskDefinitionChange(
      "aws_ecs_task_definition.ingestion_import",
      preset,
    );
    mutate(change);
    const result = validate(plan(preset, [change]), preset);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /task|budget|storage|unknown|contract/i);
  }

  for (const [address, environmentName] of [
    ["aws_ecs_task_definition.api", "IMPORT_CANONICAL_FIRST_ENABLED"],
    ["aws_ecs_task_definition.ingestion_backfill", "PAGE_SIZE"],
    ["aws_ecs_task_definition.ingestion_import", "MYSQL_SNAPSHOT_PREPARE_ENABLED"],
    ["aws_ecs_task_definition.ingestion_import", "IMPORT_HOT_MATERIALIZATION_ENABLED"],
  ]) {
    const change = taskDefinitionChange(address, preset);
    const containers = JSON.parse(change.change.after.container_definitions);
    containers[0].environment.find((item) => item.name === environmentName).value = "malicious";
    change.change.after.container_definitions = JSON.stringify(containers);
    const result = validate(plan(preset, [change]), preset);
    assert.notEqual(result.status, 0, `${address}: ${environmentName}`);
  }


  for (const address of [
    "aws_ecs_task_definition.ingestion_backfill",
    "aws_ecs_task_definition.ingestion_import",
    "aws_ecs_task_definition.ingestion_sync",
    "aws_ecs_task_definition.ingestion_incremental_export",
    "aws_ecs_task_definition.ingestion_incremental_ingest",
  ]) {
    const change = taskDefinitionChange(address, preset);
    const containers = JSON.parse(change.change.after.container_definitions);
    containers[0].environment.find(
      (item) => item.name === "INGESTION_DISK_BUDGET_BYTES",
    ).value = "1";
    change.change.after.container_definitions = JSON.stringify(containers);
    const result = validate(plan(preset, [change]), preset);
    assert.notEqual(result.status, 0, address);
  }

  for (const values of [
    { container_definitions: true },
    { ephemeral_storage: [{ size_in_gib: true }] },
  ]) {
    const unknown = plan(preset, [], {});
    unknown.proposed_unknown = {
      root_module: {
        resources: [
          {
            address: "aws_ecs_task_definition.ingestion_import",
            values,
          },
        ],
      },
    };
    const unknownResult = validate(unknown, preset);
    assert.notEqual(unknownResult.status, 0);
    assert.match(unknownResult.stderr, /unknown|container|task/i);
  }

  const noOp = taskDefinitionChange(
    "aws_ecs_task_definition.ingestion_sync",
    preset,
    ["no-op"],
  );
  const containers = JSON.parse(noOp.change.after.container_definitions);
  containers[0].environment[0].value = "1";
  noOp.change.after.container_definitions = JSON.stringify(containers);
  assert.notEqual(validate(plan(preset, [noOp]), preset).status, 0);
});

test("Terraform-native unknown container JSON is rejected before apply", () => {
  const preset = "phase2-10000";
  const cases = [
    {
      address: "aws_ecs_task_definition.api",
      references: [
        "aws_ecs_task_definition.ingestion_import.arn",
        "var.import_canonical_first_enabled",
      ],
    },
    {
      address: "aws_ecs_task_definition.ingestion_import",
      references: [
        "local.ingestion_image_uri",
        "local.ingestion_shared_environment",
        "local.ingestion_import_environment",
      ],
    },
  ];

  for (const { address, references } of cases) {
    const acceptedPlan = configureUnknownTask(
      plan(preset, [unknownTaskDefinitionChange(address)]),
      address,
      references,
    );
    const accepted = validate(acceptedPlan, preset);
    assert.notEqual(accepted.status, 0, address);
    assert.match(accepted.stderr, /unknown|container|task/i, address);

    const missingAnchor = structuredClone(acceptedPlan);
    missingAnchor.configuration.root_module.resources[0].expressions.container_definitions.references =
      references.slice(0, -1);
    assert.notEqual(validate(missingAnchor, preset).status, 0, address);

    const malformedMarker = structuredClone(acceptedPlan);
    malformedMarker.resource_changes[0].change.after_unknown.container_definitions = {
      nested: true,
    };
    assert.notEqual(validate(malformedMarker, preset).status, 0, address);
  }
});

test("provider changes, previous addresses and imports are rejected", () => {
  const providerChanged = validate(
    plan("phase1-5000", [
      resourceChange(
        "aws_ecs_task_definition.ingestion_import",
        ["update"],
        "registry.terraform.io/hashicorp/random",
      ),
    ]),
  );
  assert.notEqual(providerChanged.status, 0);
  assert.match(providerChanged.stderr, /provider/i);

  const moved = resourceChange("aws_ecs_task_definition.ingestion_import");
  moved.previous_address = "aws_ecs_task_definition.old_import";
  const previousAddress = validate(plan("phase1-5000", [moved]));
  assert.notEqual(previousAddress.status, 0);
  assert.match(previousAddress.stderr, /previous_address/i);

  const imported = resourceChange("aws_ecs_task_definition.ingestion_import");
  imported.change.importing = { id: "must-not-be-printed" };
  const importing = validate(plan("phase1-5000", [imported]));
  assert.notEqual(importing.status, 0);
  assert.match(importing.stderr, /importing/i);
  assert.doesNotMatch(importing.stderr, /must-not-be-printed/);
});

test("unknown presets, extra arguments, malformed JSON and incomplete plans fail closed", () => {
  assert.notEqual(validate(plan("baseline"), "custom").status, 0);
  assert.notEqual(validate(plan("baseline"), "baseline", ["extra"]).status, 0);
  assert.notEqual(validate("not json", "baseline").status, 0);
  assert.notEqual(validate({ variables: variablesFor("baseline") }, "baseline").status, 0);
});

test("malformed plan input never echoes its contents", () => {
  const sentinel = "must-not-leak-from-malformed-plan";
  const result = validate(sentinel, "baseline");

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel));
});

test("unsupported format versions and unknown top-level categories fail closed", () => {
  for (const candidate of [
    { ...plan("baseline"), format_version: "1.3" },
    { ...plan("baseline"), format_version: "2.0" },
    { ...plan("baseline"), mystery_changes: [] },
  ]) {
    const result = validate(candidate, "baseline");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /format_version|top-level|category/i);
  }
});

test("resource drift is rejected even when its address would be safe to update", () => {
  for (const address of [
    "aws_s3_bucket.ingestion",
    "aws_ecs_task_definition.ingestion_import",
  ]) {
    const candidate = plan("phase1-5000");
    candidate.resource_drift = [resourceChange(address)];

    const result = validate(candidate);
    assert.notEqual(result.status, 0, address);
    assert.match(result.stderr, /drift/i, address);
  }
});

test("only non-sensitive updates to the three expected operational outputs are accepted", () => {
  const outputChange = (overrides = {}) => ({
    actions: ["update"],
    before: "old",
    after: "new",
    before_sensitive: false,
    after_sensitive: false,
    ...overrides,
  });
  const accepted = plan("phase1-5000");
  accepted.output_changes = {
    imagem_ecr: outputChange(),
    ingestion_runbook: outputChange(),
    comando_ingestion_backfill: outputChange(),
    grafana_senha: outputChange({
      actions: ["no-op"],
      before: "must-not-print",
      after: "must-not-print",
      before_sensitive: true,
      after_sensitive: true,
    }),
  };
  assert.equal(validate(accepted).status, 0);

  const omittedWhenEmpty = plan("phase1-5000");
  delete omittedWhenEmpty.output_changes;
  assert.equal(validate(omittedWhenEmpty).status, 0);

  for (const outputChanges of [
    { grafana_senha: outputChange({ after_sensitive: true, after: "must-not-print" }) },
    { ingestion_runbook: outputChange({ after_sensitive: true, after: "must-not-print" }) },
    { ingestion_runbook: outputChange({ after_sensitive: undefined }) },
    { output_injetado: outputChange({ actions: ["no-op"] }) },
    { ingestion_runbook: outputChange({ actions: ["delete"] }) },
    [],
  ]) {
    const candidate = plan("phase1-5000");
    candidate.output_changes = outputChanges;
    const result = validate(candidate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output/i);
    assert.doesNotMatch(result.stderr, /must-not-print/);
  }
});

test("deferred changes, action invocations and unsafe plan status flags fail closed", () => {
  const cases = [
    { deferred_changes: [{ reason: "provider_config_unknown" }] },
    { deferred_action_invocations: [{ reason: "deferred_prereq" }] },
    { action_invocations: [{ address: "action.example" }] },
    { applyable: false },
    { complete: false },
    { errored: true },
  ];
  for (const overrides of cases) {
    const result = validate({ ...plan("baseline"), ...overrides }, "baseline");
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
  }
});

test("malformed known top-level structures fail closed", () => {
  for (const overrides of [
    { planned_values: [] },
    { prior_state: [] },
    { configuration: [] },
    { relevant_attributes: {} },
    { checks: {} },
    { timestamp: 123 },
  ]) {
    const result = validate({ ...plan("baseline"), ...overrides }, "baseline");
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.match(result.stderr, /plan|structure|timestamp/i);
  }
});
