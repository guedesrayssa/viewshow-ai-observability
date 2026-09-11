resource "aws_ecs_cluster" "principal" {
  name = local.nome_cluster

  setting {
    name  = "containerInsights"
    value = "disabled"
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

  // LabRole nos dois papéis: é a única role disponível no AWS Academy
  // (backend-sprint-2.md, seção 8.1).
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

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
        { name = "PORT", value = "3000" },
        { name = "AWS_REGION", value = var.regiao },
        { name = "OPERATIONAL_TABLE_NAME", value = aws_dynamodb_table.operacional.name },
        { name = "GOLDEN_SET_TABLE_NAME", value = aws_dynamodb_table.golden_set.name },
        { name = "BEDROCK_ENABLED", value = tostring(var.bedrock_habilitado) },
        { name = "BEDROCK_MODEL_ID", value = "anthropic.claude-3-haiku-20240307-v1:0" },
        { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },
        { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },

        // Cognito: a task autentica POST /auth/login contra este User Pool pelo
        // fluxo USER_PASSWORD_AUTH. O client é confidencial, então o secret vai
        // junto. Mesmo tratamento em texto plano dos dois segredos acima: nascem
        // no Terraform, entram só na task e nunca passam pelo git.
        { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.principal.id },
        { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.backend.id },
        { name = "COGNITO_CLIENT_SECRET", value = aws_cognito_user_pool_client.backend.client_secret },

        { name = "OTEL_SERVICE_NAME", value = local.nome_container },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:4318" : "" },

        // O painel chega pelo Amplify, que repassa /api, /auth e /health para
        // este ALB (ver amplify.tf). Do ponto de vista do navegador tudo sai da
        // mesma origem, então FRONTEND_ORIGIN é a URL do Amplify.
        { name = "FRONTEND_ORIGIN", value = "https://${var.branch_amplify}.${aws_amplify_app.painel.default_domain}" },
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

resource "aws_ecs_service" "api" {
  name            = local.nome_servico
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.quantidade_tasks
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = data.aws_subnets.default.ids
    security_groups = [aws_security_group.servico.id]

    // Sem IP público a task não alcançaria o ECR para puxar a imagem, e a única
    // alternativa seria NAT Gateway ou VPC endpoints. Ambos custam mais do que
    // toda a demonstração.
    assign_public_ip = true
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

  depends_on = [
    aws_lb_listener.http,
    terraform_data.imagem,
  ]

  tags = {
    Projeto = "view-show"
  }
}
