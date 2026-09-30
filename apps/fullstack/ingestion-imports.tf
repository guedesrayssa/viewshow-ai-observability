// Integração da importação assíncrona. O loop vive no processo da API; este
// arquivo não cria Lambda, Scheduler ou task contínua adicional.
locals {
  ingestion_bucket_arn = "arn:aws:s3:::${local.ingestion_bucket_name}"
  ingestion_table_arn  = aws_dynamodb_table.operacional.arn

  api_import_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ImportRecordsAndControl"
        Effect = "Allow"
        Action = [
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
        ]
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "IMPORTS",
              "CONTROL#IMPORT",
              "IMPORT_IDEMPOTENCY#*",
              "IMPORT_RESTART#*",
              "IMPORT_COMPLETION#*",
            ]
          }
        }
      },
      {
        Sid      = "ReadDatasetActivationRecords"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "CONTROL#DATASET",
              "CANDIDATE#DATASET#*",
              "DATASET#*#INGESTION#PROJECTION_FENCE",
              "DATASET_ACTIVATION_IDEMPOTENCY#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid    = "ReadActiveDatasetProjections"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["DATASET#*#VIEW#*"]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid    = "ActivateDatasetAtomically"
        Effect = "Allow"
        Action = [
          "dynamodb:ConditionCheckItem",
          "dynamodb:PutItem",
        ]
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "CONTROL#DATASET",
              "CANDIDATE#DATASET#*",
              "DATASET#*",
              "DATASET_ACTIVATION_IDEMPOTENCY#*",
              "AUDIT#DATASET_ACTIVATION",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid    = "ImportMultipartStaging"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
        ]
        Resource = ["${local.ingestion_bucket_arn}/staging/imports/*"]
      },

    ]
  })

  import_mutable_leading_keys = [
    "IMPORTS",
    "CONTROL#IMPORT",
    "INGESTION#*",
    "DATASET#*",
    "CANDIDATE#DATASET#*",
  ]
  import_readable_leading_keys = concat(
    local.import_mutable_leading_keys,
    ["CONTROL#DATASET"],
  )
  import_dynamodb_write_actions = [
    "dynamodb:ConditionCheckItem",
    "dynamodb:DeleteItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
  ]
  import_dynamodb_read_actions = [
    "dynamodb:BatchGetItem",
    "dynamodb:GetItem",
    "dynamodb:Query",
  ]
  import_dynamodb_permitted_actions = concat(
    local.import_dynamodb_read_actions,
    local.import_dynamodb_write_actions,
  )

  // A task role é exclusiva do import-dump. Candidate e ACTIVE usam partition
  // keys distintas, permitindo que LeadingKeys bloqueie a ativação também em
  // transações multichave, além das defesas de command/env do runtime.
  ingestion_import_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadPinnedImportUpload"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectAttributes",
          "s3:GetObjectVersion",
          "s3:GetObjectVersionAttributes",
        ]
        Resource = ["${local.ingestion_bucket_arn}/staging/imports/*"]
      },
      // O store faz PUT/multipart, HEAD e COPY. Não há List/Delete no fluxo;
      // a lifecycle existente expira o staging após a janela operacional.
      {
        Sid    = "UseArchiveStagingObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
        ]
        Resource = [
          "${local.ingestion_bucket_arn}/staging/run_id=*/dataset=*/date=*/*.parquet",
        ]
      },
      {
        Sid    = "UseCanonicalArchiveStagingObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
        ]
        Resource = ["${local.ingestion_bucket_arn}/staging/canonical/*"]
      },
      {
        Sid    = "UseIngestionObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
        ]
        Resource = [
          "${local.ingestion_bucket_arn}/dumps/*",
          "${local.ingestion_bucket_arn}/canonical/*",
        ]
      },
      {
        Sid      = "LocateAthenaResultsBucket"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:GetBucketVersioning"]
        Resource = [local.ingestion_bucket_arn]
      },
      {
        Sid      = "ListAthenaResultsPrefix"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [local.ingestion_bucket_arn]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              local.ingestion_athena_results_prefix,
              "${local.ingestion_athena_results_prefix}*",
            ]
          }
        }
      },
      {
        Sid    = "UseAthenaResultObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
        ]
        Resource = [
          "${local.ingestion_bucket_arn}/${local.ingestion_athena_results_prefix}*",
        ]
      },
      {
        Sid    = "ReadCandidateData"
        Effect = "Allow"
        Action = [
          "dynamodb:BatchGetItem",
          "dynamodb:GetItem",
        ]
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = local.import_mutable_leading_keys
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "ReadActiveManifest"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [local.ingestion_table_arn]
        Condition = {
          StringEquals = {
            "dynamodb:LeadingKeys" = "CONTROL#DATASET"
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "QueryCandidateData"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = local.import_mutable_leading_keys
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "QueryPendingOutbox"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = ["${local.ingestion_table_arn}/index/outbox-pending-index"]
      },
      {
        Sid      = "DenyReadsOutsideImportNamespaces"
        Effect   = "Deny"
        Action   = local.import_dynamodb_read_actions
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAnyValue:StringNotLike" = {
            "dynamodb:LeadingKeys" = local.import_readable_leading_keys
          }
        }
      },
      {
        Sid      = "DenyReadsWithoutLeadingKeys"
        Effect   = "Deny"
        Action   = local.import_dynamodb_read_actions
        Resource = [local.ingestion_table_arn]
        Condition = {
          Null = {
            "dynamodb:LeadingKeys" = "true"
          }
        }
      },
      {
        Sid      = "DenyScanOperationalData"
        Effect   = "Deny"
        Action   = ["dynamodb:Scan"]
        Resource = [local.ingestion_table_arn, "${local.ingestion_table_arn}/index/*"]
      },
      // Somente Query no índice esparso do outbox faz parte do fluxo real.
      // NotAction fecha Scan e qualquer ação presente ou futura nos GSIs.
      {
        Sid       = "DenyNonQueryIndexActions"
        Effect    = "Deny"
        NotAction = ["dynamodb:Query"]
        Resource  = ["${local.ingestion_table_arn}/index/*"]
      },
      {
        Sid         = "DenyQueryOutsidePendingOutboxIndex"
        Effect      = "Deny"
        Action      = ["dynamodb:Query"]
        NotResource = [local.ingestion_table_arn, "${local.ingestion_table_arn}/index/outbox-pending-index"]
      },
      {
        Sid      = "WriteCandidateData"
        Effect   = "Allow"
        Action   = local.import_dynamodb_write_actions
        Resource = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = local.import_mutable_leading_keys
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid       = "DenyWritesOutsideCandidateNamespaces"
        Effect    = "Deny"
        NotAction = local.import_dynamodb_read_actions
        Resource  = [local.ingestion_table_arn]
        Condition = {
          "ForAnyValue:StringNotLike" = {
            "dynamodb:LeadingKeys" = local.import_mutable_leading_keys
          }
        }
      },
      {
        Sid       = "DenyWritesWithoutLeadingKeys"
        Effect    = "Deny"
        NotAction = local.import_dynamodb_read_actions
        Resource  = [local.ingestion_table_arn]
        Condition = {
          Null = {
            "dynamodb:LeadingKeys" = "true"
          }
        }
      },
      {
        Sid       = "DenyActiveManifestWrites"
        Effect    = "Deny"
        NotAction = ["dynamodb:GetItem"]
        Resource  = [local.ingestion_table_arn]
        Condition = {
          "ForAnyValue:StringLike" = {
            "dynamodb:LeadingKeys" = ["CONTROL#DATASET"]
          }
        }
      },
      // Uma allow externa dynamodb:* não pode ampliar o conjunto de writes do
      // fluxo real. TransactWriteItems continua autorizado por suas quatro
      // ações constituintes, todas explicitamente preservadas no NotAction.
      {
        Sid       = "DenyUnapprovedCandidateActions"
        Effect    = "Deny"
        NotAction = local.import_dynamodb_permitted_actions
        Resource  = [local.ingestion_table_arn]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = local.import_mutable_leading_keys
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid    = "UseIngestionCatalog"
        Effect = "Allow"
        Action = [
          "glue:CreatePartition",
          "glue:CreateTable",
          "glue:GetPartition",
          "glue:GetTable",
        ]
        Resource = [
          "arn:aws:glue:${data.aws_region.atual.name}:${data.aws_caller_identity.atual.account_id}:catalog",
          "arn:aws:glue:${data.aws_region.atual.name}:${data.aws_caller_identity.atual.account_id}:database/${aws_glue_catalog_database.ingestion.name}",
          "arn:aws:glue:${data.aws_region.atual.name}:${data.aws_caller_identity.atual.account_id}:table/${aws_glue_catalog_database.ingestion.name}/*",
        ]
      },
      {
        Sid    = "UseIngestionAthenaWorkgroup"
        Effect = "Allow"
        Action = [
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:StartQueryExecution",
        ]
        Resource = [
          "arn:aws:athena:${data.aws_region.atual.name}:${data.aws_caller_identity.atual.account_id}:workgroup/${aws_athena_workgroup.ingestion.name}",
        ]
      },
      {
        Sid      = "PublishIngestionAnalysis"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.analysis.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy" "api_import" {
  count = 1

  name   = "${var.deployment_namespace}-api-import"
  role   = local.api_task_role_name
  policy = local.api_import_policy
}

resource "aws_iam_role_policy" "ingestion_import" {
  count = 1

  name   = "${var.deployment_namespace}-ingestion-import"
  role   = local.ingestion_import_task_role_name
  policy = local.ingestion_import_policy
}

resource "aws_cloudwatch_log_metric_filter" "import_reconciliation_failures" {
  name           = "${var.deployment_namespace}-import-reconciliation-failures"
  log_group_name = aws_cloudwatch_log_group.kubernetes_application.name
  pattern        = "{ $.event = \"import_reconciliation_failed\" }"

  metric_transformation {
    name          = "ImportReconciliationFailures"
    namespace     = local.ingestion_metrics_namespace
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_log_metric_filter" "import_active_upload_age" {
  name           = "${var.deployment_namespace}-import-active-upload-age"
  log_group_name = aws_cloudwatch_log_group.kubernetes_application.name
  pattern        = "{ $.event = \"import_active_upload_age\" && $.state = \"UPLOADING\" }"

  metric_transformation {
    name      = "ImportActiveUploadAgeSeconds"
    namespace = local.ingestion_metrics_namespace
    value     = "$.active_upload_age_seconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "import_reconciliation_failures" {
  alarm_name          = "${var.deployment_namespace}-import-reconciliation-failures"
  alarm_description   = "O loop da API falhou ao reconciliar imports ativos."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "ImportReconciliationFailures"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = var.limiar_falhas_importacao
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao
}

resource "aws_cloudwatch_metric_alarm" "import_active_upload_age" {
  alarm_name          = "${var.deployment_namespace}-import-active-upload-age"
  alarm_description   = "Um upload ativo se aproxima da expiração de 24 horas."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "ImportActiveUploadAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = var.limiar_idade_upload_importacao_segundos
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao
}

resource "aws_cloudwatch_metric_alarm" "import_worker_failures" {
  alarm_name          = "${var.deployment_namespace}-import-worker-failures"
  alarm_description   = "O runtime EMF reportou uma execução import-dump com falha."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "Runs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.limiar_falhas_importacao
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "import-dump"
    source_mode = "snapshot"
    status      = "FAILED"
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_mysql_retries" {
  alarm_name          = "${var.deployment_namespace}-ingestion-mysql-retries"
  alarm_description   = "O import-dump precisou repetir páginas do dataset crítico após falha transitória do MySQL."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "MySqlRetries"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "import-dump"
    source_mode = "snapshot"
    dataset     = "signal_bucket"
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_mysql_preflight_failures" {
  alarm_name          = "${var.deployment_namespace}-ingestion-mysql-preflight-failures"
  alarm_description   = "O preflight de índices/EXPLAIN recusou o plano de paginação do snapshot."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "MySqlPreflightFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "import-dump"
    source_mode = "snapshot"
  }
}

resource "aws_cloudwatch_metric_alarm" "ingestion_mysql_page_duration" {
  alarm_name          = "${var.deployment_namespace}-ingestion-mysql-page-duration"
  alarm_description   = "Uma página do dataset crítico excedeu cinco minutos no MySQL de snapshot."
  namespace           = local.ingestion_metrics_namespace
  metric_name         = "MySqlPageDurationMs"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 300000
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.acoes_alarme_ingestao
  ok_actions          = var.acoes_alarme_ingestao

  dimensions = {
    command     = "import-dump"
    source_mode = "snapshot"
    dataset     = "signal_bucket"
  }
}
