locals {
  # A tentativa parcial ja registrou VPC/Amplify/API Gateway. O runtime novo
  # usa nomes proprios para nao colidir com o deployment manual em producao.
  namespace_runtime_iac = "${var.deployment_namespace}-iac"
  nome_cluster          = "${local.namespace_runtime_iac}-cluster"
  nome_alb              = "${local.namespace_runtime_iac}-alb"
  nome_servico          = "${local.namespace_runtime_iac}-api-service"
  nome_task_definition  = "${local.namespace_runtime_iac}-api-task"
  nome_container        = "${local.namespace_runtime_iac}-api"
  nome_repositorio_ecr  = "${local.namespace_runtime_iac}-api"
  nome_target_group     = "${local.namespace_runtime_iac}-api-tg"
  nome_security_group   = "${var.deployment_namespace}-api-sg"
  nome_app_amplify      = "${var.deployment_namespace}-painel"
  tabela_operacional    = "${local.namespace_runtime_iac}-operacional"
  tabela_golden_set     = "${local.namespace_runtime_iac}-golden-set"
  nome_observabilidade  = "${var.deployment_namespace}-observabilidade"
  nome_bastion          = "${var.deployment_namespace}-bastion"
  nome_bucket_flow_logs = "${var.deployment_namespace}-${data.aws_caller_identity.atual.account_id}-vpc-flow-logs"

  nome_log_group   = "/ecs/${local.nome_repositorio_ecr}"
  nome_api_gateway = "${var.deployment_namespace}-api-service-tls"
}
