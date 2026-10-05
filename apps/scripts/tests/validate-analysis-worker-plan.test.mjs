import assert from "node:assert/strict";
import test from "node:test";
import { validateAnalysisWorkerPlan } from "../terraform/validate-analysis-worker-plan.mjs";

function transition(before, after, extra = {}) {
  return { resource_changes: [{
    address: "aws_ecs_service.analysis_worker[0]",
    change: { actions: ["update"], before: { desired_count: before, ...extra }, after: { desired_count: after, ...extra }, after_unknown: {} },
  }] };
}

const prepareVariables = {
  deployment_namespace: { value: "view-show" },
  regiao: { value: "us-east-1" },
  analysis_worker_habilitado: { value: true },
  analysis_worker_desired_count: { value: 0 },
  analysis_llm_provider: { value: "ollama" },
  observabilidade_habilitada: { value: true },
  observabilidade_api_exportacao_habilitada: { value: true },
  grafana_cidr_acesso: { value: null },
};

function workerContainer() {
  return {
    name: "analysis-worker",
    image: "111122223333.dkr.ecr.us-east-1.amazonaws.com/view-show-analysis-worker:a1b2c3d4e5f6",
    essential: true,
    stopTimeout: 120,
    environment: [
      { name: "NODE_ENV", value: "production" },
      { name: "AWS_REGION", value: "us-east-1" },
      { name: "OPERATIONAL_TABLE_NAME", value: "view-show-iac-operacional" },
      { name: "ANALYSIS_QUEUE_URL", value: "https://sqs.us-east-1.amazonaws.com/111122223333/view-show-ingestion-analysis" },
      { name: "ANALYSIS_DLQ_URL", value: "https://sqs.us-east-1.amazonaws.com/111122223333/view-show-ingestion-analysis-dlq" },
      { name: "ANALYSIS_MODEL_LOCATION", value: "s3://view-show-ingestion/analysis/models/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json" },
      { name: "ANALYSIS_SCOPE_CATALOG_LOCATION", value: "s3://view-show-ingestion/analysis/catalogs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json" },
      { name: "ANALYSIS_MODEL_SHA256", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { name: "LLM_PROVIDER", value: "ollama" },
      { name: "LLM_MODEL_ID", value: "qwen2.5:7b" },
      { name: "OLLAMA_BASE_URL", value: "http://10.20.30.40:11434" },
      { name: "OTEL_SERVICE_NAME", value: "view-show-agentic" },
      { name: "OTEL_DEPLOYMENT_ENVIRONMENT", value: "aws" },
      { name: "OTEL_SERVICE_VERSION", value: "a1b2c3d4e5f6" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://10.0.20.10:4320" },
    ],
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-group": "/ecs/view-show-analysis-worker",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "worker",
      },
    },
  };
}

function workerPreparePlan() {
  const operation = {
    cluster_name: "view-show-iac-cluster",
    task_definition: null,
    task_family: "view-show-analysis-worker",
    container_name: "analysis-worker",
    subnet_ids: ["subnet-aaa111", "subnet-bbb222"],
    security_group_id: "sg-abc123",
    assign_public_ip: false,
    log_group: "/ecs/view-show-analysis-worker",
    analysis_queue_url: "https://sqs.us-east-1.amazonaws.com/111122223333/view-show-ingestion-analysis",
    operational_table: "view-show-iac-operacional",
    desired_count: 0,
  };
  return {
    variables: structuredClone(prepareVariables),
    configuration: {
      root_module: {
        outputs: {
          analysis_worker_operacao: {
            expression: {
              references: [
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
              ],
            },
          },
        },
        resources: [
          {
            address: "aws_ecs_task_definition.analysis_worker",
            expressions: {
              execution_role_arn: { references: ["data.aws_iam_role.lab.arn"] },
              task_role_arn: { references: ["data.aws_iam_role.lab.arn"] },
            },
          },
          {
            address: "aws_ecs_service.analysis_worker",
            expressions: {
              cluster: { references: ["aws_ecs_cluster.principal.id"] },
              task_definition: { references: ["aws_ecs_task_definition.analysis_worker[0].arn"] },
            },
          },
        ],
      },
    },
    resource_changes: [
      {
        address: "aws_ecs_task_definition.analysis_worker[0]",
        change: {
          actions: ["create"],
          before: null,
          after: {
            family: "view-show-analysis-worker",
            requires_compatibilities: ["FARGATE"],
            network_mode: "awsvpc",
            cpu: "512",
            memory: "1024",
            execution_role_arn: "arn:aws:iam::111122223333:role/LabRole",
            task_role_arn: "arn:aws:iam::111122223333:role/LabRole",
            container_definitions: JSON.stringify([workerContainer()]),
          },
          after_unknown: {},
        },
      },
      {
        address: "aws_ecs_service.analysis_worker[0]",
        change: {
          actions: ["create"],
          before: null,
          after: {
            name: "view-show-analysis-worker",
            cluster: "arn:aws:ecs:us-east-1:111122223333:cluster/view-show-iac-cluster",
            launch_type: "FARGATE",
            desired_count: 0,
            task_definition: null,
            network_configuration: [{
              assign_public_ip: false,
              subnets: ["subnet-aaa111", "subnet-bbb222"],
              security_groups: ["sg-abc123"],
            }],
            load_balancer: [],
          },
          after_unknown: { task_definition: true },
        },
      },
    ],
    planned_values: {
      outputs: {
        analysis_worker_operacao: { sensitive: false, value: structuredClone(operation) },
      },
    },
    output_changes: {
      analysis_worker_operacao: {
        actions: ["create"],
        before: null,
        after: structuredClone(operation),
        after_unknown: { task_definition: true },
      },
    },
  };
}

test("accepts only exact activation and deactivation transitions", () => {
  assert.equal(validateAnalysisWorkerPlan(transition(0, 1, { task_definition: "td" }), "activate"), true);
  assert.equal(validateAnalysisWorkerPlan(transition(1, 0, { task_definition: "td" }), "deactivate"), true);
  assert.throws(() => validateAnalysisWorkerPlan(transition(0, 2), "activate"), /0 -> 1/);
  assert.throws(() => validateAnalysisWorkerPlan(transition(0, 1, { task_definition: "old" }), "deactivate"));
});

test("activation binds the unchanged service to the caller account", () => {
  const prepared = workerPreparePlan();
  const service = structuredClone(prepared.resource_changes[1].change.after);
  service.task_definition = "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-analysis-worker:7";
  service.deployment_circuit_breaker = [{ enable: false, rollback: false }];
  service.iam_role = "/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS";
  const plan = {
    variables: structuredClone(prepareVariables),
    configuration: prepared.configuration,
    resource_changes: [{
      address: "aws_ecs_service.analysis_worker[0]",
      change: {
        actions: ["update"],
        before: { ...structuredClone(service), desired_count: 0 },
        after: { ...structuredClone(service), desired_count: 1 },
        after_unknown: {},
      },
    }],
    planned_values: structuredClone(prepared.planned_values),
  };
  plan.planned_values.outputs.analysis_worker_operacao.value.task_definition = service.task_definition;
  plan.planned_values.outputs.analysis_worker_operacao.value.desired_count = 1;
  assert.equal(validateAnalysisWorkerPlan(plan, "activate", "111122223333"), true);
  assert.throws(() => validateAnalysisWorkerPlan(plan, "activate", "999999999999"), /cluster/);
  plan.resource_changes[0].change.after.iam_role = "Admin";
  assert.throws(() => validateAnalysisWorkerPlan(plan, "activate", "111122223333"), /protected service field|runtime options/);
});

test("prepare resumes when the task already exists and only the service remains", () => {
  const plan = workerPreparePlan();
  const task = plan.resource_changes[0];
  task.change.actions = ["no-op"];
  plan.output_changes = {};
  plan.planned_values.outputs.analysis_worker_operacao.value.task_definition =
    "arn:aws:ecs:us-east-1:111122223333:task-definition/view-show-analysis-worker:4";
  plan.resource_changes[1].change.after.task_definition =
    plan.planned_values.outputs.analysis_worker_operacao.value.task_definition;
  plan.resource_changes[1].change.after_unknown = {};
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare", "111122223333"), true);

});

test("rejects extra resources, deletes and unknown values", () => {
  const extra = transition(0, 1);
  extra.resource_changes.push({ address: "aws_vpc.principal", change: { actions: ["update"], before: {}, after: {} } });
  assert.throws(() => validateAnalysisWorkerPlan(extra, "activate"), /only/);
  const deletion = { variables: prepareVariables, resource_changes: [{ address: "aws_ecs_service.analysis_worker[0]", change: { actions: ["delete"], before: {}, after: null } }] };
  assert.throws(() => validateAnalysisWorkerPlan(deletion, "prepare"), /delete/);
  const unknownPlan = transition(0, 1);
  unknownPlan.resource_changes[0].change.after_unknown = { desired_count: true };
  assert.throws(() => validateAnalysisWorkerPlan(unknownPlan, "activate"), /known/);
});

test("accepts a private zero-replica prepare plan", () => {
  const plan = workerPreparePlan();
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare", "111122223333"), true);
  assert.throws(
    () => validateAnalysisWorkerPlan(workerPreparePlan(), "prepare", "999999999999"),
    /caller account/,
  );
  plan.resource_changes[1].change.after.desired_count = 1;
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /unsafe replicas/);
});

test("prepare rejects protected worker task and service mutations", () => {
  for (const [label, mutate, pattern] of [
    ["image", (plan) => { JSON.parse(plan.resource_changes[0].change.after.container_definitions); const container = workerContainer(); container.image = "nginx:latest"; plan.resource_changes[0].change.after.container_definitions = JSON.stringify([container]); }, /image/],
    ["roles", (plan) => {
      plan.resource_changes[0].change.after.task_role_arn = "arn:aws:iam::111122223333:role/Admin";
      plan.resource_changes[0].change.after.execution_role_arn = "arn:aws:iam::111122223333:role/Admin";
    }, /roles/],
    ["command", (plan) => { const container = workerContainer(); container.command = ["sh"]; plan.resource_changes[0].change.after.container_definitions = JSON.stringify([container]); }, /command/],
    ["logs", (plan) => { const container = workerContainer(); container.logConfiguration.options["awslogs-group"] = "/ecs/other"; plan.resource_changes[0].change.after.container_definitions = JSON.stringify([container]); }, /logging/],
    ["container count", (plan) => { plan.resource_changes[0].change.after.container_definitions = JSON.stringify([workerContainer(), workerContainer()]); }, /exactly one container/],
    ["public network", (plan) => { plan.resource_changes[1].change.after.network_configuration[0].assign_public_ip = true; }, /networking/],
    ["cluster", (plan) => { plan.resource_changes[1].change.after.cluster = "arn:aws:ecs:us-east-1:111122223333:cluster/other"; }, /cluster/],
    ["exec", (plan) => { plan.resource_changes[1].change.after.enable_execute_command = true; }, /runtime options/],
    ["lattice", (plan) => { plan.resource_changes[1].change.after.vpc_lattice_configurations = [{ role_arn: "unsafe" }]; }, /vpc_lattice_configurations/],
    ["output network mismatch", (plan) => { plan.resource_changes[1].change.after.network_configuration[0].subnets[0] = "subnet-ccc333"; }, /operation output/],
    ["cross-account image", (plan) => { const container = workerContainer(); container.image = container.image.replace("111122223333", "999999999999"); plan.resource_changes[0].change.after.container_definitions = JSON.stringify([container]); }, /account/],
    ["task link", (plan) => { plan.configuration.root_module.resources[1].expressions.task_definition.references = ["aws_ecs_task_definition.api.arn"]; }, /task definition/],
    ["task prefix", (plan) => { plan.configuration.root_module.resources[1].expressions.task_definition.references = ["aws_ecs_task_definition.analysis_worker_attacker[0].arn"]; }, /task definition/],
  ]) {
    const plan = workerPreparePlan();
    mutate(plan);
    assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), pattern, label);
  }
});

test("prepare validates ECR immutability, encryption and scanning", () => {
  const plan = workerPreparePlan();
  plan.resource_changes.unshift({
    address: "aws_ecr_repository.analysis_worker[0]",
    change: {
      actions: ["create"],
      before: null,
      after: {
        name: "view-show-analysis-worker",
        registry_id: "111122223333",
        image_tag_mutability: "IMMUTABLE",
        force_delete: true,
        encryption_configuration: [{ encryption_type: "AES256", kms_key: "" }],
        image_scanning_configuration: [{ scan_on_push: true }],
      },
      after_unknown: {},
    },
  });
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare"), true);
  plan.resource_changes[0].change.after.image_tag_mutability = "MUTABLE";
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /ECR/);
});

test("prepare accepts only the provider-computed ECR AES256 KMS key", () => {
  const plan = workerPreparePlan();
  plan.resource_changes.unshift({
    address: "aws_ecr_repository.analysis_worker[0]",
    change: {
      actions: ["create"], before: null,
      after: {
        name: "view-show-analysis-worker", registry_id: null,
        image_tag_mutability: "IMMUTABLE", force_delete: true,
        encryption_configuration: [{ encryption_type: "AES256" }],
        image_scanning_configuration: [{ scan_on_push: true }],
      },
      after_unknown: { encryption_configuration: [{ kms_key: true }] },
    },
  });
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare"), true);
  plan.resource_changes[0].change.after_unknown.encryption_configuration = [{ encryption_type: true }];
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /ECR/);
});

test("prepare accepts computed empty ECS triggers only when not configured", () => {
  const plan = workerPreparePlan();
  const service = plan.resource_changes[1].change;
  service.after.availability_zone_rebalancing = "DISABLED";
  service.after_unknown.triggers = true;
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare"), true);
  plan.configuration.root_module.resources[1].expressions.triggers = { constant_value: { unsafe: "change" } };
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /triggers/);
});

test("prepare accepts a consistently pending ECS task ARN", () => {
  const plan = workerPreparePlan();
  delete plan.output_changes.analysis_worker_operacao.after.task_definition;
  delete plan.planned_values.outputs.analysis_worker_operacao.value.task_definition;
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare"), true);
  plan.resource_changes[1].change.after_unknown.task_definition = false;
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /task definition|operation output|diverges/);
});

test("prepare rejects DNS names for Ollama and accepts only an RFC1918 literal", () => {
  const plan = workerPreparePlan();
  const container = workerContainer();
  container.environment.find((entry) => entry.name === "OLLAMA_BASE_URL").value = "https://ollama.internal.example";
  plan.resource_changes[0].change.after.container_definitions = JSON.stringify([container]);
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /environment/);
});

test("prepare accepts only a private bastion Ollama bridge from the ECS service security group", () => {
  const plan = workerPreparePlan();
  plan.variables.analysis_ollama_base_url = { value: "http://10.0.0.106:11434" };
  plan.variables.analysis_ssh_bridge_habilitado = { value: true };
  plan.planned_values.root_module = { resources: [
    { address: "aws_instance.bastion", values: { private_ip: "10.0.0.106" } },
    { address: "aws_security_group.bastion", values: { id: "sg-bastion123" } },
  ] };
  plan.configuration.root_module.resources.push({
    address: "aws_security_group_rule.ollama_ssh_bridge",
    expressions: {
      security_group_id: { references: ["aws_security_group.bastion.id"] },
      source_security_group_id: { references: ["aws_security_group.servico.id"] },
    },
  });
  plan.resource_changes.push({
    address: "aws_security_group_rule.ollama_ssh_bridge[0]",
    change: {
      actions: ["create"],
      before: null,
      after: {
        type: "ingress", protocol: "tcp", from_port: 11434, to_port: 11434,
        security_group_id: "sg-bastion123", source_security_group_id: "sg-abc123",
        cidr_blocks: [], ipv6_cidr_blocks: [], prefix_list_ids: [], self: false,
      },
      after_unknown: { id: true },
    },
  });
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare", "111122223333"), true);

  const rawBoolean = structuredClone(plan);
  rawBoolean.variables.analysis_ssh_bridge_habilitado.value = "true";
  assert.equal(validateAnalysisWorkerPlan(rawBoolean, "prepare", "111122223333"), true);

  const publicSource = structuredClone(plan);
  publicSource.resource_changes.at(-1).change.after.source_security_group_id = "";
  publicSource.resource_changes.at(-1).change.after.cidr_blocks = ["0.0.0.0/0"];
  assert.throws(() => validateAnalysisWorkerPlan(publicSource, "prepare", "111122223333"), /Ollama SSH bridge/);

  const wrongEndpoint = structuredClone(plan);
  wrongEndpoint.variables.analysis_ollama_base_url.value = "http://10.0.0.107:11434";
  assert.throws(() => validateAnalysisWorkerPlan(wrongEndpoint, "prepare", "111122223333"), /Ollama SSH bridge/);
});

test("prepare validates the operational output values and Terraform references", () => {
  const redirected = workerPreparePlan();
  redirected.output_changes.analysis_worker_operacao.after.cluster_name = "other-cluster";
  assert.throws(() => validateAnalysisWorkerPlan(redirected, "prepare"), /operation output/);

  const wrongReference = workerPreparePlan();
  wrongReference.configuration.root_module.outputs.analysis_worker_operacao.expression.references = [
    "aws_ecs_cluster.attacker.name",
  ];
  assert.throws(() => validateAnalysisWorkerPlan(wrongReference, "prepare"), /output references/);
});

test("prepare requires the exact safe variables and private observability resources", () => {
  const plan = {
    variables: {
      ...structuredClone(prepareVariables),
      analysis_worker_habilitado: { value: false },
      analysis_llm_provider: { value: "none" },
      observabilidade_api_exportacao_habilitada: { value: false },
    },
    planned_values: { root_module: { resources: [
      { address: "aws_security_group.servico", values: { id: "sg-abc123" } },
    ] } },
    configuration: { root_module: { resources: [
      { address: "aws_security_group.observabilidade", expressions: { vpc_id: { references: ["aws_vpc.principal.id"] } } },
      { address: "aws_security_group_rule.otlp_workers", expressions: {
        security_group_id: { references: ["aws_security_group.observabilidade[0].id"] },
        source_security_group_id: { references: ["aws_security_group.servico.id"] },
      } },
    ] } },
    resource_changes: [
      { address: "aws_instance.observabilidade[0]", change: { actions: ["create"], before: null, after: { subnet_id: "subnet-private", associate_public_ip_address: false }, after_unknown: {} } },
      { address: "aws_security_group.observabilidade[0]", change: { actions: ["create"], before: null, after: { ingress: [] }, after_unknown: {} } },
      { address: "aws_security_group_rule.otlp_workers[0]", change: { actions: ["create"], before: null, after: {
        type: "ingress", protocol: "tcp", from_port: 4320, to_port: 4320,
        security_group_id: null, source_security_group_id: "sg-abc123",
        cidr_blocks: null, ipv6_cidr_blocks: null, prefix_list_ids: null, self: false,
      }, after_unknown: { security_group_id: true } } },
    ],
  };
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare-observability"), true);
  const providerComputedIngress = structuredClone(plan);
  delete providerComputedIngress.resource_changes[1].change.after.ingress;
  providerComputedIngress.resource_changes[1].change.after_unknown.ingress = true;
  assert.equal(validateAnalysisWorkerPlan(providerComputedIngress, "prepare-observability"), true);
  providerComputedIngress.resource_changes[2].change.after.cidr_blocks = ["0.0.0.0/0"];
  assert.throws(() => validateAnalysisWorkerPlan(providerComputedIngress, "prepare-observability"), /observability ingress rule/);
  const rawCliValues = structuredClone(plan);
  for (const name of ["analysis_worker_habilitado", "analysis_worker_desired_count", "observabilidade_habilitada", "observabilidade_api_exportacao_habilitada"]) {
    rawCliValues.variables[name].value = String(rawCliValues.variables[name].value);
  }
  assert.equal(validateAnalysisWorkerPlan(rawCliValues, "prepare-observability"), true);
  plan.variables.grafana_cidr_acesso.value = "0.0.0.0/0";
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare-observability"), /grafana_cidr_acesso/);
  plan.variables.grafana_cidr_acesso.value = null;
  plan.resource_changes[1].change.after.ingress = [{ cidr_blocks: ["0.0.0.0/0"] }];
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare-observability"), /public ingress/);
  plan.resource_changes[1].change.after.ingress = [];
  plan.resource_changes.push({
    address: "aws_ecs_task_definition.api",
    change: { actions: ["update"], before: {}, after: {}, after_unknown: {} },
  });
  assert.throws(
    () => validateAnalysisWorkerPlan(plan, "prepare-observability"),
    /unexpected resource aws_ecs_task_definition\.api/,
  );
});

test("observability prepare accepts only the bastion public IP output refresh", () => {
  const base = {
    instancia_id: "i-abc123",
    ip_publico: "3.80.10.20",
    sessao_ssm: "aws ssm start-session --target i-abc123 --region us-east-1",
    ssh: null,
  };
  const plan = {
    variables: {
      ...structuredClone(prepareVariables),
      analysis_worker_habilitado: { value: false },
      analysis_llm_provider: { value: "none" },
      observabilidade_api_exportacao_habilitada: { value: false },
    },
    resource_changes: [],
    planned_values: { root_module: { resources: [
      { address: "aws_instance.bastion", values: { id: "i-abc123", public_ip: "3.80.10.21" } },
    ] } },
    configuration: { root_module: { outputs: {
      bastion_acesso: { expression: { references: ["aws_instance.bastion.id", "aws_instance.bastion.public_ip"] } },
    } } },
    output_changes: { bastion_acesso: {
      actions: ["update"], before: base,
      after: { ...base, ip_publico: "3.80.10.21" },
      after_unknown: {}, after_sensitive: false,
    } },
  };
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare-observability"), true);

  const wrongIp = structuredClone(plan);
  wrongIp.output_changes.bastion_acesso.after.ip_publico = "3.80.10.22";
  assert.throws(() => validateAnalysisWorkerPlan(wrongIp, "prepare-observability"), /bastion public IP/);

  const changedAccess = structuredClone(plan);
  changedAccess.output_changes.bastion_acesso.after.ssh = "ssh ec2-user@example.invalid";
  assert.throws(() => validateAnalysisWorkerPlan(changedAccess, "prepare-observability"), /bastion public IP/);
});

test("prepare rejects an API image change or non-approved API task field", () => {
  const api = (image, cpu = 0) => JSON.stringify([{ name: "api", image, cpu, environment: [
    { name: "NODE_ENV", value: "production" },
    { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: image === "old" ? "" : "http://10.0.1.2:4318" },
  ] }]);
  const plan = {
    variables: prepareVariables,
    resource_changes: [{
      address: "aws_ecs_task_definition.api",
      change: { actions: ["delete", "create"], before: { container_definitions: api("old") }, after: { container_definitions: api("new") }, after_unknown: {} },
    }],
  };
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /API image changed/);
  plan.resource_changes[0].change.after.container_definitions = api("old", 1);
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /outside approved/);
});

test("prepare accepts only provider-normalized API container defaults", () => {
  const plan = workerPreparePlan();
  const before = {
    name: "api", image: "example/api:same", environment: [],
    logConfiguration: { logDriver: "awslogs", options: { "awslogs-stream-prefix": "ecs", "awslogs-group": "/ecs/api" } },
    mountPoints: [], systemControls: [], volumesFrom: [],
    portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
  };
  const after = {
    name: "api", image: "example/api:same", environment: [],
    logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": "/ecs/api", "awslogs-stream-prefix": "ecs" } },
    portMappings: [{ containerPort: 3000, protocol: "tcp" }],
  };
  plan.resource_changes.push({
    address: "aws_ecs_task_definition.api",
    change: { actions: ["delete", "create"], before: { container_definitions: JSON.stringify([before]) },
      after: { container_definitions: JSON.stringify([after]) }, after_unknown: {} },
  });
  assert.equal(validateAnalysisWorkerPlan(plan, "prepare"), true);
  after.portMappings[0].containerPort = 3001;
  plan.resource_changes.at(-1).change.after.container_definitions = JSON.stringify([after]);
  assert.throws(() => validateAnalysisWorkerPlan(plan, "prepare"), /API task/);
});

test("activation output may change only the mirrored desired count", () => {
  const plan = transition(0, 1, { task_definition: "td" });
  plan.output_changes = {
    analysis_worker_operacao: {
      actions: ["update"],
      before: { desired_count: 0, cluster_name: "cluster" },
      after: { desired_count: 1, cluster_name: "cluster" },
      after_unknown: {},
    },
  };
  assert.equal(validateAnalysisWorkerPlan(plan, "activate"), true);
  plan.output_changes.analysis_worker_operacao.after.cluster_name = "other";
  assert.throws(() => validateAnalysisWorkerPlan(plan, "activate"), /protected operation output/);
});
