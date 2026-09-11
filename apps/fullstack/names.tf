locals {
  nome_cluster          = "${var.deployment_namespace}-cluster"
  nome_alb              = "${var.deployment_namespace}-alb"
  nome_servico          = "${var.deployment_namespace}-api-service"
  nome_task_definition  = "${var.deployment_namespace}-api-task"
  nome_container        = "${var.deployment_namespace}-api"
  nome_repositorio_ecr  = "${var.deployment_namespace}-api"
  nome_target_group     = "${var.deployment_namespace}-api-tg"
  nome_security_group   = "${var.deployment_namespace}-api-sg"
  nome_app_amplify      = "${var.deployment_namespace}-painel"
  tabela_operacional    = "${var.deployment_namespace}-operacional"
  tabela_golden_set     = "${var.deployment_namespace}-golden-set"
  nome_observabilidade  = "${var.deployment_namespace}-observabilidade"
  nome_bastion          = "${var.deployment_namespace}-bastion"
  nome_bucket_flow_logs = "${var.deployment_namespace}-${data.aws_caller_identity.atual.account_id}-vpc-flow-logs"

  nome_log_group   = "/ecs/${local.nome_repositorio_ecr}"
  nome_api_gateway = "${local.nome_servico}-tls"
}
