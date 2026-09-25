// Trigger de sync live a cada quinze minutos, criado desligado. Após o primeiro
// deploy, a aplicação gerencia exclusivamente o state do Scheduler.
// A LabRole é reutilizada no Learner Lab, mas sua trust policy para
// scheduler.amazonaws.com e ecs:RunTask/iam:PassRole continua uma validação
// operacional necessária antes de habilitar.

resource "aws_scheduler_schedule_group" "ingestion" {
  name = local.ingestion_scheduler_group

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_scheduler_schedule" "ingestion_sync" {
  name                         = local.ingestion_sync_family
  group_name                   = aws_scheduler_schedule_group.ingestion.name
  description                  = "Executa a sincronização incremental do Argus a cada quinze minutos."
  schedule_expression          = "rate(15 minutes)"
  schedule_expression_timezone = "UTC"
  state                        = var.scheduler_ingestao_habilitado ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.principal.arn
    role_arn = local.ingestion_scheduler_execution_role_arn

    dead_letter_config {
      arn = aws_sqs_queue.ingestion_scheduler_dlq.arn
    }

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.ingestion_sync.arn
      launch_type         = "FARGATE"
      platform_version    = "1.4.0"
      task_count          = 1

      network_configuration {
        subnets          = local.ingestion_subnet_ids
        security_groups  = [aws_security_group.ingestion.id]
        assign_public_ip = local.ingestion_assign_public_ip
      }
    }
  }

  lifecycle {
    ignore_changes = [state]
  }
}

resource "aws_scheduler_schedule" "ingestion_incremental_export" {
  name                         = local.ingestion_incremental_export_family
  group_name                   = aws_scheduler_schedule_group.ingestion.name
  description                  = "Exporta uma janela ARGUS fechada para o prefixo raw incremental a cada quinze minutos."
  schedule_expression          = "rate(15 minutes)"
  schedule_expression_timezone = "UTC"
  state                        = var.incremental_s3_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.principal.arn
    role_arn = local.ingestion_scheduler_execution_role_arn

    dead_letter_config {
      arn = aws_sqs_queue.ingestion_scheduler_dlq.arn
    }

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.ingestion_incremental_export.arn
      launch_type         = "FARGATE"
      platform_version    = "1.4.0"
      task_count          = 1

      network_configuration {
        subnets          = local.ingestion_subnet_ids
        security_groups  = [aws_security_group.ingestion.id]
        assign_public_ip = local.ingestion_assign_public_ip
      }
    }
  }

  lifecycle {
    precondition {
      condition     = !var.incremental_s3_enabled || var.live_sync_enabled
      error_message = "O export incremental só pode ser habilitado quando live_sync_enabled=true e o acesso ARGUS estiver homologado."
    }
  }
}

resource "aws_scheduler_schedule" "ingestion_incremental_ingest" {
  name                         = local.ingestion_incremental_ingest_family
  group_name                   = aws_scheduler_schedule_group.ingestion.name
  description                  = "Consome referências FIFO de lotes raw incrementais a cada cinco minutos."
  schedule_expression          = "rate(5 minutes)"
  schedule_expression_timezone = "UTC"
  state                        = var.incremental_s3_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.principal.arn
    role_arn = local.ingestion_scheduler_execution_role_arn

    dead_letter_config {
      arn = aws_sqs_queue.ingestion_scheduler_dlq.arn
    }

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.ingestion_incremental_ingest.arn
      launch_type         = "FARGATE"
      platform_version    = "1.4.0"
      task_count          = 1

      network_configuration {
        subnets          = local.ingestion_subnet_ids
        security_groups  = [aws_security_group.ingestion.id]
        assign_public_ip = local.ingestion_assign_public_ip
      }
    }
  }

  lifecycle {
    precondition {
      condition     = !var.incremental_s3_enabled || var.live_sync_enabled
      error_message = "O ingest incremental só pode ser habilitado quando live_sync_enabled=true e o acesso ARGUS estiver homologado."
    }
  }
}
