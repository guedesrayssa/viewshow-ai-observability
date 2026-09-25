output "painel_url" {
  description = "Endereço do painel. É por aqui que se entra — o Amplify serve o Next.js e repassa /api, /auth e /health para o ALB."
  value       = local.painel_url
}

output "deployment_namespace" {
  description = "Namespace isolado que identifica todos os recursos desta stack."
  value       = var.deployment_namespace
}

output "api_url" {
  description = "Endereço direto do ALB. Serve para curl e Postman; o navegador deve usar painel_url, porque uma página HTTPS não pode chamar uma API em HTTP."
  value       = "http://${aws_lb.principal.dns_name}"
}

output "tabelas_dynamodb" {
  description = "Tabelas criadas."
  value = {
    operacional = aws_dynamodb_table.operacional.name
    golden_set  = aws_dynamodb_table.golden_set.name
  }
}

output "imagem_ecr" {
  description = "URI da imagem referenciada pela task ECS."
  value       = local.uri_imagem
}

output "comando_logs" {
  description = "Acompanha o log da API em tempo real."
  value       = "aws logs tail ${aws_cloudwatch_log_group.api.name} --follow --region ${var.regiao}"
}

output "rede_vpc" {
  description = "Identificadores da VPC e das sub-redes para conferência no console."
  value = {
    vpc_id            = aws_vpc.principal.id
    subredes_publicas = { for chave, subnet in aws_subnet.publica : chave => subnet.id }
    subredes_privadas = { for chave, subnet in aws_subnet.privada : chave => subnet.id }
    nat_gateway_id    = aws_nat_gateway.principal.id
  }
}

output "bastion_acesso" {
  description = "Identificação e comandos de acesso ao bastion. SSH só aparece quando um CIDR administrativo foi autorizado."
  value = {
    instancia_id = aws_instance.bastion.id
    ip_publico   = aws_instance.bastion.public_ip
    sessao_ssm   = "aws ssm start-session --target ${aws_instance.bastion.id} --region ${var.regiao}"
    ssh          = var.bastion_admin_cidr == null ? null : "ssh ec2-user@${aws_instance.bastion.public_ip}"
  }
}

output "flow_logs" {
  description = "Destino e identificador dos VPC Flow Logs."
  value = {
    flow_log_id = aws_flow_log.vpc.id
    bucket      = local.nome_bucket_flow_logs
    prefixo     = "vpc-flow-logs/AWSLogs/${data.aws_caller_identity.atual.account_id}"
  }
}

output "ecs_auto_scaling" {
  description = "Limites e alvo da política de escalonamento das tasks Fargate."
  value = {
    minimo   = aws_appautoscaling_target.api.min_capacity
    maximo   = aws_appautoscaling_target.api.max_capacity
    cpu_alvo = var.ecs_cpu_alvo
    politica = aws_appautoscaling_policy.cpu_api.name
  }
}

output "aviso_custo" {
  description = "Leia antes de fechar o laboratório."
  value       = "Preserve a stack e o novo estado local ao fim da sessao para inspecao e diagnostico. Execute 'terraform destroy' somente sob pedido explicito posterior, usando esse mesmo estado. Enquanto provisionados, ALB, NAT Gateway, bastion, tasks Fargate e a EC2 opcional de observabilidade continuam gerando custo."
}

output "api_url_https" {
  description = "Endereço HTTPS da API, via API Gateway. É para onde o Amplify repassa /api, /auth e /health."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "grafana_acesso" {
  description = "Acesso ao Grafana quando a observabilidade estiver habilitada. Por padrão, use o túnel SSM."
  value = var.observabilidade_habilitada ? {
    usuario    = "admin"
    url_direta = var.grafana_cidr_acesso == null ? null : "http://${aws_instance.observabilidade[0].public_dns}:3000"
    tunel_ssm  = "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3002 --region ${var.regiao}"
    url_tunel  = "http://localhost:3002"
  } : null
}

output "grafana_senha" {
  description = "Senha gerada para o usuário admin do Grafana."
  value       = var.observabilidade_habilitada ? random_password.grafana[0].result : null
  sensitive   = true
}

output "observabilidade_instancia_id" {
  description = "ID da EC2 que hospeda Grafana, Prometheus, Loki, Tempo e Alloy."
  value       = var.observabilidade_habilitada ? aws_instance.observabilidade[0].id : null
}

output "observabilidade_otlp_workers_endpoint" {
  description = "Endpoint OTLP/HTTP privado do Alloy para os futuros workers ECS que usam o security group da aplicacao."
  value       = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:4320" : null
}

output "observabilidade_loki_push_url" {
  description = "URL privada para envio assíncrono dos logs estruturados da API."
  value       = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:3100/loki/api/v1/push" : null
}

output "comando_status_observabilidade" {
  description = "Abre uma sessão SSM na EC2 para verificar cloud-init e containers."
  value       = var.observabilidade_habilitada ? "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --region ${var.regiao}" : null
}

output "ingestion_runbook" {
  description = "Identificadores e comandos seguros para operar a ingestão sem expor valores de segredo."
  value = {
    ambiente             = var.ambiente
    deployment_namespace = var.deployment_namespace
    image = {
      repository_url = aws_ecr_repository.ingestion.repository_url
      immutable_uri  = local.ingestion_image_uri
    }
    storage = {
      bucket                     = local.ingestion_bucket_name
      athena_output_location     = local.ingestion_athena_output_location
      glue_database              = aws_glue_catalog_database.ingestion.name
      athena_workgroup           = aws_athena_workgroup.ingestion.name
      incremental_raw_prefix     = local.ingestion_incremental_raw_prefix
      incremental_retention_days = var.retencao_raw_incremental_ingestao_dias
    }
    messaging = {
      analysis_queue_url    = aws_sqs_queue.analysis.url
      analysis_queue_arn    = aws_sqs_queue.analysis.arn
      analysis_dlq_arn      = aws_sqs_queue.analysis_dlq.arn
      scheduler_dlq_arn     = aws_sqs_queue.ingestion_scheduler_dlq.arn
      scheduler_dlq_url     = aws_sqs_queue.ingestion_scheduler_dlq.url
      incremental_queue_url = aws_sqs_queue.incremental_batches.url
      incremental_queue_arn = aws_sqs_queue.incremental_batches.arn
      incremental_dlq_url   = aws_sqs_queue.incremental_batches_dlq.url
      incremental_dlq_arn   = aws_sqs_queue.incremental_batches_dlq.arn
    }
    data = {
      operational_table     = aws_dynamodb_table.operacional.name
      outbox_pending_index  = "outbox-pending-index"
      snapshot_secret_arn   = local.ingestion_snapshot_mysql_secret_arn
      live_mysql_secret_arn = local.ingestion_live_mysql_secret_arn
    }
    imports = {
      bucket                       = local.ingestion_bucket_name
      expected_bucket_owner        = data.aws_caller_identity.atual.account_id
      cors_origin                  = local.painel_url
      cluster_arn                  = aws_ecs_cluster.principal.arn
      task_definition_arn          = aws_ecs_task_definition.ingestion_import.arn
      container_name               = "ingestion"
      subnet_ids                   = local.ingestion_subnet_ids
      security_group_id            = aws_security_group.ingestion.id
      assign_public_ip             = local.ingestion_assign_public_ip
      platform_version             = "1.4.0"
      api_task_role_arn            = local.api_task_role_arn
      worker_execution_role_arn    = local.ingestion_ecs_execution_role_arn
      worker_task_role_arn         = local.ingestion_import_task_role_arn
      iam_isolation_enforced       = local.ingestion_is_production
      ephemeral_storage_gib        = var.ingestion_backfill_ephemeral_storage_gib
      disk_budget_bytes            = local.ingestion_snapshot_disk_budget_bytes
      reconciliation_failure_alarm = aws_cloudwatch_metric_alarm.import_reconciliation_failures.arn
      active_upload_age_alarm      = aws_cloudwatch_metric_alarm.import_active_upload_age.arn
      worker_failure_alarm         = aws_cloudwatch_metric_alarm.import_worker_failures.arn
    }
    runtime = {
      cluster_arn          = aws_ecs_cluster.principal.arn
      cluster_name         = aws_ecs_cluster.principal.name
      backfill_task_arn    = aws_ecs_task_definition.ingestion_backfill.arn
      backfill_task_family = aws_ecs_task_definition.ingestion_backfill.family
      import_task_arn      = aws_ecs_task_definition.ingestion_import.arn
      import_task_family   = aws_ecs_task_definition.ingestion_import.family
      sync_task_arn        = aws_ecs_task_definition.ingestion_sync.arn
      sync_task_family     = aws_ecs_task_definition.ingestion_sync.family
      security_group_id    = aws_security_group.ingestion.id
      subnet_ids           = local.ingestion_subnet_ids
      assign_public_ip     = local.ingestion_assign_public_ip
      platform_version     = "1.4.0"
      backfill_log_group   = aws_cloudwatch_log_group.ingestion_backfill.name
      sync_log_group       = aws_cloudwatch_log_group.ingestion_sync.name
    }
    scheduler = {
      group_name   = aws_scheduler_schedule_group.ingestion.name
      name         = aws_scheduler_schedule.ingestion_sync.name
      schedule_arn = aws_scheduler_schedule.ingestion_sync.arn
      state        = aws_scheduler_schedule.ingestion_sync.state
    }
    incremental = {
      enabled                    = var.incremental_s3_enabled
      live_integration_gate      = var.live_sync_enabled
      export_task_arn            = aws_ecs_task_definition.ingestion_incremental_export.arn
      export_task_family         = aws_ecs_task_definition.ingestion_incremental_export.family
      ingest_task_arn            = aws_ecs_task_definition.ingestion_incremental_ingest.arn
      ingest_task_family         = aws_ecs_task_definition.ingestion_incremental_ingest.family
      export_task_role_arn       = local.ingestion_incremental_export_task_role_arn
      ingest_task_role_arn       = local.ingestion_incremental_ingest_task_role_arn
      export_schedule_arn        = aws_scheduler_schedule.ingestion_incremental_export.arn
      export_schedule_state      = aws_scheduler_schedule.ingestion_incremental_export.state
      export_schedule_expression = aws_scheduler_schedule.ingestion_incremental_export.schedule_expression
      ingest_schedule_arn        = aws_scheduler_schedule.ingestion_incremental_ingest.arn
      ingest_schedule_state      = aws_scheduler_schedule.ingestion_incremental_ingest.state
      ingest_schedule_expression = aws_scheduler_schedule.ingestion_incremental_ingest.schedule_expression
      quarantine_alarm_arn       = aws_cloudwatch_metric_alarm.incremental_batch_quarantined.arn
      watermark_lag_alarm_arn    = aws_cloudwatch_metric_alarm.incremental_watermark_lag.arn
      queue_backlog_alarm_arn    = aws_cloudwatch_metric_alarm.incremental_queue_backlog.arn
      queue_oldest_age_alarm_arn = aws_cloudwatch_metric_alarm.incremental_queue_oldest_age.arn
      dlq_alarm_arn              = aws_cloudwatch_metric_alarm.incremental_dlq_depth.arn
    }
    observability = {
      dashboard_name         = aws_cloudwatch_dashboard.ingestion.dashboard_name
      backfill_failure_alarm = aws_cloudwatch_metric_alarm.ingestion_backfill_failures.arn
      sync_failure_alarm     = aws_cloudwatch_metric_alarm.ingestion_sync_failures.arn
      sync_absence_alarm     = var.scheduler_ingestao_habilitado ? aws_cloudwatch_metric_alarm.ingestion_sync_absence[0].arn : null
      analysis_backlog_alarm = aws_cloudwatch_metric_alarm.analysis_queue_backlog.arn
      analysis_dlq_alarm     = aws_cloudwatch_metric_alarm.analysis_dlq_depth.arn
      scheduler_dlq_alarm    = aws_cloudwatch_metric_alarm.scheduler_dlq_depth.arn
      scheduler_target_alarm = aws_cloudwatch_metric_alarm.scheduler_target_errors.arn
      partial_alarm_arns     = { for name, alarm in aws_cloudwatch_metric_alarm.ingestion_partial_runs : name => alarm.arn }
      schema_drift_alarm_arns = {
        for name, alarm in aws_cloudwatch_metric_alarm.ingestion_schema_drift : name => alarm.arn
      }
      stage_failure_alarm_arns = {
        for name, alarm in aws_cloudwatch_metric_alarm.ingestion_stage_failures : name => alarm.arn
      }
      projecting_duration_alarm         = aws_cloudwatch_metric_alarm.ingestion_projecting_duration.arn
      rebuild_projections_failure_alarm = aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures.arn
      resource_utilization_alarm_arns = {
        for name, alarm in aws_cloudwatch_metric_alarm.ingestion_resource_utilization : name => alarm.arn
      }
      athena_failure_alarm      = aws_cloudwatch_metric_alarm.ingestion_athena_failures.arn
      athena_processed_alarm    = aws_cloudwatch_metric_alarm.ingestion_athena_processed_bytes.arn
      outbox_oldest_age_alarm   = aws_cloudwatch_metric_alarm.ingestion_outbox_oldest_age.arn
      analysis_oldest_age_alarm = aws_cloudwatch_metric_alarm.analysis_queue_oldest_age.arn
    }
  }
}

output "comando_ingestion_backfill" {
  description = "Base do comando manual de backfill; antes de rodar, inclua no override os metadados imutáveis SNAPSHOT_OBJECT_KEY, SNAPSHOT_OBJECT_VERSION_ID e SNAPSHOT_SHA256."
  value = format(
    "aws ecs run-task --cluster %s --task-definition %s --launch-type FARGATE --platform-version 1.4.0 --network-configuration 'awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=%s}' --region %s",
    aws_ecs_cluster.principal.name,
    aws_ecs_task_definition.ingestion_backfill.arn,
    join(",", local.ingestion_subnet_ids),
    aws_security_group.ingestion.id,
    local.ingestion_assign_public_ip ? "ENABLED" : "DISABLED",
    var.regiao,
  )
}

output "comandos_logs_ingestao" {
  description = "Comandos AWS CLI para acompanhar separadamente os logs das operações batch."
  value = {
    backfill           = "aws logs tail ${aws_cloudwatch_log_group.ingestion_backfill.name} --follow --region ${var.regiao}"
    sync               = "aws logs tail ${aws_cloudwatch_log_group.ingestion_sync.name} --follow --region ${var.regiao}"
    incremental_export = "aws logs tail ${aws_cloudwatch_log_group.ingestion_incremental_export.name} --follow --region ${var.regiao}"
    incremental_ingest = "aws logs tail ${aws_cloudwatch_log_group.ingestion_incremental_ingest.name} --follow --region ${var.regiao}"
  }
}
