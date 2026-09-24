// Task definitions Fargate de backfill e sync com imagem Python fixada por
// digest. O backfill inclui um MySQL efêmero; a tag determinística serve apenas
// para descoberta no ECR, nunca como a referência executada pela task.

locals {
  ingestion_dir                           = "${path.module}/../backend/ingestion-data"
  ingestion_snapshot_disk_budget_bytes    = 64 * 1024 * 1024 * 1024
  ingestion_continuous_disk_budget_bytes  = 8 * 1024 * 1024 * 1024
  ingestion_incremental_disk_budget_bytes = 16 * 1024 * 1024 * 1024

  // Espelha as raízes COPY do Dockerfile, incluindo recursos JSON/SQL/Markdown
  // futuros, e remove explicitamente tudo que o contexto Docker ignora.
  ingestion_build_source_patterns = [
    "adapters/**",
    "application/**",
    "bootstrap/**",
    "contracts/**",
    "domain/**",
    "ports/**",
    "scripts/**",
  ]

  ingestion_build_excluded_path_patterns = [
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
  ]

  ingestion_build_candidates = setunion(
    toset([
      ".dockerignore",
      "Dockerfile",
      "requirements.txt",
    ]),
    setunion([
      for pattern in local.ingestion_build_source_patterns :
      fileset(local.ingestion_dir, pattern)
    ]...),
  )

  ingestion_build_files = toset([
    for file in local.ingestion_build_candidates : file
    if alltrue([
      for pattern in local.ingestion_build_excluded_path_patterns :
      !can(regex(pattern, file))
    ])
  ])

  ingestion_image_hash = sha256(join("", [
    for file in sort(tolist(local.ingestion_build_files)) :
    "${file}:${filesha256("${local.ingestion_dir}/${file}")}"
  ]))

  ingestion_image_tag = substr(local.ingestion_image_hash, 0, 12)
  ingestion_image_uri = local.ingestion_is_production ? var.imagem_ingestao : format(
    "%s@%s",
    aws_ecr_repository.ingestion.repository_url,
    data.aws_ecr_image.ingestion[0].image_digest,
  )

  // Mantém os cenários de guardrail planáveis quando o ARN de produção é nulo.
  // O sentinel nunca pode chegar ao apply porque ingestion_guardrails falha
  // antes para esse perfil inválido.
  ingestion_live_mysql_secret_selector_arn = coalesce(
    local.ingestion_live_mysql_secret_arn,
    "arn:aws:secretsmanager:${var.regiao}:000000000000:secret:missing",
  )

  ingestion_shared_environment = [
    { name = "INGESTION_ENVIRONMENT", value = var.ambiente },
    { name = "AWS_REGION", value = var.regiao },
    { name = "OPERATIONAL_TABLE_NAME", value = aws_dynamodb_table.operacional.name },
    { name = "METRICS_NAMESPACE", value = local.ingestion_metrics_namespace },
    { name = "LOG_SERVICE_NAME", value = local.ingestion_log_service_name },
    { name = "ARCHIVE_WORKDIR", value = "/tmp/ingestion" },
  ]
  ingestion_import_environment = [
    { name = "ARCHIVE_BUCKET_OWNER", value = data.aws_caller_identity.atual.account_id },
    { name = "INGESTION_DISK_BUDGET_BYTES", value = tostring(local.ingestion_snapshot_disk_budget_bytes) },
    { name = "IMPORT_HOT_MATERIALIZATION_ENABLED", value = tostring(var.import_hot_materialization_enabled) },
    { name = "ACTIVATE_CANDIDATE", value = "false" },
    { name = "PAGE_SIZE", value = tostring(var.ingestion_snapshot_page_size) },
    { name = "MYSQL_CONNECT_TIMEOUT_SECONDS", value = "10" },
    { name = "MYSQL_READ_TIMEOUT_SECONDS", value = "300" },
    { name = "MYSQL_WRITE_TIMEOUT_SECONDS", value = "300" },
    { name = "MYSQL_DDL_TIMEOUT_SECONDS", value = "1800" },
    { name = "MYSQL_QUERY_MAX_ATTEMPTS", value = "4" },
    { name = "MYSQL_QUERY_RETRY_BASE_MS", value = "250" },
    { name = "MYSQL_QUERY_RETRY_MAX_MS", value = "4000" },
    { name = "MYSQL_SNAPSHOT_PREPARE_ENABLED", value = tostring(var.ingestion_snapshot_prepare_enabled) },
  ]
  ingestion_snapshot_mysql_command = [
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
  ]
  ingestion_incremental_environment = [
    { name = "INCREMENTAL_BATCH_BUCKET", value = local.ingestion_bucket_name },
    { name = "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER", value = data.aws_caller_identity.atual.account_id },
    { name = "INCREMENTAL_BATCH_PREFIX", value = local.ingestion_incremental_raw_prefix },
    { name = "INCREMENTAL_BATCH_QUEUE_URL", value = aws_sqs_queue.incremental_batches.url },
  ]
}

resource "terraform_data" "ingestion_image" {
  count = local.ingestion_is_production ? 0 : 1

  input = {
    script_interpreter = "node"
    script_path        = abspath("${path.module}/scripts/publicar-imagem.mjs")
  }

  triggers_replace = [local.ingestion_image_hash]

  provisioner "local-exec" {
    # Evita o shell padrão do local-exec: o caminho do worktree segue como um
    # único argumento mesmo quando contém espaços ou metacaracteres.
    command     = self.input.script_path
    interpreter = [self.input.script_interpreter]

    environment = {
      REGIAO   = var.regiao
      REPO_URL = aws_ecr_repository.ingestion.repository_url
      TAG      = local.ingestion_image_tag
      CONTEXTO = abspath(local.ingestion_dir)
    }
  }

  lifecycle {
    replace_triggered_by = [aws_ecr_repository.ingestion]
  }
}

data "aws_ecr_image" "ingestion" {
  count = local.ingestion_is_production ? 0 : 1

  repository_name = aws_ecr_repository.ingestion.name
  image_tag       = local.ingestion_image_tag

  depends_on = [terraform_data.ingestion_image]
}

resource "aws_ecs_task_definition" "ingestion_backfill" {
  family                   = local.ingestion_backfill_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ingestion_backfill_cpu
  memory                   = var.ingestion_backfill_memoria
  execution_role_arn       = local.ingestion_ecs_execution_role_arn
  task_role_arn            = local.ingestion_ecs_task_role_arn

  ephemeral_storage {
    size_in_gib = var.ingestion_backfill_ephemeral_storage_gib
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  // Volumes sem host_path são bind mounts efêmeros no ciclo da task Fargate.
  // O Python recebe somente /tmp; o MySQL permanece gravável em /var/lib/mysql.
  volume {
    name = "ingestion-tmp"
  }

  volume {
    name = "mysql-data"
  }

  container_definitions = jsonencode([
    // O Fargate entrega um volume host vazio como root:root 0755 e NAO herda o
    // 1777 que a imagem tem em /tmp, ao contrario do Docker local. Como o
    // runtime roda como uid 10001 com rootfs somente leitura, sem este passo
    // ele nao tem onde escrever e recusa ARCHIVE_WORKDIR antes de qualquer
    // efeito. O Fargate nao suporta linuxParameters.tmpfs, e nao existe forma
    // declarativa de dar posse ao volume, entao a posse e ajustada por um init
    // container root que sai antes do runtime comecar.
    //
    // Os containers de suporte nao sao essenciais. Apenas o worker de ingestao
    // encerra a task; quando ele sai, o ECS interrompe o MySQL de suporte.
    {
      name                   = "tmp-owner"
      image                  = local.ingestion_image_uri
      essential              = false
      readonlyRootFilesystem = true
      user                   = "0"
      entryPoint             = ["/usr/bin/chown"]
      command                = ["10001:10001", "/tmp"]
      mountPoints            = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_backfill.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "tmp-owner"
        }
      }
    },
    {
      name                   = "mysql-snapshot"
      image                  = var.imagem_mysql_snapshot
      essential              = false
      readonlyRootFilesystem = false
      command                = local.ingestion_snapshot_mysql_command
      environment            = [{ name = "MYSQL_DATABASE", value = "argus" }]
      secrets                = [{ name = "MYSQL_ROOT_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      mountPoints            = [{ sourceVolume = "mysql-data", containerPath = "/var/lib/mysql", readOnly = false }]
      healthCheck = {
        command = ["CMD-SHELL", "mysqladmin ping --silent --protocol=TCP -h 127.0.0.1 -uroot -p\"$MYSQL_ROOT_PASSWORD\""]
        // O ECS recusa retries acima de 10 (RegisterTaskDefinition devolve 400).
        // interval 6 x 10 tentativas preserva a janela de 60s que o desenho
        // original pedia com 5 x 12.
        interval    = 6
        timeout     = 3
        retries     = 10
        startPeriod = 20
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_backfill.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "mysql"
        }
      }
    },
    {
      name                   = "ingestion"
      image                  = local.ingestion_image_uri
      essential              = true
      readonlyRootFilesystem = true
      command                = ["backfill"]
      dependsOn = [
        { containerName = "mysql-snapshot", condition = "HEALTHY" },
        { containerName = "tmp-owner", condition = "SUCCESS" },
      ]
      environment = concat(local.ingestion_shared_environment, local.ingestion_import_environment, [
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
      secrets     = [{ name = "MYSQL_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      mountPoints = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_backfill.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ingestion"
        }
      }
    },
  ])

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "backfill"
  }

  depends_on = [aws_cloudwatch_log_group.ingestion_backfill]
}

// Runtime exclusivo do fluxo web. Ele reutiliza exatamente os containers,
// mounts, sidecar MySQL e imagem imutável do backfill, mas nasce com uma role
// candidate-only e com comando fail-closed: sem o override estrito da API,
// `import-dump` encerra por ausência de --import-id.
resource "aws_ecs_task_definition" "ingestion_import" {
  family                   = local.ingestion_import_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ingestion_backfill_cpu
  memory                   = var.ingestion_backfill_memoria
  execution_role_arn       = local.ingestion_ecs_execution_role_arn
  task_role_arn            = local.ingestion_import_task_role_arn

  ephemeral_storage {
    size_in_gib = var.ingestion_backfill_ephemeral_storage_gib
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "ingestion-tmp"
  }

  volume {
    name = "mysql-data"
  }

  container_definitions = jsonencode([
    {
      name                   = "tmp-owner"
      image                  = local.ingestion_image_uri
      essential              = false
      readonlyRootFilesystem = true
      user                   = "0"
      entryPoint             = ["/usr/bin/chown"]
      command                = ["10001:10001", "/tmp"]
      mountPoints            = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_backfill.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "tmp-owner"
        }
      }
    },
    {
      name                   = "mysql-snapshot"
      image                  = var.imagem_mysql_snapshot
      essential              = false
      readonlyRootFilesystem = false
      command                = local.ingestion_snapshot_mysql_command
      environment            = [{ name = "MYSQL_DATABASE", value = "argus" }]
      secrets                = [{ name = "MYSQL_ROOT_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      mountPoints            = [{ sourceVolume = "mysql-data", containerPath = "/var/lib/mysql", readOnly = false }]
      healthCheck = {
        command     = ["CMD-SHELL", "mysqladmin ping --silent --protocol=TCP -h 127.0.0.1 -uroot -p\"$MYSQL_ROOT_PASSWORD\""]
        interval    = 6
        timeout     = 3
        retries     = 10
        startPeriod = 20
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_backfill.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "mysql"
        }
      }
    },
    {
      name                   = "ingestion"
      image                  = local.ingestion_image_uri
      essential              = true
      readonlyRootFilesystem = true
      command                = ["import-dump"]
      dependsOn = [
        { containerName = "mysql-snapshot", condition = "HEALTHY" },
        { containerName = "tmp-owner", condition = "SUCCESS" },
      ]
      environment = concat(local.ingestion_shared_environment, local.ingestion_import_environment, [
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
      secrets     = [{ name = "MYSQL_PASSWORD", valueFrom = local.ingestion_snapshot_mysql_secret_arn }]
      mountPoints = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_backfill.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ingestion"
        }
      }
    },
  ])

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "import-dump"
  }

  depends_on = [aws_cloudwatch_log_group.ingestion_backfill]
}

resource "aws_ecs_task_definition" "ingestion_sync" {
  family                   = local.ingestion_sync_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ingestion_sync_cpu
  memory                   = var.ingestion_sync_memoria
  execution_role_arn       = local.ingestion_ecs_execution_role_arn
  task_role_arn            = local.ingestion_ecs_task_role_arn

  ephemeral_storage {
    size_in_gib = var.ingestion_backfill_ephemeral_storage_gib
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "ingestion-tmp"
  }

  container_definitions = jsonencode([
    // O Fargate entrega um volume host vazio como root:root 0755 e NAO herda o
    // 1777 que a imagem tem em /tmp, ao contrario do Docker local. Como o
    // runtime roda como uid 10001 com rootfs somente leitura, sem este passo
    // ele nao tem onde escrever e recusa ARCHIVE_WORKDIR antes de qualquer
    // efeito. O Fargate nao suporta linuxParameters.tmpfs, e nao existe forma
    // declarativa de dar posse ao volume, entao a posse e ajustada por um init
    // container root que sai antes do runtime comecar.
    //
    // Nao essencial de proposito: somente o worker de ingestao controla o
    // ciclo de vida da task.
    {
      name                   = "tmp-owner"
      image                  = local.ingestion_image_uri
      essential              = false
      readonlyRootFilesystem = true
      user                   = "0"
      entryPoint             = ["/usr/bin/chown"]
      command                = ["10001:10001", "/tmp"]
      mountPoints            = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_sync.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "tmp-owner"
        }
      }
    },
    {
      name                   = "ingestion"
      image                  = local.ingestion_image_uri
      essential              = true
      readonlyRootFilesystem = true
      command                = ["sync"]
      dependsOn              = [{ containerName = "tmp-owner", condition = "SUCCESS" }]
      environment = concat(local.ingestion_shared_environment, [
        { name = "ARGUS_SOURCE_MODE", value = "live" },
        { name = "INGESTION_DISK_BUDGET_BYTES", value = tostring(local.ingestion_continuous_disk_budget_bytes) },
        { name = "SYNC_MAX_CATCHUP_WINDOWS", value = tostring(var.sync_max_catchup_windows) },
        { name = "SYNC_FINALIZATION_DELAY_SECONDS", value = tostring(var.sync_finalization_delay_seconds) },
        { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
      ])
      // JSON-key references require Fargate platform 1.4.0+, which is fixed
      // on the Scheduler target below.
      secrets = [
        { name = "LIVE_MYSQL_HOST", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:host::" },
        { name = "LIVE_MYSQL_PORT", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:port::" },
        { name = "LIVE_MYSQL_USER", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:username::" },
        { name = "LIVE_MYSQL_PASSWORD", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:password::" },
        { name = "LIVE_MYSQL_DATABASE", valueFrom = "${local.ingestion_live_mysql_secret_selector_arn}:database::" },
      ]
      mountPoints = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_sync.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ingestion"
        }
      }
    },
  ])

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "sync"
  }

  depends_on = [aws_cloudwatch_log_group.ingestion_sync]
}

resource "aws_ecs_task_definition" "ingestion_incremental_export" {
  family                   = local.ingestion_incremental_export_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ingestion_sync_cpu
  memory                   = var.ingestion_sync_memoria
  execution_role_arn       = local.ingestion_ecs_execution_role_arn
  task_role_arn            = local.ingestion_incremental_export_task_role_arn

  ephemeral_storage {
    size_in_gib = var.ingestion_backfill_ephemeral_storage_gib
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "ingestion-tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "tmp-owner"
      image                  = local.ingestion_image_uri
      essential              = false
      readonlyRootFilesystem = true
      user                   = "0"
      entryPoint             = ["/usr/bin/chown"]
      command                = ["10001:10001", "/tmp"]
      mountPoints            = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_incremental_export.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "tmp-owner"
        }
      }
    },
    {
      name                   = "ingestion"
      image                  = local.ingestion_image_uri
      essential              = true
      readonlyRootFilesystem = true
      command                = ["export-incremental"]
      dependsOn              = [{ containerName = "tmp-owner", condition = "SUCCESS" }]
      environment = concat(
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
      mountPoints = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_incremental_export.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ingestion"
        }
      }
    },
  ])

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "export-incremental"
  }

  depends_on = [aws_cloudwatch_log_group.ingestion_incremental_export]
}

resource "aws_ecs_task_definition" "ingestion_incremental_ingest" {
  family                   = local.ingestion_incremental_ingest_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ingestion_sync_cpu
  memory                   = var.ingestion_sync_memoria
  execution_role_arn       = local.ingestion_ecs_execution_role_arn
  task_role_arn            = local.ingestion_incremental_ingest_task_role_arn

  ephemeral_storage {
    size_in_gib = var.ingestion_backfill_ephemeral_storage_gib
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "ingestion-tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "tmp-owner"
      image                  = local.ingestion_image_uri
      essential              = false
      readonlyRootFilesystem = true
      user                   = "0"
      entryPoint             = ["/usr/bin/chown"]
      command                = ["10001:10001", "/tmp"]
      mountPoints            = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_incremental_ingest.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "tmp-owner"
        }
      }
    },
    {
      name                   = "ingestion"
      image                  = local.ingestion_image_uri
      essential              = true
      readonlyRootFilesystem = true
      command                = ["ingest-incremental", "--limit", "20"]
      dependsOn              = [{ containerName = "tmp-owner", condition = "SUCCESS" }]
      environment = concat(
        local.ingestion_shared_environment,
        local.ingestion_incremental_environment,
        [
          { name = "ANALYSIS_QUEUE_URL", value = aws_sqs_queue.analysis.url },
          { name = "INCREMENTAL_INGEST_LIMIT", value = "20" },
          { name = "INGESTION_DISK_BUDGET_BYTES", value = tostring(local.ingestion_incremental_disk_budget_bytes) },
        ],
      )
      mountPoints = [{ sourceVolume = "ingestion-tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_incremental_ingest.name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ingestion"
        }
      }
    },
  ])

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "ingest-incremental"
  }

  depends_on = [aws_cloudwatch_log_group.ingestion_incremental_ingest]
}

resource "aws_iam_role_policy" "ingestion_incremental_export" {
  count = local.ingestion_is_production ? 1 : 0

  name = "${local.ingestion_name_prefix}-incremental-export"
  role = local.ingestion_incremental_export_task_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "UseIncrementalRawObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
        Resource = "arn:${data.aws_partition.current.partition}:s3:::${local.ingestion_bucket_name}/${local.ingestion_incremental_raw_prefix}*"
      },
      {
        Sid      = "SendIncrementalBatchReference"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.incremental_batches.arn
      },
      {
        Sid      = "ReadExportControlItems"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "CONTROL#DATASET",
              "DATASET#*#INGESTION#SOURCE#export:signal_bucket",
              "INGESTION#SOURCE#EXPORT_INCREMENTAL",
              "INGESTION#IDEMPOTENCY#lease-acquire#*",
              "INGESTION#IDEMPOTENCY#lease-release#*",
              "INGESTION#IDEMPOTENCY#window-commit#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "PutExportControlItems"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "DATASET#*#INGESTION#SOURCE#export:signal_bucket",
              "INGESTION#SOURCE#EXPORT_INCREMENTAL",
              "INGESTION#IDEMPOTENCY#lease-acquire#*",
              "INGESTION#IDEMPOTENCY#lease-release#*",
              "INGESTION#IDEMPOTENCY#window-commit#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "DeleteExportLease"
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          StringEquals = {
            "dynamodb:LeadingKeys" = "INGESTION#SOURCE#EXPORT_INCREMENTAL"
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "ingestion_incremental_ingest" {
  count = local.ingestion_is_production ? 1 : 0

  name = "${local.ingestion_name_prefix}-incremental-ingest"
  role = local.ingestion_incremental_ingest_task_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadIncrementalRawObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:${data.aws_partition.current.partition}:s3:::${local.ingestion_bucket_name}/${local.ingestion_incremental_raw_prefix}*"
      },
      {
        Sid    = "ConsumeIncrementalBatchReferences"
        Effect = "Allow"
        Action = [
          "sqs:DeleteMessage",
          "sqs:ReceiveMessage",
        ]
        Resource = aws_sqs_queue.incremental_batches.arn
      },
      {
        Sid      = "PublishAnalysisRequests"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.analysis.arn
      },
      {
        Sid    = "ReadIncrementalOperationalData"
        Effect = "Allow"
        Action = [
          "dynamodb:BatchGetItem",
          "dynamodb:GetItem",
        ]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "CONTROL#DATASET",
              "BATCH#*",
              "DATASET#*#FACT#TS#*",
              "DATASET#*#INCIDENT#TS#*",
              "DATASET#*#CONTEXT#TS#*",
              "DATASET#*#INGESTION#SOURCE#*",
              "DATASET#*#INGESTION#HOTPART#*",
              "INGESTION#SOURCE#SYNC_GLOBAL",
              "INGESTION#IDEMPOTENCY#lease-acquire#*",
              "INGESTION#IDEMPOTENCY#lease-renew#*",
              "INGESTION#IDEMPOTENCY#lease-release#*",
              "INGESTION#IDEMPOTENCY#hot-write#*",
              "INGESTION#IDEMPOTENCY#window-commit#*",
              "INGESTION#IDEMPOTENCY#outbox-published#*",
              "INGESTION#OUTBOX#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "QueryIncrementalHotPartitions"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "DATASET#*#FACT#TS#*",
              "DATASET#*#INCIDENT#TS#*",
              "DATASET#*#CONTEXT#TS#*",
              "DATASET#*#INGESTION#SOURCE#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "QueryIncrementalOutbox"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = "${aws_dynamodb_table.operacional.arn}/index/outbox-pending-index"
        Condition = {
          StringEquals = {
            "dynamodb:LeadingKeys" = "OUTBOX#PENDING"
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "PutIncrementalOperationalData"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "BATCH#*",
              "DATASET#*#FACT#TS#*",
              "DATASET#*#INCIDENT#TS#*",
              "DATASET#*#CONTEXT#TS#*",
              "DATASET#*#INGESTION#SOURCE#*",
              "DATASET#*#INGESTION#HOTPART#*",
              "INGESTION#SOURCE#SYNC_GLOBAL",
              "INGESTION#IDEMPOTENCY#lease-acquire#*",
              "INGESTION#IDEMPOTENCY#lease-renew#*",
              "INGESTION#IDEMPOTENCY#lease-release#*",
              "INGESTION#IDEMPOTENCY#hot-write#*",
              "INGESTION#IDEMPOTENCY#window-commit#*",
              "INGESTION#IDEMPOTENCY#outbox-published#*",
              "INGESTION#OUTBOX#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "UpdateIncrementalOperationalData"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "BATCH#*",
              "INGESTION#SOURCE#SYNC_GLOBAL",
              "INGESTION#OUTBOX#*",
            ]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "DeleteIncrementalLease"
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          StringEquals = {
            "dynamodb:LeadingKeys" = "INGESTION#SOURCE#SYNC_GLOBAL"
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
      {
        Sid      = "CheckIncrementalRetentionGate"
        Effect   = "Allow"
        Action   = ["dynamodb:ConditionCheckItem"]
        Resource = aws_dynamodb_table.operacional.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["DATASET#*#INGESTION#RETENTION#*"]
          }
          Null = {
            "dynamodb:LeadingKeys" = "false"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "ingestion_incremental_scheduler" {
  count = local.ingestion_is_production ? 1 : 0

  name = "${local.ingestion_name_prefix}-incremental-scheduler"
  role = local.ingestion_scheduler_execution_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RunIncrementalTasks"
        Effect = "Allow"
        Action = ["ecs:RunTask"]
        Resource = [
          aws_ecs_task_definition.ingestion_incremental_export.arn,
          aws_ecs_task_definition.ingestion_incremental_ingest.arn,
        ]
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.principal.arn
          }
        }
      },
      {
        Sid    = "PassIncrementalTaskRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          local.ingestion_ecs_execution_role_arn,
          local.ingestion_incremental_export_task_role_arn,
          local.ingestion_incremental_ingest_task_role_arn,
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid      = "SendSchedulerDeadLetters"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.ingestion_scheduler_dlq.arn
      },
    ]
  })
}
