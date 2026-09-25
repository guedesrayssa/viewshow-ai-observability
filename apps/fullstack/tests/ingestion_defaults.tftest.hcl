mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_region" {
    defaults = {
      name = "us-east-1"
    }
  }

  mock_data "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/LabRole"
    }
  }
}

mock_provider "archive" {}
mock_provider "random" {
  mock_resource "random_password" {
    defaults = {
      result = "deterministic-test-secret-that-is-never-deployed"
    }
  }
}

variables {
  deployment_namespace = "view-show"
}

override_resource {
  target          = aws_vpc.principal
  override_during = plan
  values = {
    id = "vpc-dedicated"
  }
}

override_resource {
  target          = aws_amplify_app.painel
  override_during = plan
  values = {
    id             = "d111111abcdef8"
    default_domain = "d111111abcdef8.amplifyapp.com"
  }
}

override_resource {
  target          = aws_ecs_cluster.principal
  override_during = plan
  values = {
    arn  = "arn:aws:ecs:us-east-1:123456789012:cluster/view-show-cluster"
    name = "view-show-cluster"
  }
}

override_resource {
  target          = random_password.auth_cookie_secret
  override_during = plan
  values = {
    result = "deterministic-auth-secret-that-is-never-deployed"
  }
}

override_resource {
  target          = random_password.cursor_secret
  override_during = plan
  values = {
    result = "deterministic-cursor-secret-that-is-never-deployed"
  }
}

override_resource {
  target          = aws_ecr_repository.ingestion
  override_during = plan
  values = {
    repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion"
  }
}

override_resource {
  target          = aws_ecr_repository.api
  override_during = plan
  values = {
    repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-api"
  }
}

override_resource {
  target          = aws_cognito_user_pool.principal
  override_during = plan
  values = {
    id = "us-east-1_TestPool"
  }
}

override_resource {
  target          = aws_cognito_user_pool_client.backend
  override_during = plan
  values = {
    id            = "test-client"
    client_secret = "test-client-secret"
  }
}

override_resource {
  target          = aws_security_group.ingestion
  override_during = plan
  values = {
    id = "sg-ingestion"
  }
}

override_resource {
  target          = aws_ecs_task_definition.ingestion_backfill
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-backfill:1"
  }
}

override_resource {
  target          = aws_ecs_task_definition.ingestion_import
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-import:1"
  }
}

override_resource {
  target          = aws_ecs_task_definition.ingestion_incremental_export
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-incremental-export:1"
  }
}

override_resource {
  target          = aws_ecs_task_definition.ingestion_incremental_ingest
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-incremental-ingest:1"
  }
}

override_resource {
  target          = aws_sqs_queue.analysis
  override_during = plan
  values = {
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-analysis"
  }
}

override_resource {
  target          = aws_sqs_queue.incremental_batches
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-incremental-batches.fifo"
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-incremental-batches.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.incremental_batches_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-incremental-batches-dlq.fifo"
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-incremental-batches-dlq.fifo"
  }
}

override_data {
  target          = data.aws_ecr_image.ingestion[0]
  override_during = plan
  values = {
    image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.snapshot_mysql[0]
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.live_mysql[0]
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live"
  }
}

override_resource {
  target          = aws_subnet.privada["a"]
  override_during = plan
  values = {
    id = "subnet-private-a"
  }
}

override_resource {
  target          = aws_subnet.privada["b"]
  override_during = plan
  values = {
    id = "subnet-private-b"
  }
}

override_resource {
  target          = aws_sqs_queue.analysis_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-analysis-dlq"
  }
}

override_resource {
  target          = aws_sqs_queue.ingestion_scheduler_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-scheduler-dlq"
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-scheduler-dlq"
  }
}

run "learner_lab_defaults" {
  command = plan

  assert {
    condition = alltrue([
      aws_ecs_task_definition.api.task_role_arn == "arn:aws:iam::123456789012:role/LabRole",
      length(aws_iam_role_policy.api_argus_live_sync) == 0,
    ])
    error_message = "O Learner Lab deve reutilizar a LabRole sem tentar anexar policies que o AWS Academy bloqueia."
  }

  assert {
    condition     = aws_ecr_repository.ingestion.name == "view-show-ingestion" && aws_ecr_repository.ingestion.force_delete
    error_message = "O repositório da ingestão deve usar o nome padrão e permitir limpeza no Learner Lab."
  }

  assert {
    condition     = aws_ecr_repository.ingestion.image_tag_mutability == "IMMUTABLE" && one(aws_ecr_repository.ingestion.image_scanning_configuration).scan_on_push
    error_message = "Imagens da ingestão devem ser imutáveis e verificadas no push."
  }

  assert {
    condition = alltrue([
      output.ingestion_runbook.deployment_namespace == "view-show",
      length(terraform_data.ingestion_image) == 1,
      terraform_data.ingestion_image[0].input.script_interpreter == "node",
      endswith(replace(terraform_data.ingestion_image[0].input.script_path, "\\", "/"), "/apps/fullstack/scripts/publicar-imagem.mjs"),
      terraform_data.ingestion_image[0].triggers_replace == [local.ingestion_image_hash],
    ])
    error_message = "A imagem de ingestão deve manter o hash como gatilho e executar o script por Node sem interpolar seu caminho no shell."
  }

  assert {
    condition = alltrue([
      var.compatibilidade_s3_learner_lab == null,
      local.ingestion_s3_learner_lab_compat_enabled,
      length(aws_s3_bucket.ingestion) == 0,
      length(terraform_data.ingestion_bucket_learner_lab) == 1,
      terraform_data.ingestion_bucket_learner_lab[0].input.bucket_name == "view-show-ingestion-123456789012-us-east-1",
      terraform_data.ingestion_bucket_learner_lab[0].input.deployment_namespace == "view-show",
      terraform_data.ingestion_bucket_learner_lab[0].input.script_interpreter == "node",
      endswith(replace(terraform_data.ingestion_bucket_learner_lab[0].input.script_path, "\\", "/"), "/apps/fullstack/scripts/ensure-ingestion-bucket.mjs"),
      terraform_data.ingestion_bucket_learner_lab[0].input.frontend_origin == "https://producao.d111111abcdef8.amplifyapp.com",
      contains(terraform_data.ingestion_bucket_learner_lab[0].triggers_replace, "https://producao.d111111abcdef8.amplifyapp.com"),
      length(aws_s3_bucket_cors_configuration.ingestion) == 0,
    ])
    error_message = "O Learner Lab deve evitar recursos S3 nativos e reconciliar CORS para a origem Amplify exata pelo script Node."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_versioning.ingestion.bucket == "view-show-ingestion-123456789012-us-east-1",
      aws_s3_bucket_server_side_encryption_configuration.ingestion.bucket == "view-show-ingestion-123456789012-us-east-1",
      aws_s3_bucket_public_access_block.ingestion.bucket == "view-show-ingestion-123456789012-us-east-1",
      aws_s3_bucket_lifecycle_configuration.ingestion.bucket == "view-show-ingestion-123456789012-us-east-1",
      output.ingestion_runbook.storage.bucket == "view-show-ingestion-123456789012-us-east-1",
    ])
    error_message = "Configurações e outputs devem referenciar o mesmo nome estável do bucket compatível."
  }

  assert {
    condition     = one(aws_s3_bucket_versioning.ingestion.versioning_configuration).status == "Enabled"
    error_message = "O bucket da ingestão deve manter versionamento habilitado."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.ingestion.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "O bucket da ingestão deve usar SSE-S3."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.ingestion.block_public_acls,
      aws_s3_bucket_public_access_block.ingestion.block_public_policy,
      aws_s3_bucket_public_access_block.ingestion.ignore_public_acls,
      aws_s3_bucket_public_access_block.ingestion.restrict_public_buckets,
    ])
    error_message = "Todo acesso público ao bucket da ingestão deve ser bloqueado."
  }

  assert {
    condition = alltrue([
      length(local.ingestion_lifecycle_rules) == 13,
      !contains(keys(local.ingestion_lifecycle_rules), "canonical"),
      toset(keys(local.ingestion_lifecycle_rules)) == toset([
        "raw-argus-incremental",
        "dumps",
        "staging",
        "staging-canonical-expiration",
        "athena-results",
        "raw-argus-incremental-abort-multipart",
        "dumps-abort-multipart",
        "staging-abort-multipart",
        "athena-results-abort-multipart",
        "raw-argus-incremental-expired-delete-markers",
        "dumps-expired-delete-markers",
        "staging-expired-delete-markers",
        "athena-results-expired-delete-markers",
      ]),
      local.ingestion_lifecycle_rule_ids == [
        "raw-argus-incremental",
        "dumps",
        "staging",
        "staging-canonical-expiration",
        "athena-results",
        "raw-argus-incremental-abort-multipart",
        "dumps-abort-multipart",
        "staging-abort-multipart",
        "athena-results-abort-multipart",
        "raw-argus-incremental-expired-delete-markers",
        "dumps-expired-delete-markers",
        "staging-expired-delete-markers",
        "athena-results-expired-delete-markers",
      ],
      local.ingestion_canonical_prefix == "canonical/",
      local.ingestion_incremental_raw_prefix == "raw/argus/incremental/",
      local.ingestion_lifecycle_prefixes == ["raw/argus/incremental/", "dumps/", "staging/", "athena-results/"],
      local.ingestion_lifecycle_prefixes_non_overlapping,
      local.ingestion_lifecycle_prefixes_isolated_from_canonical,
      local.ingestion_lifecycle_rules_isolated_from_canonical,
      local.ingestion_incremental_raw_prefix_isolated,
    ])
    error_message = "O contrato de lifecycle deve conter somente regras com prefixo seguro, isolar raw incremental e nunca alcançar canonical/."
  }

  assert {
    condition = try(
      local.ingestion_lifecycle_rules["raw-argus-incremental"] == {
        status                       = "Enabled"
        prefix                       = "raw/argus/incremental/"
        expiration_days              = 89
        noncurrent_expiration_days   = 1
        abort_multipart_days         = null
        expired_object_delete_marker = false
      },
      local.ingestion_lifecycle_rules["raw-argus-incremental"].expiration_days > 0,
      local.ingestion_lifecycle_rules["raw-argus-incremental"].noncurrent_expiration_days > 0,
      local.ingestion_lifecycle_rules["raw-argus-incremental"].expiration_days + local.ingestion_lifecycle_rules["raw-argus-incremental"].noncurrent_expiration_days <= var.retencao_raw_incremental_ingestao_dias,
      false,
    )
    error_message = "A retenção raw incremental deve manter janelas current/noncurrent positivas dentro do teto efetivo de 90 dias."
  }

  assert {
    condition = try(
      local.ingestion_lifecycle_rules["dumps"] == {
        status                       = "Enabled"
        prefix                       = "dumps/"
        expiration_days              = 30
        noncurrent_expiration_days   = 30
        abort_multipart_days         = null
        expired_object_delete_marker = false
      },
      false,
    )
    error_message = "A regra dumps deve expirar objetos atuais e versões não correntes em 30 dias."
  }

  assert {
    condition = try(
      local.ingestion_lifecycle_rules["staging"] == {
        status                       = "Enabled"
        prefix                       = "staging/"
        expiration_days              = 7
        noncurrent_expiration_days   = 7
        abort_multipart_days         = null
        expired_object_delete_marker = false
      },
      false,
    )
    error_message = "A regra staging deve expirar objetos atuais e versões não correntes em sete dias."
  }

  assert {
    condition = try(
      local.ingestion_lifecycle_rules["staging-canonical-expiration"] == {
        status                       = "Enabled"
        prefix                       = "staging/canonical/"
        expiration_days              = 7
        noncurrent_expiration_days   = 7
        abort_multipart_days         = 1
        expired_object_delete_marker = false
      },
      false,
    )
    error_message = "O staging canônico deve expirar em sete dias e abortar multipart incompleto em um dia sem alcançar canonical/."
  }

  assert {
    condition = try(
      local.ingestion_lifecycle_rules["athena-results"] == {
        status                       = "Enabled"
        prefix                       = "athena-results/"
        expiration_days              = 7
        noncurrent_expiration_days   = 7
        abort_multipart_days         = null
        expired_object_delete_marker = false
      },
      false,
    )
    error_message = "A regra athena-results deve expirar objetos atuais e versões não correntes em sete dias."
  }

  assert {
    condition = alltrue([
      for rule_id, prefix in {
        raw-argus-incremental-abort-multipart = "raw/argus/incremental/"
        dumps-abort-multipart                 = "dumps/"
        staging-abort-multipart               = "staging/"
        athena-results-abort-multipart        = "athena-results/"
        } : try(local.ingestion_lifecycle_rules[rule_id] == {
          status                       = "Enabled"
          prefix                       = prefix
          expiration_days              = null
          noncurrent_expiration_days   = null
          abort_multipart_days         = 1
          expired_object_delete_marker = false
      }, false)
    ])
    error_message = "O abort multipart deve permanecer em um dia, mas limitado a cada prefixo mutável."
  }

  assert {
    condition = alltrue([
      for rule_id, prefix in {
        raw-argus-incremental-expired-delete-markers = "raw/argus/incremental/"
        dumps-expired-delete-markers                 = "dumps/"
        staging-expired-delete-markers               = "staging/"
        athena-results-expired-delete-markers        = "athena-results/"
        } : try(local.ingestion_lifecycle_rules[rule_id] == {
          status                       = "Enabled"
          prefix                       = prefix
          expiration_days              = null
          noncurrent_expiration_days   = null
          abort_multipart_days         = null
          expired_object_delete_marker = true
      }, false)
    ])
    error_message = "A limpeza de delete markers deve ser limitada a cada prefixo mutável."
  }

  assert {
    condition     = aws_glue_catalog_database.ingestion.name == "view_show_ingestion"
    error_message = "O catálogo da ingestão deve criar o database esperado."
  }

  assert {
    condition = alltrue([
      aws_athena_workgroup.ingestion.configuration[0].enforce_workgroup_configuration,
      aws_athena_workgroup.ingestion.configuration[0].publish_cloudwatch_metrics_enabled,
      aws_athena_workgroup.ingestion.configuration[0].bytes_scanned_cutoff_per_query == 1073741824,
      aws_athena_workgroup.ingestion.configuration[0].result_configuration[0].output_location == "s3://view-show-ingestion-123456789012-us-east-1/athena-results/",
      aws_athena_workgroup.ingestion.configuration[0].result_configuration[0].encryption_configuration[0].encryption_option == "SSE_S3",
    ])
    error_message = "O workgroup Athena deve impor resultado SSE-S3, métricas e cutoff de 1 GiB."
  }

  assert {
    condition = alltrue([
      aws_sqs_queue.analysis.message_retention_seconds == 1209600,
      aws_sqs_queue.analysis.visibility_timeout_seconds == 300,
      aws_sqs_queue.analysis.receive_wait_time_seconds == 20,
      aws_sqs_queue.analysis_dlq.message_retention_seconds == 1209600,
      aws_sqs_queue.ingestion_scheduler_dlq.message_retention_seconds == 1209600,
      !aws_sqs_queue.analysis.fifo_queue,
      !aws_sqs_queue.analysis_dlq.fifo_queue,
      !aws_sqs_queue.ingestion_scheduler_dlq.fifo_queue,
    ])
    error_message = "As filas Standard devem reter 14 dias e a fila principal deve usar visibility/long polling seguros."
  }

  assert {
    condition = alltrue([
      aws_sqs_queue.incremental_batches.fifo_queue,
      aws_sqs_queue.incremental_batches_dlq.fifo_queue,
      endswith(aws_sqs_queue.incremental_batches.name, ".fifo"),
      aws_sqs_queue.incremental_batches.visibility_timeout_seconds >= 300,
      aws_scheduler_schedule.ingestion_incremental_export.state == "DISABLED",
      aws_scheduler_schedule.ingestion_incremental_ingest.state == "DISABLED",
    ])
    error_message = "A ingestão incremental deve nascer desligada e usar FIFO/DLQ FIFO."
  }

  assert {
    condition = alltrue([
      aws_sqs_queue.incremental_batches.name == "view-show-ingestion-incremental-batches.fifo",
      aws_sqs_queue.incremental_batches_dlq.name == "view-show-ingestion-incremental-batches-dlq.fifo",
      aws_sqs_queue.incremental_batches.message_retention_seconds == 1209600,
      aws_sqs_queue.incremental_batches_dlq.message_retention_seconds == 1209600,
      aws_sqs_queue.incremental_batches.receive_wait_time_seconds == 20,
      aws_sqs_queue.incremental_batches_dlq.receive_wait_time_seconds == 20,
      aws_sqs_queue.incremental_batches_dlq.visibility_timeout_seconds >= 300,
      aws_sqs_queue.incremental_batches.sqs_managed_sse_enabled,
      aws_sqs_queue.incremental_batches_dlq.sqs_managed_sse_enabled,
      jsondecode(aws_sqs_queue.incremental_batches.redrive_policy).deadLetterTargetArn == aws_sqs_queue.incremental_batches_dlq.arn,
      jsondecode(aws_sqs_queue.incremental_batches.redrive_policy).maxReceiveCount == 5,
    ])
    error_message = "A fila incremental e sua DLQ devem reter 14 dias, usar long polling, SSE, visibility segura e redrive 5."
  }

  assert {
    condition = (
      jsondecode(aws_sqs_queue.analysis.redrive_policy).deadLetterTargetArn == aws_sqs_queue.analysis_dlq.arn &&
      jsondecode(aws_sqs_queue.analysis.redrive_policy).maxReceiveCount == 5
    )
    error_message = "A fila de análise deve redirecionar à DLQ após cinco recebimentos."
  }

  assert {
    condition = alltrue([
      aws_secretsmanager_secret.snapshot_mysql[0].name == "view-show-ingestion/snapshot-mysql",
      aws_secretsmanager_secret.snapshot_mysql[0].recovery_window_in_days == 0,
      aws_secretsmanager_secret.live_mysql[0].name == "view-show-ingestion/live-mysql",
      aws_secretsmanager_secret.live_mysql[0].recovery_window_in_days == 0,
    ])
    error_message = "O Learner Lab deve criar somente os contêineres de segredo, com remoção imediata no destroy."
  }

  assert {
    condition = alltrue([
      one([for index in aws_dynamodb_table.operacional.global_secondary_index : index if index.name == "trace-index"]).projection_type == "ALL",
      one([for index in aws_dynamodb_table.operacional.global_secondary_index : index if index.name == "outbox-pending-index"]).hash_key == "outboxStatePk",
      one([for index in aws_dynamodb_table.operacional.global_secondary_index : index if index.name == "outbox-pending-index"]).range_key == "outboxStateSk",
      one([for index in aws_dynamodb_table.operacional.global_secondary_index : index if index.name == "outbox-pending-index"]).projection_type == "ALL",
      aws_dynamodb_table.operacional.billing_mode == "PAY_PER_REQUEST",
      one(aws_dynamodb_table.operacional.ttl).enabled,
    ])
    error_message = "A tabela operacional deve preservar trace-index/TTL/on-demand e expor o GSI esparso da outbox com projeção ALL."
  }

  assert {
    condition = alltrue([
      local.ingestion_build_source_patterns == [
        "adapters/**",
        "application/**",
        "bootstrap/**",
        "contracts/**",
        "domain/**",
        "ports/**",
        "scripts/**",
      ],
      local.ingestion_build_excluded_path_patterns == [
        "(^|/)\\.git(ignore)?(/|$)",
        "(^|/)__pycache__(/|$)",
        "\\.py[cod](/|$)",
        "(^|/)\\.(mypy_cache|pytest_cache|ruff_cache|venv)[^/]*(/|$)",
        "(^|/)\\.env(\\.[^/]*)?(/|$)",
        "(^|/)\\.coverage[^/]*(/|$)",
        "\\.log(/|$)",
        "(^|/)(htmlcov|build|dist)(/|$)",
        "\\.egg-info(/|$)",
        "(^|/)(\\.spool|spool)(/|$)",
        "(^|/)(\\.tmp|tmp|\\.temp|temp)(/|$)",
        "\\.(sqlite3?|db)(-[^/]*)?(/|$)",
        "\\.(parquet|spool|tmp|temp)(/|$)",
        "(^|/)tests(/|$)",
        "(^|/)requirements-dev\\.(in|txt)(/|$)",
      ],
    ])
    error_message = "O hash deve restringir as raízes de runtime e filtrar explicitamente os artefatos ignorados pelo build."
  }

  assert {
    condition = alltrue([
      for artifact in [
        "adapters/.git/config",
        "adapters/.gitignore",
        "adapters/__pycache__/client.cpython-312.pyc",
        "adapters/cache.pyc/data",
        "application/.pytest_cache/v/cache.json",
        "bootstrap/.env/data",
        "bootstrap/.env.local/data",
        "bootstrap/.coverage.worker",
        "bootstrap/.coverage.worker/data",
        "contracts/argus/v2/schema.log",
        "contracts/argus/v2/schema.log/data",
        "domain/state.sqlite-wal",
        "domain/state.sqlite-backup",
        "domain/state.sqlite-wal/page",
        "ports/cache.db-shm",
        "ports/cache.db-backup",
        "ports/cache.db-backup/page",
        "adapters/.spool/window/part.parquet",
        "adapters/output.parquet/part",
        "scripts/tests/fixture.json",
        "scripts/requirements-dev.txt",
        "scripts/tmp/result.json",
        "scripts/temp/result.json",
        "scripts/.tmp/result.json",
        "scripts/.temp/result.json",
        "scripts/result.spool",
        "scripts/cache.spool/result.json",
        "scripts/result.temp",
        "scripts/cache.tmp/result.json",
        "scripts/cache.temp/result.json",
        ] : anytrue([
          for pattern in local.ingestion_build_excluded_path_patterns :
          can(regex(pattern, artifact))
      ])
    ])
    error_message = "A política do hash deve rejeitar exemplos sintéticos de cache, cobertura, SQLite, spool e temporários."
  }

  assert {
    condition = alltrue([
      contains(local.ingestion_build_files, ".dockerignore"),
      contains(local.ingestion_build_files, "Dockerfile"),
      contains(local.ingestion_build_files, "requirements.txt"),
      contains(local.ingestion_build_files, "application/sync.py"),
      contains(local.ingestion_build_files, "contracts/argus/v2/descriptors/live_event.json"),
      contains(local.ingestion_build_files, "contracts/argus/v2/db_schema.sql"),
      alltrue([
        for file in local.ingestion_build_files : (
          contains([".dockerignore", "Dockerfile", "requirements.txt"], file) ||
          can(regex("^(adapters|application|bootstrap|domain|ports|scripts)/.+\\.py$", file)) ||
          can(regex("^contracts/.+\\.(py|json|sql|md)$", file))
        )
      ]),
      length([
        for file in local.ingestion_build_files : file
        if strcontains(file, "__pycache__") ||
        endswith(file, ".pyc") ||
        strcontains(file, ".coverage") ||
        can(regex("(?i)(sqlite|spool|\\.(db|parquet|tmp|temp)$)", file))
      ]) == 0,
    ])
    error_message = "Caches, cobertura, SQLite, spool e temporários não podem alterar o hash/tag da imagem."
  }
}

run "learner_lab_rejects_athena_output_without_trailing_slash" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "athena-results"
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "learner_lab_rejects_empty_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = ""
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "learner_lab_rejects_canonical_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "canonical/"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "learner_lab_rejects_overlapping_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "staging/athena/"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "learner_lab_rejects_athena_path_traversal" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "athena/../canonical/"
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "learner_lab_rejects_s3_uri_as_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "s3://other-bucket/results/"
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "learner_lab_rejects_absolute_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "/athena-results/"
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "learner_lab_runtime_starts_disabled_and_isolated" {
  command = plan

  assert {
    condition = alltrue([
      aws_ecs_task_definition.api.execution_role_arn == "arn:aws:iam::123456789012:role/LabRole",
      aws_ecs_task_definition.api.task_role_arn == "arn:aws:iam::123456789012:role/LabRole",
      length(aws_iam_role_policy.api_import) == 0,
      length(aws_iam_role_policy.ingestion_import) == 0,
      aws_ecs_task_definition.ingestion_import.task_role_arn == "arn:aws:iam::123456789012:role/LabRole",
      { for item in one(jsondecode(aws_ecs_task_definition.api.container_definitions)).environment : item.name => item.value if startswith(item.name, "IMPORT_") } == {
        IMPORT_BUCKET                        = "view-show-ingestion-123456789012-us-east-1"
        IMPORT_CANONICAL_FIRST_ENABLED       = "false"
        IMPORT_CURSOR_SECRET                 = random_password.cursor_secret.result
        IMPORT_EXPECTED_BUCKET_OWNER         = "123456789012"
        IMPORT_INGESTION_CLUSTER_ARN         = "arn:aws:ecs:us-east-1:123456789012:cluster/view-show-cluster"
        IMPORT_INGESTION_CONTAINER_NAME      = "ingestion"
        IMPORT_INGESTION_SECURITY_GROUP_ID   = aws_security_group.ingestion.id
        IMPORT_INGESTION_SUBNET_IDS          = "subnet-private-a,subnet-private-b"
        IMPORT_INGESTION_TASK_DEFINITION_ARN = "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-import"
      },
    ])
    error_message = "A API do Learner Lab deve manter LabRole e receber exatamente o contrato IMPORT_* do reconciliador, sem criar policies IAM."
  }

  assert {
    condition = alltrue([
      aws_ecs_task_definition.ingestion_backfill.cpu == "2048",
      aws_ecs_task_definition.ingestion_backfill.memory == "8192",
      aws_ecs_task_definition.ingestion_backfill.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_import.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_sync.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_incremental_export.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_incremental_ingest.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_sync.cpu == "1024",
      aws_ecs_task_definition.ingestion_sync.memory == "2048",
      aws_ecs_task_definition.ingestion_incremental_export.cpu == "1024",
      aws_ecs_task_definition.ingestion_incremental_export.memory == "2048",
      aws_ecs_task_definition.ingestion_incremental_ingest.cpu == "1024",
      aws_ecs_task_definition.ingestion_incremental_ingest.memory == "2048",
      var.sync_finalization_delay_seconds == 900,
      aws_ecs_task_definition.ingestion_backfill.network_mode == "awsvpc",
      aws_ecs_task_definition.ingestion_sync.network_mode == "awsvpc",
      aws_ecs_task_definition.ingestion_backfill.runtime_platform[0].operating_system_family == "LINUX",
      aws_ecs_task_definition.ingestion_backfill.runtime_platform[0].cpu_architecture == "X86_64",
    ])
    error_message = "As tasks Fargate devem usar o tamanho, rede e plataforma do contrato de ingestão."
  }

  assert {
    condition = alltrue([
      length(aws_iam_role_policy.ingestion_incremental_export) == 0,
      length(aws_iam_role_policy.ingestion_incremental_ingest) == 0,
      length(aws_iam_role_policy.ingestion_incremental_scheduler) == 0,
    ])
    error_message = "O Learner Lab deve reutilizar a LabRole sem tentar anexar policies inline à role gerenciada pelo laboratório."
  }

  assert {
    condition = alltrue([
      contains(local.ingestion_import_environment, { name = "ARCHIVE_BUCKET_OWNER", value = "123456789012" }),
      contains(local.ingestion_import_environment, { name = "INGESTION_DISK_BUDGET_BYTES", value = "68719476736" }),
      contains(local.ingestion_import_environment, { name = "IMPORT_HOT_MATERIALIZATION_ENABLED", value = "false" }),
      contains(local.ingestion_import_environment, { name = "ACTIVATE_CANDIDATE", value = "false" }),
      contains(local.ingestion_import_environment, { name = "PAGE_SIZE", value = "500" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_CONNECT_TIMEOUT_SECONDS", value = "10" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_READ_TIMEOUT_SECONDS", value = "300" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_WRITE_TIMEOUT_SECONDS", value = "300" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_DDL_TIMEOUT_SECONDS", value = "1800" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_QUERY_MAX_ATTEMPTS", value = "4" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_QUERY_RETRY_BASE_MS", value = "250" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_QUERY_RETRY_MAX_MS", value = "4000" }),
      contains(local.ingestion_import_environment, { name = "MYSQL_SNAPSHOT_PREPARE_ENABLED", value = "false" }),
      var.ingestion_snapshot_page_size == 500,
      var.ingestion_snapshot_prepare_enabled == false,
      var.import_canonical_first_enabled == false,
      var.import_hot_materialization_enabled == false,
      var.import_canonical_first_production_approved == false,
      local.ingestion_continuous_disk_budget_bytes == 8589934592,
      local.ingestion_incremental_disk_budget_bytes == 17179869184,
    ])
    error_message = "O rollout deve iniciar legacy/hot-off, reservar 64 GiB somente ao snapshot e manter os limites dos workers contínuos."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning.metric_name == "LocalDiskPeakBytes",
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning.threshold == 54975581388.8,
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning.dimensions["command"] == "import-dump",
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning.dimensions["source_mode"] == "snapshot",
      length(aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning.dimensions) == 2,
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical.metric_name == "LocalDiskPeakBytes",
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical.threshold == 61847529062.4,
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical.dimensions["command"] == "import-dump",
      aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical.dimensions["source_mode"] == "snapshot",
      length(aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical.dimensions) == 2,
      aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures.metric_name == "ArchiveFailures",
      aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures.threshold == 1,
      aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures.dimensions["command"] == "import-dump",
      aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures.dimensions["component"] == "PARQUET",
    ])
    error_message = "O rollout canônico deve alarmar spool em 80/90% e qualquer falha de archive Parquet."
  }

  assert {
    condition = alltrue([
      local.ingestion_snapshot_mysql_command == [
        "mysqld",
        "--character-set-server=utf8mb4",
        "--collation-server=utf8mb4_bin",
        "--innodb-buffer-pool-size=3221225472",
        "--innodb-redo-log-capacity=1073741824",
        "--innodb-flush-log-at-trx-commit=2",
        "--skip-log-bin",
        "--sync-binlog=0",
        "--max-allowed-packet=1073741824",
        "--net-read-timeout=600",
        "--net-write-timeout=600",
        "--wait-timeout=600",
        "--performance-schema=OFF",
      ],
      !contains(local.ingestion_snapshot_mysql_command, "--innodb-doublewrite=0"),
      !contains(local.ingestion_snapshot_mysql_command, "--innodb-redo-log-enabled=OFF"),
      var.imagem_mysql_snapshot == "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad",
      aws_ecs_task_definition.ingestion_import.memory == "8192",
      aws_ecs_task_definition.ingestion_import.ephemeral_storage[0].size_in_gib == 200,
    ])
    error_message = "O sidecar MySQL descartável deve usar tuning seguro, imagem por digest, task de 8 GiB e storage de 200 GiB."
  }

  assert {
    condition = alltrue([
      strcontains(aws_cloudwatch_log_metric_filter.import_reconciliation_failures.pattern, "import_reconciliation_failed"),
      one(aws_cloudwatch_log_metric_filter.import_reconciliation_failures.metric_transformation).name == "ImportReconciliationFailures",
      strcontains(aws_cloudwatch_log_metric_filter.import_active_upload_age.pattern, "import_active_upload_age"),
      strcontains(aws_cloudwatch_log_metric_filter.import_active_upload_age.pattern, "UPLOADING"),
      one(aws_cloudwatch_log_metric_filter.import_active_upload_age.metric_transformation).value == "$.active_upload_age_seconds",
      aws_cloudwatch_metric_alarm.import_reconciliation_failures.treat_missing_data == "notBreaching",
      aws_cloudwatch_metric_alarm.import_active_upload_age.threshold == 82800,
      aws_cloudwatch_metric_alarm.import_worker_failures.dimensions.command == "import-dump",
      aws_cloudwatch_metric_alarm.import_worker_failures.dimensions.source_mode == "snapshot",
      aws_cloudwatch_metric_alarm.import_worker_failures.dimensions.status == "FAILED",
      aws_cloudwatch_metric_alarm.import_worker_failures.metric_name == "Runs",
    ])
    error_message = "Os três alarmes de import devem consumir somente os eventos e dimensões EMF congelados."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.ingestion_mysql_retries.metric_name == "MySqlRetries",
      aws_cloudwatch_metric_alarm.ingestion_mysql_retries.dimensions.command == "import-dump",
      aws_cloudwatch_metric_alarm.ingestion_mysql_retries.dimensions.source_mode == "snapshot",
      aws_cloudwatch_metric_alarm.ingestion_mysql_retries.treat_missing_data == "notBreaching",
      aws_cloudwatch_metric_alarm.ingestion_mysql_preflight_failures.metric_name == "MySqlPreflightFailures",
      aws_cloudwatch_metric_alarm.ingestion_mysql_preflight_failures.dimensions.command == "import-dump",
      aws_cloudwatch_metric_alarm.ingestion_mysql_preflight_failures.dimensions.source_mode == "snapshot",
      aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration.metric_name == "MySqlPageDurationMs",
      aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration.dimensions.command == "import-dump",
      aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration.dimensions.source_mode == "snapshot",
      aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration.dimensions.dataset == "signal_bucket",
    ])
    error_message = "Os alarmes de resiliência MySQL devem consumir as métricas e dimensões públicas emitidas pelo worker."
  }

  assert {
    condition = alltrue([
      output.ingestion_runbook.imports.cors_origin == "https://producao.d111111abcdef8.amplifyapp.com",
      output.ingestion_runbook.imports.expected_bucket_owner == "123456789012",
      output.ingestion_runbook.imports.container_name == "ingestion",
      output.ingestion_runbook.imports.ephemeral_storage_gib == 200,
      output.ingestion_runbook.imports.disk_budget_bytes == 68719476736,
      output.ingestion_runbook.imports.iam_isolation_enforced == false,
      !contains(keys(output.ingestion_runbook.imports), "cursor_secret"),
      !contains(keys(output.ingestion_runbook.imports), "import_cursor_secret"),
    ])
    error_message = "O runbook de import deve expor somente metadados operacionais, nunca o segredo de cursor."
  }

  assert {
    condition = alltrue([
      aws_security_group.ingestion.vpc_id == "vpc-dedicated",
      toset(aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].network_configuration[0].subnets) == toset(["subnet-private-a", "subnet-private-b"]),
      !aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].network_configuration[0].assign_public_ip,
      length(aws_security_group.ingestion.ingress) == 0,
      aws_scheduler_schedule_group.ingestion.name == "view-show-ingestion",
      aws_scheduler_schedule.ingestion_sync.name == "view-show-ingestion-sync",
      aws_scheduler_schedule.ingestion_sync.schedule_expression == "rate(15 minutes)",
      aws_scheduler_schedule.ingestion_sync.state == "DISABLED",
      aws_scheduler_schedule.ingestion_sync.flexible_time_window[0].mode == "OFF",
      strcontains(file("${path.module}/ecs.tf"), "{ name = \"INGESTION_SCHEDULER_GROUP_NAME\", value = aws_scheduler_schedule_group.ingestion.name },"),
      strcontains(file("${path.module}/ecs.tf"), "{ name = \"INGESTION_SCHEDULER_NAME\", value = aws_scheduler_schedule.ingestion_sync.name },"),
      !strcontains(split("resource \"aws_ecs_task_definition\" \"ingestion_incremental_export\"", split("resource \"aws_ecs_task_definition\" \"ingestion_sync\"", file("${path.module}/ingestion-ecs.tf"))[1])[0], "LIVE_SYNC_ENABLED"),
      aws_scheduler_schedule.ingestion_incremental_export.schedule_expression == "rate(15 minutes)",
      aws_scheduler_schedule.ingestion_incremental_ingest.schedule_expression == "rate(5 minutes)",
      aws_scheduler_schedule.ingestion_incremental_export.schedule_expression_timezone == "UTC",
      aws_scheduler_schedule.ingestion_incremental_ingest.schedule_expression_timezone == "UTC",
      aws_scheduler_schedule.ingestion_incremental_export.state == "DISABLED",
      aws_scheduler_schedule.ingestion_incremental_ingest.state == "DISABLED",
      aws_scheduler_schedule.ingestion_incremental_export.target[0].dead_letter_config[0].arn == aws_sqs_queue.ingestion_scheduler_dlq.arn,
      aws_scheduler_schedule.ingestion_incremental_ingest.target[0].dead_letter_config[0].arn == aws_sqs_queue.ingestion_scheduler_dlq.arn,
      toset(aws_scheduler_schedule.ingestion_incremental_export.target[0].ecs_parameters[0].network_configuration[0].subnets) == toset(["subnet-private-a", "subnet-private-b"]),
      toset(aws_scheduler_schedule.ingestion_incremental_ingest.target[0].ecs_parameters[0].network_configuration[0].subnets) == toset(["subnet-private-a", "subnet-private-b"]),
      length(aws_cloudwatch_metric_alarm.ingestion_sync_absence) == 0,
    ])
    error_message = "A execução do Learner Lab deve nascer na VPC dedicada, sem IP público, ingress e sync/sua ausência ativos."
  }

  assert {
    condition = alltrue([
      one([for setting in aws_ecs_cluster.principal.setting : setting if setting.name == "containerInsights"]).value == "enabled",
      aws_cloudwatch_log_group.ingestion_backfill.name == "/ecs/view-show-ingestion-backfill",
      aws_cloudwatch_log_group.ingestion_sync.name == "/ecs/view-show-ingestion-sync",
      aws_cloudwatch_log_group.ingestion_incremental_export.name == "/ecs/view-show-ingestion-incremental-export",
      aws_cloudwatch_log_group.ingestion_incremental_ingest.name == "/ecs/view-show-ingestion-incremental-ingest",
      aws_cloudwatch_log_group.ingestion_backfill.retention_in_days == 7,
      aws_cloudwatch_log_group.ingestion_sync.retention_in_days == 7,
      aws_cloudwatch_log_group.ingestion_incremental_export.retention_in_days == 7,
      aws_cloudwatch_log_group.ingestion_incremental_ingest.retention_in_days == 7,
      aws_cloudwatch_dashboard.ingestion.dashboard_name == "view-show-ingestion",
    ])
    error_message = "Container Insights, logs separados e dashboard são obrigatórios para o runbook de ingestão."
  }

  assert {
    condition = alltrue([
      length(aws_cloudwatch_metric_alarm.ingestion_resource_utilization) == 6,
      alltrue([for alarm in aws_cloudwatch_metric_alarm.ingestion_resource_utilization : alarm.threshold == 70]),
      alltrue([for alarm in aws_cloudwatch_metric_alarm.ingestion_resource_utilization : alarm.comparison_operator == "GreaterThanOrEqualToThreshold"]),
      alltrue([for alarm in aws_cloudwatch_metric_alarm.ingestion_resource_utilization : alarm.treat_missing_data == "notBreaching"]),
    ])
    error_message = "Os seis alarmes de recursos devem usar limiar inclusivo de 70% e missing notBreaching."
  }

  assert {
    condition = alltrue([
      one([for query in aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-cpu"].metric_query : query if query.id == "used"]).metric[0].metric_name == "CpuUtilized",
      one([for query in aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-cpu"].metric_query : query if query.id == "reserved"]).metric[0].metric_name == "CpuReserved",
      one([for query in aws_cloudwatch_metric_alarm.ingestion_resource_utilization["sync-storage"].metric_query : query if query.id == "used"]).metric[0].metric_name == "EphemeralStorageUtilized",
      one([for query in aws_cloudwatch_metric_alarm.ingestion_resource_utilization["sync-storage"].metric_query : query if query.id == "reserved"]).metric[0].metric_name == "EphemeralStorageReserved",
    ])
    error_message = "CPU, memória e armazenamento efêmero devem usar os pares Utilized/Reserved de Container Insights."
  }

  assert {
    condition = alltrue([
      one([for query in aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-cpu"].metric_query : query if query.id == "used"]).metric[0].dimensions.ClusterName == "view-show-cluster",
      one([for query in aws_cloudwatch_metric_alarm.ingestion_resource_utilization["backfill-cpu"].metric_query : query if query.id == "used"]).metric[0].dimensions.TaskDefinitionFamily == "view-show-ingestion-backfill",
    ])
    error_message = "As métricas de Container Insights devem usar dimensões exatas de cluster e família da task."
  }

  assert {
    condition = alltrue([
      length(aws_cloudwatch_metric_alarm.ingestion_partial_runs) == 2,
      length(aws_cloudwatch_metric_alarm.ingestion_schema_drift) == 2,
      length(aws_cloudwatch_metric_alarm.ingestion_stage_failures) == 2,
      aws_cloudwatch_metric_alarm.ingestion_stage_failures["projecting"].dimensions.stage == "PROJECTING",
      aws_cloudwatch_metric_alarm.ingestion_stage_failures["archiving"].dimensions.stage == "ARCHIVING",
      aws_cloudwatch_metric_alarm.ingestion_athena_failures.metric_name == "AthenaFailures",
      aws_cloudwatch_metric_alarm.ingestion_athena_processed_bytes.namespace == "AWS/Athena",
      aws_cloudwatch_metric_alarm.ingestion_athena_processed_bytes.metric_name == "ProcessedBytes",
      aws_cloudwatch_metric_alarm.ingestion_athena_processed_bytes.dimensions.WorkGroup == "view-show-ingestion",
      aws_cloudwatch_metric_alarm.ingestion_outbox_oldest_age.metric_name == "OutboxOldestAgeSeconds",
      aws_cloudwatch_metric_alarm.analysis_queue_oldest_age.metric_name == "ApproximateAgeOfOldestMessage",
      aws_cloudwatch_metric_alarm.analysis_queue_oldest_age.dimensions.QueueName == "view-show-ingestion-analysis",
      alltrue([for alarm in concat(
        values(aws_cloudwatch_metric_alarm.ingestion_partial_runs),
        values(aws_cloudwatch_metric_alarm.ingestion_schema_drift),
        values(aws_cloudwatch_metric_alarm.ingestion_stage_failures),
        [
          aws_cloudwatch_metric_alarm.ingestion_athena_failures,
          aws_cloudwatch_metric_alarm.ingestion_athena_processed_bytes,
          aws_cloudwatch_metric_alarm.ingestion_outbox_oldest_age,
          aws_cloudwatch_metric_alarm.analysis_queue_oldest_age,
        ],
      ) : alarm.treat_missing_data == "notBreaching"]),
    ])
    error_message = "Os sinais com evidência real devem ter alarmes honestos e ausência de dados não pode significar falha."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.incremental_queue_backlog.metric_name == "ApproximateNumberOfMessagesVisible",
      aws_cloudwatch_metric_alarm.incremental_queue_backlog.dimensions.QueueName == "view-show-ingestion-incremental-batches.fifo",
      aws_cloudwatch_metric_alarm.incremental_queue_oldest_age.metric_name == "ApproximateAgeOfOldestMessage",
      aws_cloudwatch_metric_alarm.incremental_queue_oldest_age.dimensions.QueueName == "view-show-ingestion-incremental-batches.fifo",
      aws_cloudwatch_metric_alarm.incremental_dlq_depth.metric_name == "ApproximateNumberOfMessagesVisible",
      aws_cloudwatch_metric_alarm.incremental_dlq_depth.dimensions.QueueName == "view-show-ingestion-incremental-batches-dlq.fifo",
      aws_cloudwatch_metric_alarm.incremental_batch_quarantined.metric_name == "IncrementalBatchQuarantined",
      aws_cloudwatch_metric_alarm.incremental_batch_quarantined.dimensions.command == "ingest-incremental",
      aws_cloudwatch_metric_alarm.incremental_batch_quarantined.dimensions.status == "QUARANTINED",
      aws_cloudwatch_metric_alarm.incremental_batch_quarantined.dimensions.dataset == "signal_bucket",
      aws_cloudwatch_metric_alarm.incremental_watermark_lag.metric_name == "IncrementalBatchLagSeconds",
      aws_cloudwatch_metric_alarm.incremental_watermark_lag.dimensions.command == "export-incremental",
      aws_cloudwatch_metric_alarm.incremental_watermark_lag.dimensions.status == "SUCCEEDED",
      aws_cloudwatch_metric_alarm.incremental_watermark_lag.dimensions.dataset == "signal_bucket",
      alltrue([for alarm in [
        aws_cloudwatch_metric_alarm.incremental_queue_backlog,
        aws_cloudwatch_metric_alarm.incremental_queue_oldest_age,
        aws_cloudwatch_metric_alarm.incremental_dlq_depth,
        aws_cloudwatch_metric_alarm.incremental_batch_quarantined,
        aws_cloudwatch_metric_alarm.incremental_watermark_lag,
      ] : alarm.treat_missing_data == "notBreaching"]),
    ])
    error_message = "Backlog, idade, DLQ, quarentena e lag incrementais devem ter alarmes limitados a dimensões de baixa cardinalidade."
  }

  assert {
    condition = alltrue([
      var.limiar_duracao_projecao_ingestao_ms == 300000,
      var.limiar_falhas_rebuild_projecoes_ingestao == 1,
      aws_cloudwatch_metric_alarm.ingestion_projecting_duration.metric_name == "StageDurationMs",
      aws_cloudwatch_metric_alarm.ingestion_projecting_duration.statistic == "Maximum",
      aws_cloudwatch_metric_alarm.ingestion_projecting_duration.threshold == var.limiar_duracao_projecao_ingestao_ms,
      aws_cloudwatch_metric_alarm.ingestion_projecting_duration.dimensions.command == "backfill",
      aws_cloudwatch_metric_alarm.ingestion_projecting_duration.dimensions.stage == "PROJECTING",
      aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures.metric_name == "Runs",
      aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures.statistic == "Sum",
      aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures.threshold == var.limiar_falhas_rebuild_projecoes_ingestao,
      aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures.dimensions.command == "rebuild-projections",
      aws_cloudwatch_metric_alarm.ingestion_rebuild_projections_failures.dimensions.status == "FAILED",
    ])
    error_message = "A projeção e o rebuild precisam de alarmes de duração e falha com limiares configuráveis."
  }

  assert {
    condition = alltrue([
      length([
        for series in try(one([
          for widget in jsondecode(aws_cloudwatch_dashboard.ingestion.dashboard_body).widgets : widget.properties.metrics
          if try(widget.properties.title == "Integridade do pipeline", false)
        ]), []) : series if try(series[1] == "OutboxPendingCount" || series[1] == "OutboxOldestAgeSeconds", false)
      ]) == 2,
      alltrue([
        for series in try(one([
          for widget in jsondecode(aws_cloudwatch_dashboard.ingestion.dashboard_body).widgets : widget.properties.metrics
          if try(widget.properties.title == "Integridade do pipeline", false)
        ]), []) : try(series[length(series) - 1].stat == "Maximum", false)
        if try(series[1] == "OutboxPendingCount" || series[1] == "OutboxOldestAgeSeconds", false)
      ]),
    ])
    error_message = "As séries de backlog da outbox no dashboard precisam usar Maximum, nunca Sum."
  }
}

run "learner_lab_rejects_unaligned_sync_finalization_delay" {
  command = plan

  variables {
    sync_finalization_delay_seconds = 901
  }

  expect_failures = [var.sync_finalization_delay_seconds]
}
