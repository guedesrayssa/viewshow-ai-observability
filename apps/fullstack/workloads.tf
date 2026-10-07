// Runtime configuration shared by the Kubernetes deployment stage.
locals {
  workload_api = {
    cpu    = var.cpu_task
    memory = var.memoria_task
    containers = [
      {
        name  = local.nome_container
        image = local.uri_imagem
        args  = []
        env = [
          { name = "NODE_ENV", value = "production" },
          { name = "PORT", value = "3000" },
          { name = "AWS_REGION", value = var.regiao },
          { name = "OPERATIONAL_TABLE_NAME", value = aws_dynamodb_table.operacional.name },
          { name = "KUBERNETES_NAMESPACE", value = var.deployment_namespace },
          { name = "INGESTION_CRONJOB_NAME", value = "ingestion-sync" },
          { name = "GOLDEN_SET_TABLE_NAME", value = aws_dynamodb_table.golden_set.name },
          { name = "BEDROCK_ENABLED", value = tostring(var.bedrock_habilitado) },
          { name = "BEDROCK_MODEL_ID", value = "anthropic.claude-3-haiku-20240307-v1:0" },
          { name = "AUTH_COOKIE_SECRET", value = random_password.auth_cookie_secret.result },
          { name = "CURSOR_SECRET", value = random_password.cursor_secret.result },
          { name = "RATE_LIMIT_PER_MINUTE", value = tostring(var.rate_limit_por_minuto) },
          { name = "IMPORT_BUCKET", value = local.ingestion_bucket_name },
          { name = "IMPORT_EXPECTED_BUCKET_OWNER", value = data.aws_caller_identity.atual.account_id },
          { name = "IMPORT_CURSOR_SECRET", value = random_password.cursor_secret.result },
          { name = "IMPORT_KUBERNETES_NAMESPACE", value = "${var.deployment_namespace}-imports" },
          { name = "IMPORT_KUBERNETES_TEMPLATE", value = "ingestion-import" },
          { name = "IMPORT_INGESTION_CONTAINER_NAME", value = "ingestion" },
          { name = "IMPORT_CANONICAL_FIRST_ENABLED", value = tostring(var.import_canonical_first_enabled) },


          { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.principal.id },
          { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.backend.id },
          { name = "COGNITO_CLIENT_SECRET", value = aws_cognito_user_pool_client.backend.client_secret },

          { name = "OTEL_SERVICE_NAME", value = local.nome_container },
          { name = "OTEL_DEPLOYMENT_ENVIRONMENT", value = "aws" },
          { name = "OTEL_RESOURCE_ATTRIBUTES", value = "deployment.environment=aws,service.version=${local.tag_imagem},cloud.region=${var.regiao}" },
          { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:4318" : "" },
          { name = "LOKI_PUSH_URL", value = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:3100/loki/api/v1/push" : "" },

          { name = "FRONTEND_ORIGIN", value = local.painel_url },

          { name = "ANALYSIS_QUEUE_URL", value = var.analysis_worker_habilitado ? aws_sqs_queue.analysis.url : "" },
        ]
        secrets = []
      }
    ]
  }
  workload_ingestion_backfill = {
    cpu    = var.ingestion_backfill_cpu
    memory = var.ingestion_backfill_memoria
    containers = [
      {
        name    = "mysql-snapshot"
        image   = var.imagem_mysql_snapshot
        args    = local.ingestion_snapshot_mysql_command
        env     = [{ name = "MYSQL_DATABASE", value = "argus" }]
        secrets = [{ name = "MYSQL_ROOT_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      },
      {
        name  = "ingestion"
        image = local.ingestion_image_uri
        args  = ["backfill"]
        env = concat(local.ingestion_shared_environment, local.ingestion_import_environment, [
          { name = "ARGUS_SOURCE_MODE", value = "snapshot" },
          { name = "MYSQL_HOST", value = "127.0.0.1" },
          { name = "MYSQL_PORT", value = "3306" },
          { name = "MYSQL_USER", value = "root" },
          { name = "MYSQL_DATABASE", value = "argus" },
          { name = "ARCHIVE_BUCKET", value = local.ingestion_bucket_name },
          { name = "GLUE_DATABASE", value = aws_glue_catalog_database.ingestion.name },
          { name = "ATHENA_WORKGROUP", value = aws_athena_workgroup.ingestion.name },
          { name = "ATHENA_OUTPUT_LOCATION", value = local.ingestion_athena_output_location },
          { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
        ])
        secrets = [{ name = "MYSQL_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      }
    ]
  }
  workload_ingestion_import = {
    cpu    = var.ingestion_backfill_cpu
    memory = var.ingestion_backfill_memoria
    containers = [
      {
        name    = "mysql-snapshot"
        image   = var.imagem_mysql_snapshot
        args    = local.ingestion_snapshot_mysql_command
        env     = [{ name = "MYSQL_DATABASE", value = "argus" }]
        secrets = [{ name = "MYSQL_ROOT_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      },
      {
        name  = "ingestion"
        image = local.ingestion_image_uri
        args  = ["import-dump"]
        env = concat(local.ingestion_shared_environment, local.ingestion_import_environment, [
          { name = "ARGUS_SOURCE_MODE", value = "snapshot" },
          { name = "MYSQL_HOST", value = "127.0.0.1" },
          { name = "MYSQL_PORT", value = "3306" },
          { name = "MYSQL_USER", value = "root" },
          { name = "MYSQL_DATABASE", value = "argus" },
          { name = "ARCHIVE_BUCKET", value = local.ingestion_bucket_name },
          { name = "GLUE_DATABASE", value = aws_glue_catalog_database.ingestion.name },
          { name = "ATHENA_WORKGROUP", value = aws_athena_workgroup.ingestion.name },
          { name = "ATHENA_OUTPUT_LOCATION", value = local.ingestion_athena_output_location },
          { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
        ])
        secrets = [{ name = "MYSQL_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      }
    ]
  }
  workload_ingestion_sync = {
    cpu    = var.ingestion_sync_cpu
    memory = var.ingestion_sync_memoria
    containers = [
      {
        name  = "ingestion"
        image = local.ingestion_image_uri
        args  = ["sync"]
        env = concat(local.ingestion_shared_environment, [
          { name = "ARGUS_SOURCE_MODE", value = "live" },
          { name = "INGESTION_DISK_BUDGET_BYTES", value = tostring(local.ingestion_continuous_disk_budget_bytes) },
          { name = "SYNC_MAX_CATCHUP_WINDOWS", value = tostring(var.sync_max_catchup_windows) },
          { name = "SYNC_FINALIZATION_DELAY_SECONDS", value = tostring(var.sync_finalization_delay_seconds) },
          { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
        ])
        secrets = [
          { name = "LIVE_MYSQL_HOST", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:host::" },
          { name = "LIVE_MYSQL_PORT", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:port::" },
          { name = "LIVE_MYSQL_USER", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:username::" },
          { name = "LIVE_MYSQL_PASSWORD", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:password::" },
          { name = "LIVE_MYSQL_DATABASE", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:database::" },
        ]
      }
    ]
  }
  workload_ingestion_incremental_export = {
    cpu    = var.ingestion_sync_cpu
    memory = var.ingestion_sync_memoria
    containers = [
      {
        name  = "ingestion"
        image = local.ingestion_image_uri
        args  = ["export-incremental"]
        env = concat(
          local.ingestion_shared_environment,
          local.ingestion_incremental_environment,
          [
            { name = "ARGUS_SOURCE_MODE", value = "live" },
            { name = "INGESTION_DISK_BUDGET_BYTES", value = tostring(local.ingestion_continuous_disk_budget_bytes) },
            { name = "LIVE_SYNC_ENABLED", value = tostring(var.live_sync_enabled) },
          ],
        )
        secrets = [
          { name = "LIVE_MYSQL_HOST", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:host::" },
          { name = "LIVE_MYSQL_PORT", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:port::" },
          { name = "LIVE_MYSQL_USER", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:username::" },
          { name = "LIVE_MYSQL_PASSWORD", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:password::" },
          { name = "LIVE_MYSQL_DATABASE", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:database::" },
        ]
      }
    ]
  }
  workload_ingestion_incremental_ingest = {
    cpu    = var.ingestion_sync_cpu
    memory = var.ingestion_sync_memoria
    containers = [
      {
        name  = "ingestion"
        image = local.ingestion_image_uri
        args  = ["ingest-incremental", "--limit", "20"]
        env = concat(
          local.ingestion_shared_environment,
          local.ingestion_incremental_environment,
          [
            { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
            { name = "INCREMENTAL_INGEST_LIMIT", value = "20" },
            { name = "INGESTION_DISK_BUDGET_BYTES", value = tostring(local.ingestion_incremental_disk_budget_bytes) },
          ],
        )
        secrets = []
      }
    ]
  }
  workload_analysis_worker = {
    cpu    = "512"
    memory = "1024"
    containers = [
      {
        name  = "analysis-worker"
        image = local.analysis_worker_image_uri
        args  = []
        env = [
          { name = "NODE_ENV", value = "production" },
          { name = "AWS_REGION", value = var.regiao },
          { name = "OPERATIONAL_TABLE_NAME", value = aws_dynamodb_table.operacional.name },
          { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
          { name = "ANALYSIS_DLQ_URL", value = aws_sqs_queue.analysis_dlq.url },
          { name = "ANALYSIS_MODEL_LOCATION", value = local.analysis_model_location },
          { name = "ANALYSIS_SCOPE_CATALOG_LOCATION", value = local.analysis_scope_catalog_location },
          { name = "ANALYSIS_MODEL_SHA256", value = local.analysis_model_sha256 },
          { name = "LLM_PROVIDER", value = var.analysis_llm_provider },
          { name = "LLM_MODEL_ID", value = var.analysis_llm_model_id },
          { name = "OLLAMA_BASE_URL", value = var.analysis_ollama_base_url },
        ]
        secrets = []
      }
    ]
  }
}
