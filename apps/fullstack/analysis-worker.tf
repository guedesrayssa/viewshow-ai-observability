// Worker de análise. Ele consome a fila de análise que a ingestão publica
// (aws_sqs_queue.analysis, em ingestion-messaging.tf): existe uma única fila e
// uma única DLQ para o produtor, o consumidor e a reanálise pedida pela API.
//
// Tudo aqui é condicional a var.analysis_worker_habilitado. No Learner Lab o
// próprio apply constrói a imagem e publica o modelo aprovado e o catálogo de
// séries no bucket da ingestão. O perfil production ainda não tem roles
// próprias para o worker e é recusado pelas validações de variables.tf.

locals {
  analysis_worker_dir = "${path.module}/../backend/agentic"

  // Espelha as origens de COPY do Dockerfile do worker.
  analysis_worker_build_files = sort(concat(
    [
      ".dockerignore",
      "Dockerfile",
      "package-lock.json",
      "package.json",
      "tsconfig.json",
    ],
    tolist(fileset(local.analysis_worker_dir, "src/**")),
  ))

  analysis_worker_image_hash = sha256(join("", [
    for arquivo in local.analysis_worker_build_files :
    "${arquivo}:${filesha256("${local.analysis_worker_dir}/${arquivo}")}\n"
  ]))
  analysis_worker_image_tag = substr(local.analysis_worker_image_hash, 0, 12)
  analysis_worker_service_version = (
    var.analysis_worker_image_uri != ""
    ? substr(sha256(var.analysis_worker_image_uri), 0, 12)
    : local.analysis_worker_image_tag
  )

  // Sem imagem informada, o Terraform constrói e publica a do módulo.
  analysis_worker_builds_image = var.analysis_worker_habilitado && var.analysis_worker_image_uri == ""

  // O sufixo [0] só é avaliado quando o repositório existe.
  analysis_worker_image_uri = !var.analysis_worker_habilitado ? "" : (
    var.analysis_worker_image_uri != "" ? var.analysis_worker_image_uri :
    "${data.aws_caller_identity.atual.account_id}.dkr.ecr.${var.regiao}.amazonaws.com/${var.deployment_namespace}-analysis-worker:${local.analysis_worker_image_tag}"
  )

  // Com arquivos locais, o Terraform publica os dois no bucket da ingestão em
  // chaves derivadas do SHA-256; sem eles, valem as URIs já publicadas.
  analysis_worker_uploads_artifacts = var.analysis_worker_habilitado && var.analysis_model_file != ""

  analysis_model_sha256 = (
    local.analysis_worker_uploads_artifacts && fileexists(var.analysis_model_file)
    ? filesha256(var.analysis_model_file)
    : var.analysis_model_sha256
  )
  analysis_catalog_sha256 = (
    local.analysis_worker_uploads_artifacts && fileexists(var.analysis_scope_catalog_file)
    ? filesha256(var.analysis_scope_catalog_file)
    : ""
  )
  analysis_model_key   = "analysis/models/${local.analysis_model_sha256}.json"
  analysis_catalog_key = "analysis/catalogs/${local.analysis_catalog_sha256}.json"

  analysis_model_location = (
    local.analysis_worker_uploads_artifacts
    ? "s3://${local.ingestion_bucket_name}/${local.analysis_model_key}"
    : var.analysis_model_location
  )
  analysis_scope_catalog_location = (
    local.analysis_worker_uploads_artifacts
    ? "s3://${local.ingestion_bucket_name}/${local.analysis_catalog_key}"
    : var.analysis_scope_catalog_location
  )
}

resource "aws_ecr_repository" "analysis_worker" {
  count = local.analysis_worker_builds_image ? 1 : 0

  name                 = "${var.deployment_namespace}-analysis-worker"
  image_tag_mutability = "IMMUTABLE"

  // Sem isto o destroy falha enquanto houver imagem no repositório.
  force_delete = true

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Componente = "analysis-worker"
    Ambiente   = var.ambiente
  }
}

resource "terraform_data" "analysis_worker_image" {
  count = local.analysis_worker_builds_image ? 1 : 0

  input = {
    script_interpreter = "node"
    script_path        = abspath("${path.module}/scripts/publicar-imagem.mjs")
  }

  triggers_replace = [local.analysis_worker_image_hash]

  provisioner "local-exec" {
    command     = self.input.script_path
    interpreter = [self.input.script_interpreter]

    environment = {
      REGIAO   = var.regiao
      REPO_URL = aws_ecr_repository.analysis_worker[0].repository_url
      TAG      = local.analysis_worker_image_tag
      CONTEXTO = abspath(local.analysis_worker_dir)
    }
  }

  lifecycle {
    replace_triggered_by = [aws_ecr_repository.analysis_worker]
  }
}

resource "aws_s3_object" "analysis_model" {
  count = local.analysis_worker_uploads_artifacts ? 1 : 0

  bucket                 = local.ingestion_bucket_name
  key                    = local.analysis_model_key
  source                 = var.analysis_model_file
  source_hash            = filemd5(var.analysis_model_file)
  content_type           = "application/json"
  server_side_encryption = "AES256"

  depends_on = [aws_s3_bucket_versioning.ingestion]
}

resource "aws_s3_object" "analysis_catalog" {
  count = local.analysis_worker_uploads_artifacts ? 1 : 0

  bucket                 = local.ingestion_bucket_name
  key                    = local.analysis_catalog_key
  source                 = var.analysis_scope_catalog_file
  source_hash            = filemd5(var.analysis_scope_catalog_file)
  content_type           = "application/json"
  server_side_encryption = "AES256"

  depends_on = [aws_s3_bucket_versioning.ingestion]
}

resource "aws_cloudwatch_log_group" "analysis_worker" {
  count             = var.analysis_worker_habilitado ? 1 : 0
  name              = "/ecs/${var.deployment_namespace}-analysis-worker"
  retention_in_days = var.retencao_logs_dias
}

resource "aws_security_group_rule" "ollama_ssh_bridge" {
  count                    = var.analysis_worker_habilitado && var.analysis_ssh_bridge_habilitado ? 1 : 0
  type                     = "ingress"
  description              = "Ollama via SSH reverso somente a partir do Security Group do servico ECS"
  from_port                = 11434
  to_port                  = 11434
  protocol                 = "tcp"
  security_group_id        = aws_security_group.bastion.id
  source_security_group_id = aws_security_group.servico.id

  lifecycle {
    precondition {
      condition     = var.analysis_ollama_base_url == "http://${aws_instance.bastion.private_ip}:11434"
      error_message = "A ponte SSH exige o IP privado do bastion como endpoint Ollama."
    }
  }
}

resource "aws_ecs_task_definition" "analysis_worker" {
  count                    = var.analysis_worker_habilitado ? 1 : 0
  family                   = "${var.deployment_namespace}-analysis-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  // O sidecar de teste do Ollama (ver analysis_ollama_sidecar_habilitado) não
  // cabe no dimensionamento normal do worker; Fargate não tem GPU, então até
  // um modelo pequeno em CPU pede mais CPU/memória do que o worker sozinho.
  cpu                = var.analysis_ollama_sidecar_habilitado ? "4096" : "512"
  memory             = var.analysis_ollama_sidecar_habilitado ? "10240" : "1024"
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

  container_definitions = jsonencode(concat([merge({
    name      = "analysis-worker"
    image     = local.analysis_worker_image_uri
    essential = true

    // O worker termina as análises em andamento ao receber SIGTERM; 120 s é o
    // máximo que o Fargate permite antes do SIGKILL.
    stopTimeout = 120

    environment = concat([
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
      { name = "OTEL_SERVICE_NAME", value = "view-show-agentic" },
      { name = "OTEL_DEPLOYMENT_ENVIRONMENT", value = "aws" },
      { name = "OTEL_SERVICE_VERSION", value = local.analysis_worker_service_version },
      { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:4320" : "" },
    ], var.analysis_llm_timeout_ms != "" ? [{ name = "LLM_TIMEOUT_MS", value = var.analysis_llm_timeout_ms }] : [])

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.analysis_worker[0].name
        "awslogs-region"        = var.regiao
        "awslogs-stream-prefix" = "worker"
      }
    }
    }, var.analysis_ollama_sidecar_habilitado ? {
    // Só inicia depois que o Ollama respondeu ao pull do modelo — sem isso
    // a primeira análise chegaria a um Ollama de pé mas sem modelo.
    dependsOn = [{ containerName = "ollama", condition = "HEALTHY" }]
    } : {})],
    // Container de teste, nunca o caminho de produção (ver a variável).
    var.analysis_ollama_sidecar_habilitado ? [{
      name       = "ollama"
      image      = "ollama/ollama:latest"
      essential  = true
      entryPoint = ["sh", "-c"]
      command    = ["ollama serve & sleep 5 && ollama pull ${var.analysis_llm_model_id} && wait"]

      // O ECS recusa retries acima de 10; a janela de 10 min (startPeriod +
      // retries*interval) cobre o pull de um modelo de poucos GB em CPU.
      healthCheck = {
        command     = ["CMD-SHELL", "ollama list | grep -q ${var.analysis_llm_model_id} || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 10
        startPeriod = 300
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.analysis_worker[0].name
          "awslogs-region"        = var.regiao
          "awslogs-stream-prefix" = "ollama"
        }
      }
    }] : []
  ))
}

resource "aws_ecs_service" "analysis_worker" {
  count           = var.analysis_worker_habilitado ? 1 : 0
  name            = "${var.deployment_namespace}-analysis-worker"
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.analysis_worker[0].arn
  desired_count   = var.analysis_worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = values(aws_subnet.privada)[*].id
    security_groups  = [aws_security_group.servico.id]
    assign_public_ip = false
  }

  // A imagem e os artefatos precisam existir antes da primeira task, senão ela
  // falha no pull ou na leitura do modelo e o serviço entra em laço de falhas.
  depends_on = [
    terraform_data.analysis_worker_image,
    aws_s3_object.analysis_model,
    aws_s3_object.analysis_catalog,
  ]
}
