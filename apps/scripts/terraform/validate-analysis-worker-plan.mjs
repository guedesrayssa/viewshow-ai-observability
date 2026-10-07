import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizePrivateOllamaBaseUrl } from "../ollama-url-policy.mjs";

function fail(message) { throw new Error(message); }
function actions(change) { return change?.change?.actions ?? []; }
function matchesTerraformInput(actual, expected) {
  if (typeof expected === "boolean" || typeof expected === "number") {
    return actual === expected || actual === String(expected);
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function unknown(value) {
  if (value === true) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(unknown);
}

function changedKeys(before = {}, after = {}) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

function containers(raw, label) {
  let value;
  try { value = JSON.parse(raw); } catch { fail(`${label} container definitions are invalid`); }
  if (!Array.isArray(value) || value.length === 0) fail(`${label} has no containers`);
  return value;
}

function environment(container) {
  if (!Array.isArray(container?.environment)) fail("container environment is invalid");
  const entries = container.environment;
  const names = entries.map((entry) => entry?.name);
  if (
    names.some((name) => typeof name !== "string") ||
    new Set(names).size !== names.length ||
    entries.some((entry) => typeof entry?.value !== "string")
  ) fail("container environment must contain unique string bindings");
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function validateTransitionOutputs(plan, mode, expected) {
  const outputs = Object.entries(plan?.output_changes ?? {}).filter(([, change]) => actions({ change }).join(",") !== "no-op");
  if (outputs.length === 0) return;
  if (outputs.length !== 1 || outputs[0][0] !== "analysis_worker_operacao") {
    fail(`${mode} permits only the analysis_worker_operacao output`);
  }
  const change = outputs[0][1];
  if (unknown(change.after_unknown) || change.before?.desired_count !== expected[0] || change.after?.desired_count !== expected[1]) {
    fail(`${mode} output must reflect desired_count ${expected[0]} -> ${expected[1]}`);
  }
  if (changedKeys(change.before, change.after).some((key) => key !== "desired_count")) {
    fail(`${mode} changed a protected operation output`);
  }
}

function validatePrepareVariables(plan, mode) {
  const expected = {
    analysis_worker_habilitado: mode === "prepare",
    analysis_worker_desired_count: 0,
    analysis_llm_provider: mode === "prepare" ? "ollama" : "none",
    observabilidade_habilitada: true,
    observabilidade_api_exportacao_habilitada: mode === "prepare",
    grafana_cidr_acesso: null,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (!matchesTerraformInput(plan?.variables?.[name]?.value, value)) {
      fail(`unsafe prepare variable ${name}`);
    }
  }
}

function validateApiTask(change) {
  const before = containers(change.before?.container_definitions, "API before");
  const after = containers(change.after?.container_definitions, "API after");
  if (before.length !== after.length) fail("API container count changed");
  const allowedEnvironment = new Set(["ANALYSIS_QUEUE_URL", "LOKI_PUSH_URL", "OTEL_EXPORTER_OTLP_ENDPOINT"]);
  for (let index = 0; index < before.length; index += 1) {
    const oldContainer = before[index];
    const newContainer = after[index];
    if (oldContainer.image !== newContainer.image) fail("API image changed");
    const oldEnvironment = environment(oldContainer);
    const newEnvironment = environment(newContainer);
    for (const name of new Set([...Object.keys(oldEnvironment), ...Object.keys(newEnvironment)])) {
      if (oldEnvironment[name] !== newEnvironment[name] && !allowedEnvironment.has(name)) {
        fail(`API protected environment changed: ${name}`);
      }
    }
    const withoutEnvironment = (container) => {
      const { environment: ignored, ...rest } = container;
      for (const key of ["mountPoints", "systemControls", "volumesFrom"]) {
        if (Array.isArray(rest[key]) && rest[key].length === 0) delete rest[key];
      }
      if (Array.isArray(rest.portMappings)) {
        rest.portMappings = rest.portMappings.map((mapping) => {
          const normalized = { ...mapping };
          if (normalized.hostPort === normalized.containerPort) delete normalized.hostPort;
          return normalized;
        });
      }
      return canonical(rest);
    };
    if (JSON.stringify(withoutEnvironment(oldContainer)) !== JSON.stringify(withoutEnvironment(newContainer))) {
      fail("API task changed outside approved environment fields");
    }
  }
}

function validateBastionPublicIpRefresh(plan, change) {
  const expectedKeys = ["instancia_id", "ip_publico", "sessao_ssm", "ssh"];
  const before = change.before;
  const after = change.after;
  const planned = plan?.planned_values?.root_module?.resources?.find(
    (resource) => resource.address === "aws_instance.bastion",
  )?.values;
  const references = plan?.configuration?.root_module?.outputs
    ?.bastion_acesso?.expression?.references;
  if (
    change.actions?.join(",") !== "update" ||
    change.after_sensitive === true ||
    unknown(change.after_unknown) ||
    !before || !after ||
    JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(expectedKeys) ||
    JSON.stringify(Object.keys(after).sort()) !== JSON.stringify(expectedKeys) ||
    changedKeys(before, after).join(",") !== "ip_publico" ||
    typeof after.ip_publico !== "string" ||
    after.instancia_id !== planned?.id ||
    after.ip_publico !== planned?.public_ip ||
    !Array.isArray(references) ||
    !references.includes("aws_instance.bastion.public_ip")
  ) fail("unsafe bastion public IP output refresh");
}

function validatePrepareOutputs(plan, mode, requireOperation = false) {
  const allowed = mode === "prepare"
    ? new Set(["analysis_worker_operacao"])
    : new Set([
        "comando_status_observabilidade",
        "grafana_acesso",
        "grafana_senha",
        "ingestion_runbook",
        "observabilidade_instancia_id",
        "observabilidade_loki_push_url",
        "observabilidade_otlp_workers_endpoint",
        "bastion_acesso",
      ]);
  let operationValidated = false;
  for (const [name, change] of Object.entries(plan?.output_changes ?? {})) {
    if (actions({ change }).join(",") === "no-op") continue;
    if (!allowed.has(name)) fail(`unexpected output ${name}`);
    if (change.after_sensitive === true && name !== "grafana_senha") fail(`unexpected sensitive output ${name}`);
    if (name === "bastion_acesso") validateBastionPublicIpRefresh(plan, change);
    if (name === "analysis_worker_operacao") {
      if (unknown(change.after_unknown?.desired_count) || unknown(change.after_unknown?.assign_public_ip)) {
        fail("analysis_worker_operacao has unknown protected fields");
      }
      if (change.after?.desired_count !== 0 || change.after?.assign_public_ip !== false) {
        fail("analysis_worker_operacao must describe a private zero-replica service");
      }
      validateOperationOutput(plan, change);
      operationValidated = true;
    }
  }
  if (mode === "prepare" && requireOperation) {
    validateOperationOutputReferences(plan);
    if (!operationValidated) {
      const value = plan?.planned_values?.outputs?.analysis_worker_operacao?.value;
      if (value === undefined) fail("analysis worker operation output is unavailable");
      validateOperationOutput(plan, { after: value, after_unknown: {} });
    }
  }
}

const OPERATION_OUTPUT_REFERENCES = [
  "var.analysis_worker_habilitado",
  "aws_ecs_cluster.principal.name",
  "aws_ecs_task_definition.analysis_worker[0].arn",
  "aws_ecs_task_definition.analysis_worker[0].family",
  "aws_subnet.privada",
  "aws_security_group.servico.id",
  "aws_cloudwatch_log_group.analysis_worker[0].name",
  "aws_sqs_queue.analysis.url",
  "aws_dynamodb_table.operacional.name",
  "var.analysis_worker_desired_count",
];

function workerAccount(plan) {
  const task = plan?.resource_changes?.find(
    (item) => item?.address === "aws_ecs_task_definition.analysis_worker[0]",
  );
  const findPlanned = (module) => {
    const resource = module?.resources?.find(
      (item) => item?.address === "aws_ecs_task_definition.analysis_worker[0]",
    );
    if (resource !== undefined) return resource;
    for (const child of module?.child_modules ?? []) {
      const found = findPlanned(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const role = task?.change?.after?.execution_role_arn ??
    findPlanned(plan?.planned_values?.root_module)?.values?.execution_role_arn;
  const match = role?.match(/^arn:aws:iam::(\d{12}):role\//);
  if (match === undefined || match === null) fail("analysis worker account is unavailable");
  return match[1];
}

function validateOperationOutputReferences(plan) {
  const references = plan?.configuration?.root_module?.outputs
    ?.analysis_worker_operacao?.expression?.references;
  if (!Array.isArray(references)) fail("analysis worker operation output references are unavailable");
  if (OPERATION_OUTPUT_REFERENCES.some((reference) => !references.includes(reference))) {
    fail("analysis worker operation output references are unsafe");
  }
  const allowedRoots = [
    "var.analysis_worker_habilitado", "var.analysis_worker_desired_count",
    "aws_ecs_cluster.principal", "aws_ecs_task_definition.analysis_worker",
    "aws_subnet.privada", "aws_security_group.servico",
    "aws_cloudwatch_log_group.analysis_worker", "aws_sqs_queue.analysis",
    "aws_dynamodb_table.operacional",
  ];
  if (references.some((reference) =>
    typeof reference !== "string" || !allowedRoots.some((root) => reference === root || reference.startsWith(`${root}.`) || reference.startsWith(`${root}[`)))) {
    fail("analysis worker operation output references are unsafe");
  }
}

function validateOperationOutput(plan, change) {
  const value = change.after ?? {};
  const namespace = plan?.variables?.deployment_namespace?.value;
  const region = plan?.variables?.regiao?.value;
  const account = workerAccount(plan);
  const keys = [
    "analysis_queue_url", "assign_public_ip", "cluster_name", "container_name",
    "desired_count", "log_group", "operational_table", "security_group_id",
    "subnet_ids", "task_definition", "task_family",
  ];
  const taskDefinitionKnown = typeof value.task_definition === "string" &&
    new RegExp(`^arn:aws:ecs:${region}:${account}:task-definition/${namespace}-analysis-worker:\\d+$`).test(value.task_definition);
  const taskDefinitionPending = value.task_definition == null && change.after_unknown?.task_definition === true;
  const expectedKeys = taskDefinitionPending && !Object.hasOwn(value, "task_definition")
    ? keys.filter((key) => key !== "task_definition")
    : keys;
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
    value.cluster_name !== `${namespace}-iac-cluster` ||
    value.task_family !== `${namespace}-analysis-worker` ||
    (!taskDefinitionKnown && !taskDefinitionPending) || value.container_name !== "analysis-worker" ||
    !Array.isArray(value.subnet_ids) || value.subnet_ids.length !== 2 ||
    new Set(value.subnet_ids).size !== 2 || value.subnet_ids.some((item) => !/^subnet-[a-f0-9]+$/.test(item)) ||
    !/^sg-[a-f0-9]+$/.test(value.security_group_id ?? "") || value.assign_public_ip !== false ||
    value.log_group !== `/ecs/${namespace}-analysis-worker` ||
    !new RegExp(`^https://sqs\\.${region}\\.amazonaws\\.com/${account}/[A-Za-z0-9_-]+-analysis$`).test(value.analysis_queue_url ?? "") ||
    value.operational_table !== `${namespace}-iac-operacional` || value.desired_count !== 0
  ) fail("analysis worker operation output is unsafe");
}

function operationOutputValue(plan) {
  const change = plan?.output_changes?.analysis_worker_operacao;
  if (change !== undefined && actions({ change }).join(",") !== "no-op") return change.after;
  return plan?.planned_values?.outputs?.analysis_worker_operacao?.value;
}

function isPrivateHttpEndpoint(value, port = null) {
  let endpoint;
  try { endpoint = new URL(value); } catch { return false; }
  const host = endpoint.hostname;
  const privateHost = /^10\./.test(host) || /^192\.168\./.test(host) || (() => {
    const match = host.match(/^172\.(\d+)\./);
    return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
  })();
  return (
    ["http:", "https:"].includes(endpoint.protocol) && privateHost &&
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
    endpoint.pathname === "/" && (port === null || endpoint.port === String(port))
  );
}

function isApprovedOllamaEndpoint(value) {
  try {
    normalizePrivateOllamaBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}

function configurationResource(plan, address) {
  return plan?.configuration?.root_module?.resources?.find(
    (resource) => resource?.address === address,
  );
}

function requiresReference(resource, expression, reference) {
  const references = resource?.expressions?.[expression]?.references;
  return Array.isArray(references) && references.includes(reference);
}

function validateWorkerTask(item, plan, account) {
  const change = item.change ?? {};
  if (unknown(change.after_unknown?.container_definitions)) {
    fail("analysis worker container definition is unknown");
  }
  for (const key of [
    "family", "requires_compatibilities", "network_mode", "cpu", "memory",
    "execution_role_arn", "task_role_arn",
  ]) {
    if (unknown(change.after_unknown?.[key])) fail(`analysis worker task field is unknown: ${key}`);
  }
  const after = change.after ?? {};
  const namespace = plan?.variables?.deployment_namespace?.value;
  const region = plan?.variables?.regiao?.value;
  if (namespace !== "view-show" || region !== "us-east-1") fail("analysis worker task profile is unsafe");
  if (
    after.family !== `${namespace}-analysis-worker` ||
    JSON.stringify(after.requires_compatibilities) !== JSON.stringify(["FARGATE"]) ||
    after.network_mode !== "awsvpc" || after.cpu !== "512" || after.memory !== "1024"
  ) fail("analysis worker task runtime is unsafe");
  if (
    typeof after.execution_role_arn !== "string" ||
    after.execution_role_arn !== after.task_role_arn ||
    !new RegExp(`^arn:aws:iam::${account}:role/(?:[A-Za-z0-9_+=,.@/-]*/)?LabRole$`).test(after.execution_role_arn)
  ) fail("analysis worker task roles are unsafe");
  const taskConfiguration = configurationResource(plan, "aws_ecs_task_definition.analysis_worker");
  if (
    !requiresReference(taskConfiguration, "execution_role_arn", "data.aws_iam_role.lab.arn") ||
    !requiresReference(taskConfiguration, "task_role_arn", "data.aws_iam_role.lab.arn")
  ) fail("analysis worker task roles must reference the Learner Lab role");

  const taskContainers = containers(after.container_definitions, "analysis worker");
  if (taskContainers.length !== 1) fail("analysis worker must have exactly one container");
  const container = taskContainers[0];
  const expectedContainerKeys = ["environment", "essential", "image", "logConfiguration", "name", "stopTimeout"];
  if (JSON.stringify(Object.keys(container).sort()) !== JSON.stringify(expectedContainerKeys)) {
    if (Object.hasOwn(container, "command") || Object.hasOwn(container, "entryPoint")) {
      fail("analysis worker command is not approved");
    }
    fail("analysis worker container has unapproved fields");
  }
  if (container.name !== "analysis-worker" || container.essential !== true || container.stopTimeout !== 120) {
    fail("analysis worker container lifecycle is unsafe");
  }
  const imagePattern = new RegExp(
    `^${account}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/${namespace}-analysis-worker:[a-f0-9]{12}$`,
  );
  if (!imagePattern.test(container.image ?? "")) fail("analysis worker image account or immutable build tag is unsafe");
  if (Object.hasOwn(container, "secrets") && (container.secrets?.length ?? 0) !== 0) {
    fail("analysis worker container secrets are not approved");
  }

  const values = environment(container);
  const expectedNames = [
    "ANALYSIS_DLQ_URL", "ANALYSIS_MODEL_LOCATION", "ANALYSIS_MODEL_SHA256",
    "ANALYSIS_QUEUE_URL", "ANALYSIS_SCOPE_CATALOG_LOCATION", "AWS_REGION",
    "LLM_MODEL_ID", "LLM_PROVIDER", "NODE_ENV", "OLLAMA_BASE_URL",
    "OPERATIONAL_TABLE_NAME", "OTEL_DEPLOYMENT_ENVIRONMENT",
    "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME", "OTEL_SERVICE_VERSION",
  ];
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expectedNames)) {
    fail("analysis worker environment contract changed");
  }
  if (
    values.NODE_ENV !== "production" || values.AWS_REGION !== region ||
    values.LLM_PROVIDER !== "ollama" || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(values.LLM_MODEL_ID) ||
    values.OTEL_SERVICE_NAME !== "view-show-agentic" ||
    values.OTEL_DEPLOYMENT_ENVIRONMENT !== "aws" ||
    !/^[a-f0-9]{12}$/.test(values.OTEL_SERVICE_VERSION) ||
    !isApprovedOllamaEndpoint(values.OLLAMA_BASE_URL) ||
    !isPrivateHttpEndpoint(values.OTEL_EXPORTER_OTLP_ENDPOINT, 4320) ||
    values.OPERATIONAL_TABLE_NAME !== `${namespace}-iac-operacional` ||
    !new RegExp(`^https://sqs\\.${region}\\.amazonaws\\.com/${account}/[A-Za-z0-9_-]+-analysis$`).test(values.ANALYSIS_QUEUE_URL) ||
    !new RegExp(`^https://sqs\\.${region}\\.amazonaws\\.com/${account}/[A-Za-z0-9_-]+-analysis-dlq$`).test(values.ANALYSIS_DLQ_URL) ||
    !/^s3:\/\/[a-z0-9.-]+\/analysis\/models\/[a-f0-9]{64}\.json$/.test(values.ANALYSIS_MODEL_LOCATION) ||
    !/^s3:\/\/[a-z0-9.-]+\/analysis\/catalogs\/[a-f0-9]{64}\.json$/.test(values.ANALYSIS_SCOPE_CATALOG_LOCATION) ||
    !/^[a-f0-9]{64}$/.test(values.ANALYSIS_MODEL_SHA256)
  ) fail("analysis worker environment is unsafe");
  const logging = container.logConfiguration;
  if (
    logging?.logDriver !== "awslogs" ||
    JSON.stringify(logging.options) !== JSON.stringify({
      "awslogs-group": `/ecs/${namespace}-analysis-worker`,
      "awslogs-region": region,
      "awslogs-stream-prefix": "worker",
    })
  ) fail("analysis worker logging is unsafe");
}

function validateWorkerService(item, plan, account, desiredCount = 0) {
  const change = item.change ?? {};
  const configuration = configurationResource(plan, "aws_ecs_service.analysis_worker");
  for (const key of [
    "alarms", "availability_zone_rebalancing", "cluster", "deployment_circuit_breaker",
    "desired_count", "force_delete", "launch_type", "load_balancer", "name",
    "network_configuration", "timeouts", "vpc_lattice_configuration",
    "vpc_lattice_configurations",
  ]) {
    if (unknown(change.after_unknown?.[key])) fail(`prepared worker service field is unknown: ${key}`);
  }
  const after = change.after ?? {};
  if (unknown(change.after_unknown?.triggers) && !(
    actions(item).join(",") === "create" &&
    change.after_unknown.triggers === true &&
    after.triggers === undefined &&
    configuration !== undefined &&
    !Object.hasOwn(configuration.expressions ?? {}, "triggers")
  )) fail("prepared worker service field is unknown: triggers");
  const namespace = plan?.variables?.deployment_namespace?.value;
  const network = after.network_configuration?.[0];
  if (after.cluster !== `arn:aws:ecs:us-east-1:${account}:cluster/${namespace}-iac-cluster`) {
    fail("analysis worker service cluster is unsafe");
  }
  if (
    after.name !== `${namespace}-analysis-worker` || after.launch_type !== "FARGATE" ||
    after.desired_count !== desiredCount || after.network_configuration?.length !== 1 ||
    network?.assign_public_ip !== false || network?.subnets?.length !== 2 ||
    network?.subnets?.some((value) => typeof value !== "string" || value.length === 0) ||
    network?.security_groups?.length !== 1 || typeof network.security_groups[0] !== "string" ||
    (after.load_balancer?.length ?? 0) !== 0
  ) fail("analysis worker service has unsafe replicas or networking");
  for (const [key, allowed] of [
    ["capacity_provider_strategy", [undefined, null, []]],
    ["ordered_placement_strategy", [undefined, null, []]],
    ["placement_constraints", [undefined, null, []]],
    ["service_connect_configuration", [undefined, null, []]],
    ["service_registries", [undefined, null, []]],
    ["volume_configuration", [undefined, null, []]],
    ["alarms", [undefined, null, []]],
    ["deployment_circuit_breaker", [undefined, null, [], [{ enable: false, rollback: false }]]],
    ["vpc_lattice_configuration", [undefined, null, []]],
    ["vpc_lattice_configurations", [undefined, null, []]],
    ["timeouts", [undefined, null, {}]],
    ["triggers", [undefined, null, {}]],
  ]) {
    if (!allowed.some((value) => JSON.stringify(after[key]) === JSON.stringify(value))) {
      fail(`analysis worker service field is not approved: ${key}`);
    }
  }
  if (
    ![undefined, null, false].includes(after.enable_execute_command) ||
    ![undefined, null, false].includes(after.enable_ecs_managed_tags) ||
    ![undefined, null, false].includes(after.force_new_deployment) ||
    ![undefined, null, false].includes(after.wait_for_steady_state) ||
    ![undefined, null, false].includes(after.force_delete) ||
    ![undefined, null, "ENABLED", "DISABLED"].includes(after.availability_zone_rebalancing) ||
    ![undefined, null, 0].includes(after.health_check_grace_period_seconds) ||
    ![undefined, null, 200].includes(after.deployment_maximum_percent) ||
    ![undefined, null, 100].includes(after.deployment_minimum_healthy_percent) ||
    ![undefined, null, "REPLICA"].includes(after.scheduling_strategy) ||
    ![undefined, null, "LATEST"].includes(after.platform_version) ||
    ![undefined, null, "NONE"].includes(after.propagate_tags) ||
    ![undefined, null, "", "/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"].includes(after.iam_role) ||
    (after.deployment_controller !== undefined && after.deployment_controller !== null &&
      JSON.stringify(after.deployment_controller) !== JSON.stringify([]) &&
      JSON.stringify(after.deployment_controller) !== JSON.stringify([{ type: "ECS" }]))
  ) fail("analysis worker service runtime options are unsafe");
  if (!requiresReference(configuration, "cluster", "aws_ecs_cluster.principal.id")) {
    fail("analysis worker service must reference the expected cluster");
  }
  const references = configuration?.expressions?.task_definition?.references;
  const expectedTaskReference = "aws_ecs_task_definition.analysis_worker[0].arn";
  const allowedTaskReferences = new Set([
    expectedTaskReference,
    "aws_ecs_task_definition.analysis_worker[0]",
    "aws_ecs_task_definition.analysis_worker",
  ]);
  if (
    !Array.isArray(references) ||
    references.filter((value) => value === expectedTaskReference).length !== 1 ||
    references.some((value) => !allowedTaskReferences.has(value))
  ) {
    fail("analysis worker service must reference its task definition");
  }
  const operation = operationOutputValue(plan);
  const sameSubnets = Array.isArray(operation?.subnet_ids) &&
    JSON.stringify([...operation.subnet_ids].sort()) === JSON.stringify([...network.subnets].sort());
  const sameTask = (after.task_definition == null && operation?.task_definition == null &&
    change.after_unknown?.task_definition === true &&
    plan?.output_changes?.analysis_worker_operacao?.after_unknown?.task_definition === true) ||
    (typeof after.task_definition === "string" && after.task_definition === operation?.task_definition);
  if (
    operation?.cluster_name !== `${namespace}-iac-cluster` ||
    operation?.desired_count !== desiredCount || !sameTask || !sameSubnets ||
    operation?.security_group_id !== network.security_groups[0]
  ) fail("analysis worker service diverges from the operation output");
}

function validateWorkerRepository(item, plan, account) {
  const change = item.change ?? {};
  for (const key of [
    "name", "image_tag_mutability", "force_delete",
    "image_scanning_configuration",
  ]) {
    if (unknown(change.after_unknown?.[key])) fail(`analysis worker ECR field is unknown: ${key}`);
  }
  const after = change.after ?? {};
  const namespace = plan?.variables?.deployment_namespace?.value;
  const encryption = after.encryption_configuration?.[0];
  const unknownEncryption = change.after_unknown?.encryption_configuration;
  const computedAesKey = Array.isArray(unknownEncryption) && unknownEncryption.length === 1 &&
    JSON.stringify(unknownEncryption[0]) === '{"kms_key":true}' &&
    encryption?.encryption_type === "AES256";
  if (unknown(unknownEncryption) && !computedAesKey) {
    fail("analysis worker ECR field is unknown: encryption_configuration");
  }
  const scanning = after.image_scanning_configuration?.[0];
  if (
    after.name !== `${namespace}-analysis-worker` ||
    ![undefined, null, account].includes(after.registry_id) ||
    after.image_tag_mutability !== "IMMUTABLE" || after.force_delete !== true ||
    after.encryption_configuration?.length !== 1 || encryption?.encryption_type !== "AES256" ||
    ![undefined, null, ""].includes(encryption?.kms_key) ||
    after.image_scanning_configuration?.length !== 1 || scanning?.scan_on_push !== true
  ) fail("analysis worker ECR security contract is unsafe");
}

function validateOllamaSshBridge(item, plan) {
  const resources = plan?.planned_values?.root_module?.resources ?? [];
  const bastionIp = resources.find((resource) => resource.address === "aws_instance.bastion")?.values?.private_ip;
  const bastionGroup = resources.find((resource) => resource.address === "aws_security_group.bastion")?.values?.id;
  const workerGroup = operationOutputValue(plan)?.security_group_id;
  const after = item.change?.after ?? {};
  const configuration = configurationResource(plan, "aws_security_group_rule.ollama_ssh_bridge");
  const protectedFields = [
    "type", "protocol", "from_port", "to_port", "security_group_id",
    "source_security_group_id", "cidr_blocks", "ipv6_cidr_blocks",
    "prefix_list_ids", "self",
  ];
  if (
    !matchesTerraformInput(plan?.variables?.analysis_ssh_bridge_habilitado?.value, true) ||
    actions(item).join(",") !== "create" ||
    protectedFields.some((field) => unknown(item.change?.after_unknown?.[field])) ||
    !/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(bastionIp ?? "") ||
    !/^sg-[a-zA-Z0-9]+$/.test(bastionGroup ?? "") ||
    plan?.variables?.analysis_ollama_base_url?.value !== `http://${bastionIp}:11434` ||
    after.type !== "ingress" || after.protocol !== "tcp" ||
    after.from_port !== 11434 || after.to_port !== 11434 ||
    after.security_group_id !== bastionGroup ||
    after.source_security_group_id !== workerGroup ||
    ["cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids"].some((field) =>
      (after[field] ?? []).length !== 0) ||
    after.self !== false ||
    !requiresReference(configuration, "security_group_id", "aws_security_group.bastion.id") ||
    !requiresReference(configuration, "source_security_group_id", "aws_security_group.servico.id")
  ) fail("Ollama SSH bridge must expose only port 11434 from the ECS service group to the private bastion");
}

function validateObservabilityIngressRule(item, plan) {
  const name = item.address.match(/^aws_security_group_rule\.(otlp_api|loki_api|otlp_workers|ssh_bastion_observabilidade)\[0\]$/)?.[1];
  const expectedPort = { otlp_api: 4318, loki_api: 3100, otlp_workers: 4320, ssh_bastion_observabilidade: 22 }[name];
  const sourceAddress = name === "ssh_bastion_observabilidade" ? "aws_security_group.bastion" : "aws_security_group.servico";
  const sourceId = plan?.planned_values?.root_module?.resources?.find((resource) => resource.address === sourceAddress)?.values?.id;
  const targetId = plan?.planned_values?.root_module?.resources?.find((resource) => resource.address === "aws_security_group.observabilidade[0]")?.values?.id;
  const after = item.change?.after ?? {};
  const afterUnknown = item.change?.after_unknown ?? {};
  const configuration = configurationResource(plan, `aws_security_group_rule.${name}`);
  const protectedFields = ["type", "protocol", "from_port", "to_port", "source_security_group_id", "cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids", "self"];
  if (
    actions(item).join(",") !== "create" ||
    protectedFields.some((field) => unknown(afterUnknown[field])) ||
    !/^sg-[a-f0-9]+$/.test(sourceId ?? "") ||
    after.type !== "ingress" || after.protocol !== "tcp" ||
    after.from_port !== expectedPort || after.to_port !== expectedPort ||
    after.source_security_group_id !== sourceId || after.self !== false ||
    ["cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids"].some((field) => (after[field] ?? []).length !== 0) ||
    !((after.security_group_id == null && afterUnknown.security_group_id === true) ||
      (after.security_group_id === targetId && /^sg-[a-f0-9]+$/.test(targetId ?? ""))) ||
    !requiresReference(configuration, "security_group_id", "aws_security_group.observabilidade[0].id") ||
    !requiresReference(configuration, "source_security_group_id", `${sourceAddress}.id`)
  ) fail(`unsafe observability ingress rule ${name}`);
}

export function validateAnalysisWorkerPlan(plan, mode, expectedCallerAccount = null) {
  if (!["prepare-observability", "prepare", "activate", "deactivate"].includes(mode)) fail("invalid mode");
  const changes = (plan?.resource_changes ?? []).filter((item) =>
    actions(item).join(",") !== "no-op"
  );
  if (!["prepare", "prepare-observability"].includes(mode)) {
    if (changes.length !== 1 || changes[0]?.address !== "aws_ecs_service.analysis_worker[0]") {
      fail(`${mode} permits only the analysis worker service`);
    }
    const change = changes[0].change;
    if (actions(changes[0]).join(",") !== "update" || unknown(change.after_unknown)) {
      fail(`${mode} requires one fully known update`);
    }
    const expected = mode === "activate" ? [0, 1] : [1, 0];
    if (change.before?.desired_count !== expected[0] || change.after?.desired_count !== expected[1]) {
      fail(`${mode} requires desired_count ${expected[0]} -> ${expected[1]}`);
    }
    for (const key of new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])) {
      if (key !== "desired_count" && JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key])) {
        fail(`${mode} changed protected service field ${key}`);
      }
    }
    if (expectedCallerAccount !== null) {
      validateWorkerService(changes[0], plan, expectedCallerAccount, expected[1]);
      const taskDefinitionPattern = new RegExp(
        `^arn:aws:ecs:us-east-1:${expectedCallerAccount}:task-definition/view-show-analysis-worker:\\d+$`,
      );
      if (!taskDefinitionPattern.test(change.after?.task_definition ?? "")) {
        fail(`${mode} task definition does not match the caller account`);
      }
    }
    validateTransitionOutputs(plan, mode, expected);
    return true;
  }

  validatePrepareVariables(plan, mode);
  for (const item of changes) {
    const action = actions(item);
    if (action.includes("delete") && !action.includes("create")) fail(`delete is forbidden: ${item.address}`);
  }
  const hasWorkerChange = changes.some((item) => [
    "aws_ecr_repository.analysis_worker[0]",
    "terraform_data.analysis_worker_image[0]",
    "aws_s3_object.analysis_model[0]",
    "aws_s3_object.analysis_catalog[0]",
    "aws_cloudwatch_log_group.analysis_worker[0]",
    "aws_ecs_task_definition.analysis_worker[0]",
    "aws_ecs_service.analysis_worker[0]",
  ].includes(item?.address));
  const account = mode === "prepare" && hasWorkerChange ? workerAccount(plan) : null;
  if (account !== null && expectedCallerAccount !== null && account !== expectedCallerAccount) {
    fail("analysis worker resources do not match the caller account");
  }

  const workerAllowed = [
    /^aws_ecr_repository\.analysis_worker\[0\]$/,
    /^terraform_data\.analysis_worker_image\[0\]$/,
    /^aws_s3_object\.analysis_(model|catalog)\[0\]$/,
    /^aws_cloudwatch_log_group\.analysis_worker\[0\]$/,
    /^aws_ecs_task_definition\.analysis_worker\[0\]$/,
    /^aws_ecs_service\.analysis_worker\[0\]$/,
    /^aws_security_group_rule\.ollama_ssh_bridge\[0\]$/,
  ];
  const observabilityAllowed = [
    /^aws_(instance|security_group)\.observabilidade\[0\]$/,
    /^aws_security_group_rule\.(otlp_api|loki_api|otlp_workers|ssh_bastion_observabilidade)\[0\]$/,
    /^random_password\.grafana\[0\]$/,
  ];
  const allowed = mode === "prepare"
    ? [...workerAllowed, /^aws_ecs_task_definition\.api$/, /^aws_ecs_service\.api$/]
    : observabilityAllowed;
  for (const item of changes) {
    if (!allowed.some((pattern) => pattern.test(item.address ?? ""))) fail(`unexpected resource ${item.address}`);
    const action = actions(item);
    if (action.includes("delete") && !action.includes("create")) fail(`delete is forbidden: ${item.address}`);
    if (item.address === "aws_ecs_service.analysis_worker[0]") {
      validateWorkerService(item, plan, account);
    }
    if (item.address === "aws_ecr_repository.analysis_worker[0]") {
      validateWorkerRepository(item, plan, account);
    }
    if (item.address === "aws_security_group_rule.ollama_ssh_bridge[0]") {
      validateOllamaSshBridge(item, plan);
    }
    if (/^aws_security_group_rule\.(otlp_api|loki_api|otlp_workers|ssh_bastion_observabilidade)\[0\]$/.test(item.address ?? "")) {
      validateObservabilityIngressRule(item, plan);
    }
    if (item.address === "aws_instance.observabilidade[0]") {
      const after = item.change?.after;
      if (unknown(item.change?.after_unknown?.associate_public_ip_address) || unknown(item.change?.after_unknown?.subnet_id)) {
        fail("observability instance has unknown protected networking");
      }
      if (after?.associate_public_ip_address !== false || typeof after?.subnet_id !== "string") {
        fail("observability instance must stay private");
      }
    }
    if (item.address === "aws_security_group.observabilidade[0]") {
      if (unknown(item.change?.after_unknown?.ingress)) {
        const configuration = configurationResource(plan, "aws_security_group.observabilidade");
        if (
          actions(item).join(",") !== "create" ||
          item.change?.after?.ingress !== undefined ||
          configuration === undefined ||
          Object.hasOwn(configuration.expressions ?? {}, "ingress")
        ) fail("Grafana ingress is unknown");
      }
      if ((item.change?.after?.ingress ?? []).length !== 0) fail("Grafana must not have public ingress");
    }
    if (item.address === "aws_ecs_task_definition.analysis_worker[0]") {
      validateWorkerTask(item, plan, account);
    }
    if (item.address === "aws_ecs_task_definition.api") {
      if (unknown(item.change?.after_unknown?.container_definitions)) fail("API container definition is unknown");
      validateApiTask(item.change);
    }
    if (item.address === "aws_ecs_service.api") {
      const changed = changedKeys(item.change?.before, item.change?.after);
      if (changed.some((key) => key !== "task_definition")) fail("API service changed outside task definition");
    }
  }
  if (mode === "prepare" && matchesTerraformInput(plan?.variables?.analysis_ssh_bridge_habilitado?.value, true)) {
    const address = "aws_security_group_rule.ollama_ssh_bridge[0]";
    const planned = plan?.planned_values?.root_module?.resources ?? [];
    if (!changes.some((item) => item.address === address) && !planned.some((item) => item.address === address)) {
      fail("Ollama SSH bridge is enabled but its security group rule is absent");
    }
  }
  validatePrepareOutputs(plan, mode, account !== null);
  return true;
}

// `file://${argv[1]}` never matches on Windows (`file:///C:/...`), which skipped the gate and exited 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[process.argv.indexOf("--mode") + 1];
    const expectedCallerAccount = process.env.VIEW_SHOW_EXPECTED_AWS_ACCOUNT;
    if (!/^\d{12}$/.test(expectedCallerAccount ?? "")) {
      fail("VIEW_SHOW_EXPECTED_AWS_ACCOUNT is required");
    }
    const plan = JSON.parse(readFileSync(0, "utf8"));
    validateAnalysisWorkerPlan(plan, mode, expectedCallerAccount);
    process.stdout.write(`analysis worker ${mode} plan accepted\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
