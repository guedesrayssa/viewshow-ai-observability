resource "aws_sqs_queue" "analise_dlq" {
  name                      = "${var.deployment_namespace}-analysis-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "analise" {
  name                       = "${var.deployment_namespace}-analysis"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.analise_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_log_group" "analysis_worker" {
  count             = var.analysis_worker_habilitado ? 1 : 0
  name              = "/ecs/${var.deployment_namespace}-analysis-worker"
  retention_in_days = var.retencao_logs_dias
}

resource "aws_ecs_task_definition" "analysis_worker" {
  count                    = var.analysis_worker_habilitado ? 1 : 0
  family                   = "${var.deployment_namespace}-analysis-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = data.aws_iam_role.lab.arn
  task_role_arn            = data.aws_iam_role.lab.arn
  container_definitions = jsonencode([{ name = "analysis-worker", image = var.analysis_worker_image_uri, essential = true,
    environment = [
      { name = "NODE_ENV", value = "production" }, { name = "AWS_REGION", value = var.regiao },
      { name = "OPERATIONAL_TABLE_NAME", value = aws_dynamodb_table.operacional.name },
      { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analise.url }, { name = "ANALYSIS_DLQ_URL", value = aws_sqs_queue.analise_dlq.url },
      { name = "ANALYSIS_MODEL_LOCATION", value = var.analysis_model_location }, { name = "ANALYSIS_SCOPE_CATALOG_LOCATION", value = var.analysis_scope_catalog_location },
      { name = "ANALYSIS_MODEL_SHA256", value = var.analysis_model_sha256 },
      { name = "LLM_PROVIDER", value = var.analysis_llm_provider }, { name = "LLM_MODEL_ID", value = var.analysis_llm_model_id },
      { name = "OLLAMA_BASE_URL", value = var.analysis_ollama_base_url }
    ],
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.analysis_worker[0].name, "awslogs-region" = var.regiao, "awslogs-stream-prefix" = "worker" } }
  }])
}

resource "aws_ecs_service" "analysis_worker" {
  count           = var.analysis_worker_habilitado ? 1 : 0
  name            = "${var.deployment_namespace}-analysis-worker"
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.analysis_worker[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = values(aws_subnet.privada)[*].id
    security_groups  = [aws_security_group.servico.id]
    assign_public_ip = false
  }
}
