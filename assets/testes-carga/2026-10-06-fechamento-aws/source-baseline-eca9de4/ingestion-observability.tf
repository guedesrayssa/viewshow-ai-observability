// Observabilidade separa logs, métricas com dimensões limitadas, alarmes e
// dashboard para manter sinais operacionais controlados e consultáveis.
resource "aws_cloudwatch_log_group" "ingestion_backfill" {
  name              = "/ecs/${local.ingestion_backfill_family}"
  retention_in_days = var.retencao_logs_ingestao_dias

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "backfill"
  }
}

resource "aws_cloudwatch_log_group" "ingestion_sync" {
  name              = "/ecs/${local.ingestion_sync_family}"
  retention_in_days = var.retencao_logs_ingestao_dias

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "sync"
  }
}

resource "aws_cloudwatch_log_group" "ingestion_incremental_export" {
  name              = "/ecs/${local.ingestion_incremental_export_family}"
  retention_in_days = var.retencao_logs_ingestao_dias

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "export-incremental"
  }
}

resource "aws_cloudwatch_log_group" "ingestion_incremental_ingest" {
  name              = "/ecs/${local.ingestion_incremental_ingest_family}"
  retention_in_days = var.retencao_logs_ingestao_dias

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "ingest-incremental"
  }
}

locals {
  ingestion_resource_metrics = {
    "backfill-cpu" = {
      task_family = aws_ecs_task_definition.ingestion_backfill.family
      utilized    = "CpuUtilized"
      reserved    = "CpuReserved"
    }
    "backfill-memory" = {
      task_family = aws_ecs_task_definition.ingestion_backfill.family
      utilized    = "MemoryUtilized"
      reserved    = "MemoryReserved"
    }
    "backfill-storage" = {
      task_family = aws_ecs_task_definition.ingestion_backfill.family
      utilized    = "EphemeralStorageUtilized"
      reserved    = "EphemeralStorageReserved"
    }
    "sync-cpu" = {
      task_family = aws_ecs_task_definition.ingestion_sync.family
      utilized    = "CpuUtilized"
      reserved    = "CpuReserved"
    }
    "sync-memory" = {
      task_family = aws_ecs_task_definition.ingestion_sync.family
      utilized    = "MemoryUtilized"
      reserved    = "MemoryReserved"
    }
    "sync-storage" = {
      task_family = aws_ecs_task_definition.ingestion_sync.family
      utilized    = "EphemeralStorageUtilized"
      reserved    = "EphemeralStorageReserved"
    }
  }
  ingestion_runtime_commands = {
    backfill = {
      source_mode = "snapshot"
      period      = 300
    }
    sync = {
      source_mode = "live"
      period      = 900
    }
  }
  ingestion_failure_stages = {
    projecting = "PROJECTING"
    archiving  = "ARCHIVING"
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_resource_utilization" {
  for_each = local.ingestion_resource_metrics

  alarm_name          = "${local.ingestion_name_prefix}-${each.key}-utilization"
  alarm_description   = "Container Insights reportou utilização de ${each.key} igual ou superior a 70%."
  evaluation_periods  = 1
  threshold           = 70
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  metric_query {
    id          = "used"
    return_data = false

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = each.value.utilized
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName          = aws_ecs_cluster.principal.name
        TaskDefinitionFamily = each.value.task_family
      }
    }
  }

  metric_query {
    id          = "reserved"
    return_data = false

    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = each.value.reserved
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName          = aws_ecs_cluster.principal.name
        TaskDefinitionFamily = each.value.task_family
      }
    }
  }

  metric_query {
    id          = "utilization"
    expression  = "100 * used / reserved"
    label       = "Utilização percentual de ${each.key}"
    return_data = true
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_partial_runs" {
  for_each = local.ingestion_runtime_commands

  alarm_name          = "${local.ingestion_name_prefix}-${each.key}-partial"
  alarm_description   = "O runtime EMF reportou uma execução ${each.key} parcial."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "Runs"
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = each.key
    source_mode = each.value.source_mode
    status      = "PARTIAL"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_schema_drift" {
  for_each = local.ingestion_runtime_commands

  alarm_name          = "${local.ingestion_name_prefix}-${each.key}-schema-drift"
  alarm_description   = "A validação tipada reportou schema incompatível na origem ${each.value.source_mode}."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "SchemaDrift"
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = each.key
    source_mode = each.value.source_mode
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_stage_failures" {
  for_each = local.ingestion_failure_stages

  alarm_name          = "${local.ingestion_name_prefix}-${each.key}-failures"
  alarm_description   = "A transição persistida da etapa ${each.value} terminou em PARTIAL ou FAILED."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "StageFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command = "backfill"
    stage   = each.value
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_projecting_duration" {
  alarm_name          = "${local.ingestion_name_prefix}-projecting-duration"
  alarm_description   = "A etapa PROJECTING do backfill excedeu a duração configurada."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "StageDurationMs"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.limiar_duracao_projecao_ingestao_ms
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command = "backfill"
    stage   = "PROJECTING"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_rebuild_projections_failures" {
  alarm_name          = "${local.ingestion_name_prefix}-rebuild-projections-failures"
  alarm_description   = "O runtime EMF reportou uma execução de rebuild-projections com falha."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "Runs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.limiar_falhas_rebuild_projecoes_ingestao
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command = "rebuild-projections"
    status  = "FAILED"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_athena_failures" {
  alarm_name          = "${local.ingestion_name_prefix}-athena-failures"
  alarm_description   = "O boundary tipado da validação Athena reportou falha."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "AthenaFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command = "backfill"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

// ProcessedBytes nativo é a fonte autoritativa; o runtime não replica bytes
// sem que o resultado tipado do Athena carregue essa evidência.
resource "aws_cloudwatch_metric_alarm" "ingestion_athena_processed_bytes" {
  alarm_name          = "${local.ingestion_name_prefix}-athena-processed-bytes"
  alarm_description   = "Uma consulta consumiu ao menos 70% do corte de 1 GiB do workgroup."
  namespace           = "AWS/Athena"
  metric_name         = "ProcessedBytes"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 751619277
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    WorkGroup = aws_athena_workgroup.ingestion.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_outbox_oldest_age" {
  alarm_name          = "${local.ingestion_name_prefix}-outbox-oldest-age"
  alarm_description   = "A observação eventual do GSI encontrou evento pendente há pelo menos 15 minutos."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "OutboxOldestAgeSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 900
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_backfill_failures" {
  alarm_name          = "${local.ingestion_name_prefix}-backfill-failures"
  alarm_description   = "O runtime EMF reportou uma execução de backfill com falha."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "Runs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "backfill"
    source_mode = "snapshot"
    status      = "FAILED"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_disk_usage_warning" {
  alarm_name          = "${local.ingestion_name_prefix}-snapshot-disk-warning"
  alarm_description   = "O pico local do import de snapshot atingiu 80% do orçamento de 64 GiB da aplicação."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "LocalDiskPeakBytes"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = local.ingestion_snapshot_disk_budget_bytes * 0.80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "import-dump"
    source_mode = "snapshot"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_disk_usage_critical" {
  alarm_name          = "${local.ingestion_name_prefix}-snapshot-disk-critical"
  alarm_description   = "O pico local do import de snapshot atingiu 90% do orçamento de 64 GiB da aplicação."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "LocalDiskPeakBytes"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = local.ingestion_snapshot_disk_budget_bytes * 0.90
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "import-dump"
    source_mode = "snapshot"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_canonical_archive_failures" {
  alarm_name          = "${local.ingestion_name_prefix}-canonical-archive-failures"
  alarm_description   = "O archive Parquet do import canônico reportou falha."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "ArchiveFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command   = "import-dump"
    component = "PARQUET"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_sync_failures" {
  alarm_name          = "${local.ingestion_name_prefix}-sync-failures"
  alarm_description   = "O runtime EMF reportou uma execução de sync com falha."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "Runs"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "sync"
    source_mode = "live"
    status      = "FAILED"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

// A ausência de sync só é um sinal quando o agendamento foi explicitamente
// habilitado; fora disso, count=0 evita um alarme constantemente em breaching.
resource "aws_cloudwatch_metric_alarm" "ingestion_sync_absence" {
  count = var.scheduler_ingestao_habilitado ? 1 : 0

  alarm_name          = "${local.ingestion_name_prefix}-sync-absence"
  alarm_description   = "Nenhuma execução sync bem-sucedida foi emitida pelo runtime no período esperado."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "Runs"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "sync"
    source_mode = "live"
    status      = "SUCCEEDED"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "analysis_queue_backlog" {
  alarm_name          = "${local.ingestion_name_prefix}-analysis-queue-backlog"
  alarm_description   = "A fila de análise possui mensagens visíveis aguardando consumo."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.analysis.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "analysis_queue_oldest_age" {
  alarm_name          = "${local.ingestion_name_prefix}-analysis-queue-oldest-age"
  alarm_description   = "A mensagem mais antiga da fila de análise aguarda há pelo menos 15 minutos."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 900
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.analysis.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "analysis_dlq_depth" {
  alarm_name          = "${local.ingestion_name_prefix}-analysis-dlq-depth"
  alarm_description   = "A DLQ da análise contém mensagens que exigem investigação."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.analysis_dlq.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "scheduler_dlq_depth" {
  alarm_name          = "${local.ingestion_name_prefix}-scheduler-dlq-depth"
  alarm_description   = "A DLQ do EventBridge Scheduler contém invocações não entregues."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.ingestion_scheduler_dlq.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "scheduler_target_errors" {
  alarm_name          = "${local.ingestion_name_prefix}-scheduler-target-errors"
  alarm_description   = "O EventBridge Scheduler não conseguiu iniciar a task ECS de sync."
  namespace           = "AWS/Scheduler"
  metric_name         = "TargetErrorCount"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    ScheduleGroup = aws_scheduler_schedule_group.ingestion.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "incremental_queue_backlog" {
  alarm_name          = "${local.ingestion_name_prefix}-incremental-queue-backlog"
  alarm_description   = "A fila FIFO incremental possui lotes visíveis aguardando consumo."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.incremental_batches.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "incremental_queue_oldest_age" {
  alarm_name          = "${local.ingestion_name_prefix}-incremental-queue-oldest-age"
  alarm_description   = "O lote mais antigo da fila incremental aguarda há pelo menos quinze minutos."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 900
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.incremental_batches.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "incremental_dlq_depth" {
  alarm_name          = "${local.ingestion_name_prefix}-incremental-dlq-depth"
  alarm_description   = "A DLQ FIFO incremental contém lotes que exigem investigação e redrive manual."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    QueueName = aws_sqs_queue.incremental_batches_dlq.name
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "incremental_batch_quarantined" {
  alarm_name          = "${local.ingestion_name_prefix}-incremental-batch-quarantined"
  alarm_description   = "O runtime incremental colocou ao menos um lote signal_bucket em quarentena."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "IncrementalBatchQuarantined"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command = "ingest-incremental"
    status  = "QUARANTINED"
    dataset = "signal_bucket"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_metric_alarm" "incremental_watermark_lag" {
  alarm_name          = "${local.ingestion_name_prefix}-incremental-watermark-lag"
  alarm_description   = "O watermark exportado de signal_bucket está atrasado em pelo menos trinta minutos."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "IncrementalBatchLagSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1800
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command = "export-incremental"
    status  = "SUCCEEDED"
    dataset = "signal_bucket"
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_cloudwatch_dashboard" "ingestion" {
  dashboard_name = local.ingestion_name_prefix

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Execuções de ingestão emitidas pelo runtime"
          view   = "timeSeries"
          region = var.regiao
          stat   = "Sum"
          period = 300
          metrics = [
            [local.ingestion_metrics_namespace, "Runs", "command", "backfill", "source_mode", "snapshot", "status", "SUCCEEDED", { label = "Backfill concluído" }],
            [".", "Runs", "command", "backfill", "source_mode", "snapshot", "status", "PARTIAL", { label = "Backfill parcial" }],
            [".", "Runs", "command", "backfill", "source_mode", "snapshot", "status", "FAILED", { label = "Backfill falhou" }],
            [".", "Runs", "command", "sync", "source_mode", "live", "status", "SUCCEEDED", { label = "Sync concluído" }],
            [".", "Runs", "command", "sync", "source_mode", "live", "status", "PARTIAL", { label = "Sync parcial" }],
            [".", "Runs", "command", "sync", "source_mode", "live", "status", "FAILED", { label = "Sync falhou" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Filas e DLQs"
          view   = "timeSeries"
          region = var.regiao
          stat   = "Maximum"
          period = 300
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.analysis.name, { label = "Análise" }],
            [".", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.analysis.name, { label = "Idade análise" }],
            [".", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.analysis_dlq.name, { label = "DLQ análise" }],
            [".", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.ingestion_scheduler_dlq.name, { label = "DLQ Scheduler" }],
            [".", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.incremental_batches.name, { label = "Lotes incrementais" }],
            [".", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.incremental_batches.name, { label = "Idade incremental" }],
            [".", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.incremental_batches_dlq.name, { label = "DLQ incremental" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Erros do alvo do Scheduler"
          view   = "timeSeries"
          region = var.regiao
          stat   = "Sum"
          period = 900
          metrics = [
            ["AWS/Scheduler", "TargetErrorCount", "ScheduleGroup", aws_scheduler_schedule_group.ingestion.name],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Integridade do pipeline"
          view   = "timeSeries"
          region = var.regiao
          stat   = "Sum"
          period = 300
          metrics = [
            [local.ingestion_metrics_namespace, "SchemaDrift", "command", "backfill", "source_mode", "snapshot", { label = "Schema drift backfill" }],
            [".", "SchemaDrift", "command", "sync", "source_mode", "live", { label = "Schema drift sync" }],
            [".", "StageFailures", "command", "backfill", "stage", "PROJECTING", { label = "Falha projeção" }],
            [".", "StageFailures", "command", "backfill", "stage", "ARCHIVING", { label = "Falha archive" }],
            [".", "AthenaFailures", "command", "backfill", { label = "Falha Athena" }],
            [local.ingestion_metrics_namespace, "MySqlRetries", "command", "import-dump", "source_mode", "snapshot", "dataset", "signal_bucket", { label = "Retries MySQL import" }],
            [".", "MySqlPreflightFailures", "command", "import-dump", "source_mode", "snapshot", { label = "Falhas preflight MySQL" }],
            [".", "MySqlPageDurationMs", "command", "import-dump", "source_mode", "snapshot", "dataset", "signal_bucket", { label = "Duração página MySQL", stat = "Maximum" }],
            [".", "OutboxPendingCount", { label = "Quantidade outbox", stat = "Maximum" }],
            [".", "OutboxOldestAgeSeconds", { label = "Idade outbox", stat = "Maximum" }],
            [local.ingestion_metrics_namespace, "IncrementalBatches", "command", "ingest-incremental", "status", "SUCCEEDED", "dataset", "signal_bucket", { label = "Lotes incrementais" }],
            [".", "IncrementalBatchLagSeconds", "command", "export-incremental", "status", "SUCCEEDED", "dataset", "signal_bucket", { label = "Lag incremental", stat = "Maximum" }],
            [".", "IncrementalSchemaExtraColumns", "command", "ingest-incremental", "status", "SUCCEEDED", "dataset", "signal_bucket", { label = "Colunas extras raw" }],
            [".", "IncrementalBatchQuarantined", "command", "ingest-incremental", "status", "SUCCEEDED", "dataset", "signal_bucket", { label = "Lotes em quarentena" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 24
        height = 6
        properties = {
          title  = "Recursos das tasks (Container Insights)"
          view   = "timeSeries"
          region = var.regiao
          stat   = "Average"
          period = 300
          metrics = [
            ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", aws_ecs_cluster.principal.name, "TaskDefinitionFamily", aws_ecs_task_definition.ingestion_backfill.family, { label = "CPU backfill utilizada" }],
            [".", "CpuReserved", ".", ".", ".", ".", { label = "CPU backfill reservada" }],
            [".", "MemoryUtilized", ".", ".", ".", ".", { label = "Memória backfill utilizada" }],
            [".", "MemoryReserved", ".", ".", ".", ".", { label = "Memória backfill reservada" }],
            [".", "EphemeralStorageUtilized", ".", ".", ".", ".", { label = "Disco backfill utilizado" }],
            [".", "EphemeralStorageReserved", ".", ".", ".", ".", { label = "Disco backfill reservado" }],
            [".", "CpuUtilized", "ClusterName", aws_ecs_cluster.principal.name, "TaskDefinitionFamily", aws_ecs_task_definition.ingestion_sync.family, { label = "CPU sync utilizada" }],
            [".", "CpuReserved", ".", ".", ".", ".", { label = "CPU sync reservada" }],
            [".", "MemoryUtilized", ".", ".", ".", ".", { label = "Memória sync utilizada" }],
            [".", "MemoryReserved", ".", ".", ".", ".", { label = "Memória sync reservada" }],
            [".", "EphemeralStorageUtilized", ".", ".", ".", ".", { label = "Disco sync utilizado" }],
            [".", "EphemeralStorageReserved", ".", ".", ".", ".", { label = "Disco sync reservado" }],
            ["AWS/Athena", "ProcessedBytes", "WorkGroup", aws_athena_workgroup.ingestion.name, { label = "Athena bytes processados" }],
          ]
        }
      },
    ]
  })
}
