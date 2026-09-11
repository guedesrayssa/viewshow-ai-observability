const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../../../../");
const fullstackPath = path.join(repositoryRoot, "apps/fullstack");

function read(name) {
  return fs.readFileSync(path.join(fullstackPath, name), "utf8");
}

test("dedicated VPC separates public ingress from private compute", () => {
  const vpc = read("vpc.tf");
  const alb = read("alb.tf");
  const ecs = read("ecs.tf");
  const network = read("network.tf");

  assert.match(vpc, /resource "aws_vpc" "principal"/);
  assert.match(vpc, /cidr_block\s*=\s*"10\.0\.0\.0\/16"/);
  assert.match(vpc, /resource "aws_nat_gateway" "principal"/);
  assert.match(vpc, /resource "aws_vpc_endpoint" "dynamodb"/);
  assert.match(vpc, /resource "aws_vpc_endpoint" "s3"/);
  assert.match(alb, /subnets\s*=\s*values\(aws_subnet\.publica\)\[\*\]\.id/);
  assert.match(ecs, /subnets\s*=\s*values\(aws_subnet\.privada\)\[\*\]\.id/);
  assert.match(ecs, /assign_public_ip\s*=\s*false/);
  assert.match(network, /vpc_id\s*=\s*aws_vpc\.principal\.id/);
  assert.doesNotMatch(
    [vpc, alb, ecs, network].join("\n"),
    /data\.aws_vpc\.default|data\.aws_subnets\.default/,
  );
});

test("bastion defaults to SSM and never exposes SSH globally", () => {
  const bastion = read("bastion.tf");
  const variables = read("variables.tf");

  assert.match(bastion, /resource "aws_instance" "bastion"/);
  assert.match(
    bastion,
    /subnet_id\s*=\s*aws_subnet\.publica\["a"\]\.id/,
  );
  assert.match(
    bastion,
    /iam_instance_profile\s*=\s*data\.aws_iam_instance_profile\.lab\.name/,
  );
  assert.match(bastion, /http_tokens\s*=\s*"required"/);
  assert.match(bastion, /encrypted\s*=\s*true/);
  assert.match(bastion, /for_each\s*=\s*var\.bastion_admin_cidr/);
  assert.match(variables, /variable "bastion_admin_cidr"/);
  assert.match(variables, /var\.bastion_admin_cidr\s*!=\s*"0\.0\.0\.0\/0"/);
  assert.doesNotMatch(
    bastion,
    /from_port\s*=\s*22[\s\S]{0,220}cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/,
  );
});

test("network flow logs are private and retained for the video evidence", () => {
  const flow = read("flow-logs.tf");
  const outputs = read("outputs.tf");

  assert.match(flow, /resource "aws_flow_log" "vpc"/);
  assert.match(flow, /log_destination_type\s*=\s*"s3"/);
  assert.match(flow, /traffic_type\s*=\s*"ALL"/);
  assert.match(flow, /max_aggregation_interval\s*=\s*60/);
  assert.match(flow, /resource "terraform_data" "flow_logs_bucket"/);
  assert.match(flow, /scripts\/gerenciar-bucket-flow-logs\.mjs/);
  assert.doesNotMatch(flow, /resource "aws_s3_bucket" "flow_logs"/);
  assert.match(
    flow,
    /resource "aws_s3_bucket_public_access_block" "flow_logs"/,
  );
  assert.match(flow, /block_public_acls\s*=\s*true/);
  assert.match(flow, /block_public_policy\s*=\s*true/);
  assert.match(flow, /expiration[\s\S]*days\s*=\s*30/);
  assert.match(outputs, /bucket\s*=\s*local\.nome_bucket_flow_logs/);
  assert.doesNotMatch(outputs, /aws_s3_bucket\.flow_logs/);
});

test("Cognito domain is globally unique to the active AWS account", () => {
  const cognito = read("cognito.tf");

  assert.match(
    cognito,
    /domain\s*=\s*"\$\{var\.deployment_namespace\}-\$\{data\.aws_caller_identity\.atual\.account_id\}-auth"/,
  );
});

test("Fargate service scales by CPU without Terraform fighting desired count", () => {
  const scaling = read("autoscaling.tf");
  const ecs = read("ecs.tf");

  assert.match(scaling, /resource "aws_appautoscaling_target" "api"/);
  assert.match(scaling, /scalable_dimension\s*=\s*"ecs:service:DesiredCount"/);
  assert.match(
    scaling,
    /predefined_metric_type\s*=\s*"ECSServiceAverageCPUUtilization"/,
  );
  assert.match(scaling, /target_value\s*=\s*var\.ecs_cpu_alvo/);
  assert.match(ecs, /ignore_changes\s*=\s*\[desired_count\]/);
});

test("infrastructure guide documents implemented rubric substitutions", () => {
  const documentation = fs.readFileSync(
    path.join(fullstackPath, "documentation/infraestrutura-integracao.md"),
    "utf8",
  );

  for (const phrase of [
    "ECS Service Auto Scaling",
    "DynamoDB substitui o RDS",
    "um único NAT Gateway",
    "VPC Flow Logs",
    "bastion_admin_cidr",
    "Roteiro do vídeo 1",
  ]) {
    assert.match(documentation, new RegExp(phrase, "i"));
  }
  assert.doesNotMatch(
    documentation,
    /arquitetura-alvo[\s\S]*RDS Multi-AZ/i,
  );
});
