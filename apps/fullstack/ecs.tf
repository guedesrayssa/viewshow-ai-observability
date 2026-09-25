resource "aws_ecs_cluster" "principal" {
  name = local.nome_cluster

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Projeto = "view-show"
  }
}

resource "aws_ecs_cluster_capacity_providers" "principal" {
  cluster_name       = aws_ecs_cluster.principal.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

// O grupo é declarado aqui para manter a retenção sob controle; sem isso, o
// padrão "nunca expira" acumularia custo silencioso no orçamento do laboratório.
resource "aws_cloudwatch_log_group" "api" {
  name              = local.nome_log_group
  retention_in_days = var.retencao_logs_dias

  tags = {
    Projeto = "view-show"
  }
}

// Segredos independentes para assinar sessões e cursores opacos. A API exige
// ambos no startup; valores gerados pelo Terraform não passam pelo git.
resource "random_password" "auth_cookie_secret" {
  length  = 64
  special = false
}

resource "random_password" "cursor_secret" {
  length  = 64
  special = false
}

resource "aws_ecs_task_definition" "api" {
  family                   = local.nome_task_definition
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu_task
  memory                   = var.memoria_task

  // O Learner Lab usa a única role permitida. Produção fornece uma task role
  // explícita sobre a qual este módulo instala as policies de importação e
  // controle live do ARGUS.
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = local.api_task_role_arn

  depends_on = [
    aws_iam_role_policy.api_argus_live_sync,
    aws_iam_role_policy.api_import,
  ]

  container_definitions = jsonencode([
    {
      name      = local.nome_container
      image     = local.uri_imagem
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "AWS_REGION", value = var.regiao },
        { name = "OPERATIONAL_TABLE_NAME", value = aws_dynamodb_table.operacional.name },
        { name = "INGESTION_SCHEDULER_GROUP_NAME", value = aws_scheduler_schedule_group.ingestion.name },
        { name = "INGESTION_SCHEDULER_NAME", value = aws_scheduler_schedule.ingestion_sync.name },
        { name = "GOLDEN_SET_TABLE_NAME", value = aws_dynamodb_table.golden_set.name },
        { name = "BEDROCK_ENABLED", value = tostring(var.bedrock_habilitado) },
        { name = "BEDROCK_MODEL_ID", value = "anthropic.claude-3-haiku-20240307-v1:0" },
        { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },
        { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },
        { name = "RATE_LIMIT_PER_MINUTE", value = tostring(var.rate_limit_por_minuto) },
        { name = "IMPORT_BUCKET", value = local.ingestion_bucket_name },
        { name = "IMPORT_EXPECTED_BUCKET_OWNER", value = data.aws_caller_identity.atual.account_id },
        { name = "IMPORT_CURSOR_SECRET", value = random_password.cursor_secret.result },
        { name = "IMPORT_INGESTION_CLUSTER_ARN", value = aws_ecs_cluster.principal.arn },
        { name = "IMPORT_INGESTION_TASK_DEFINITION_ARN", value = local.ingestion_import_family_arn },
        { name = "IMPORT_INGESTION_SUBNET_IDS", value = join(",", local.ingestion_subnet_ids) },
        { name = "IMPORT_INGESTION_SECURITY_GROUP_ID", value = aws_security_group.ingestion.id },
        { name = "IMPORT_INGESTION_CONTAINER_NAME", value = "ingestion" },
        { name = "IMPORT_CANONICAL_FIRST_ENABLED", value = tostring(var.import_canonical_first_enabled) },

        // Cognito: a task autentica POST /auth/login contra este User Pool pelo
        // fluxo USER_PASSWORD_AUTH. O client é confidencial, então o secret vai
        // junto. Mesmo tratamento em texto plano dos dois segredos acima: nascem
        // no Terraform, entram só na task e nunca passam pelo git.
        { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.principal.id },
        { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.backend.id },
        { name = "COGNITO_CLIENT_SECRET", value = aws_cognito_user_pool_client.backend.client_secret },

        { name = "OTEL_SERVICE_NAME", value = local.nome_container },
        { name = "OTEL_DEPLOYMENT_ENVIRONMENT", value = "aws" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "deployment.environment=aws,service.version=${local.tag_imagem},cloud.region=${var.regiao}" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:4318" : "" },
        { name = "LOKI_PUSH_URL", value = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:3100/loki/api/v1/push" : "" },

        // O painel chega pelo Amplify, que repassa /api, /auth e /health para
        // este ALB (ver amplify.tf). Do ponto de vista do navegador tudo sai da
        // mesma origem, então FRONTEND_ORIGIN é a URL do Amplify.
        { name = "FRONTEND_ORIGIN", value = local.painel_url },

        // A reanálise publica na mesma fila de análise que a ingestão alimenta.
        // Sem o worker consumindo, o valor vai vazio e a API mantém a rota
        // fechada (FEATURE_UNAVAILABLE), em vez de aceitar pedidos sem consumidor.
        { name = "ANALYSIS_QUEUE_URL", value = var.analysis_worker_habilitado ? aws_sqs_queue.analysis.url : "" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Projeto = "view-show"
  }
}

// O Academy não permite anexar policy à LabRole. Em produção, esta policy
// inline fecha o contrato que a API precisa sem conceder acesso a outros itens,
// schedules ou roles. Permissões preexistentes da API continuam responsabilidade
// da role fornecida pelo operador.
resource "aws_iam_role_policy" "api_argus_live_sync" {
  count = local.ingestion_is_production ? 1 : 0

  name = "${var.deployment_namespace}-api-argus-live-sync"
  role = local.api_task_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ArgusLiveSyncState"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.operacional.arn
      },
      {
        Sid      = "ArgusLiveSyncSchedule"
        Effect   = "Allow"
        Action   = ["scheduler:GetSchedule", "scheduler:UpdateSchedule"]
        Resource = aws_scheduler_schedule.ingestion_sync.arn
      },
      {
        Sid      = "PassArgusSchedulerRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = local.ingestion_scheduler_execution_role_arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "scheduler.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_ecs_service" "api" {
  name            = local.nome_servico
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.quantidade_tasks
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = values(aws_subnet.privada)[*].id
    security_groups  = [aws_security_group.servico.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = local.nome_container
    container_port   = 3000
  }

  // Sem isto o apply termina antes de a task ficar saudável, e o teste seguinte
  // bateria num ALB que ainda devolve 503.
  wait_for_steady_state = true

  health_check_grace_period_seconds = 30

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [
    aws_lb_listener.http,
    terraform_data.imagem,
  ]

  tags = {
    Projeto = "view-show"
  }
}
