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
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-analysis-dlq"
  }
}

override_resource {
  target          = aws_ecr_repository.analysis_worker[0]
  override_during = plan
  values = {
    repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-analysis-worker"
  }
}

override_resource {
  target          = aws_instance.observabilidade[0]
  override_during = plan
  values = {
    id         = "i-observability"
    private_ip = "10.0.20.10"
    public_dns = "observability.example"
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

run "analysis_worker_is_disabled_by_default" {
  command = plan

  assert {
    condition = alltrue([
      length(aws_ecr_repository.analysis_worker) == 0,
      length(terraform_data.analysis_worker_image) == 0,
      length(aws_s3_object.analysis_model) == 0,
      length(aws_s3_object.analysis_catalog) == 0,
      length(aws_cloudwatch_log_group.analysis_worker) == 0,
      length(aws_ecs_task_definition.analysis_worker) == 0,
      length(aws_ecs_service.analysis_worker) == 0,
    ])
    error_message = "Sem analysis_worker_habilitado nenhum recurso do worker pode existir."
  }

  assert {
    condition = {
      for item in one(jsondecode(aws_ecs_task_definition.api.container_definitions)).environment : item.name => item.value
      if item.name == "ANALYSIS_QUEUE_URL"
    } == { ANALYSIS_QUEUE_URL = "" }
    error_message = "A API não pode receber a fila de análise sem um worker consumindo."
  }
}

run "analysis_worker_builds_its_image_and_publishes_local_artifacts" {
  command = plan

  variables {
    analysis_worker_habilitado  = true
    analysis_llm_provider       = "none"
    analysis_model_file         = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
  }

  assert {
    condition = alltrue([
      length(aws_ecr_repository.analysis_worker) == 1,
      aws_ecr_repository.analysis_worker[0].name == "view-show-analysis-worker",
      aws_ecr_repository.analysis_worker[0].image_tag_mutability == "IMMUTABLE",
      aws_ecr_repository.analysis_worker[0].force_delete,
      one(aws_ecr_repository.analysis_worker[0].image_scanning_configuration).scan_on_push,
      length(terraform_data.analysis_worker_image) == 1,
      terraform_data.analysis_worker_image[0].input.script_interpreter == "node",
      endswith(replace(terraform_data.analysis_worker_image[0].input.script_path, "\\", "/"), "/apps/fullstack/scripts/publicar-imagem.mjs"),
      terraform_data.analysis_worker_image[0].triggers_replace == [local.analysis_worker_image_hash],
    ])
    error_message = "O worker deve construir a imagem imutável pelo script Node e refazê-la quando as fontes mudarem."
  }

  assert {
    condition = alltrue([
      length(aws_s3_object.analysis_model) == 1,
      length(aws_s3_object.analysis_catalog) == 1,
      aws_s3_object.analysis_model[0].bucket == "view-show-ingestion-123456789012-us-east-1",
      aws_s3_object.analysis_model[0].key == "analysis/models/${filesha256("tests/fixtures/analysis-model.json")}.json",
      aws_s3_object.analysis_catalog[0].key == "analysis/catalogs/${filesha256("tests/fixtures/analysis-catalog.json")}.json",
      aws_s3_object.analysis_model[0].source == "tests/fixtures/analysis-model.json",
      aws_s3_object.analysis_model[0].server_side_encryption == "AES256",
      aws_s3_object.analysis_catalog[0].server_side_encryption == "AES256",
    ])
    error_message = "O modelo e o catálogo devem ir para o bucket da ingestão em chaves derivadas do SHA-256, com SSE-S3."
  }

  assert {
    condition = alltrue([
      length(aws_ecs_task_definition.analysis_worker) == 1,
      { for item in one(jsondecode(aws_ecs_task_definition.analysis_worker[0].container_definitions)).environment : item.name => item.value } == {
        NODE_ENV                        = "production"
        AWS_REGION                      = "us-east-1"
        OPERATIONAL_TABLE_NAME          = aws_dynamodb_table.operacional.name
        ANALYSIS_QUEUE_URL              = aws_sqs_queue.analysis.url
        ANALYSIS_DLQ_URL                = aws_sqs_queue.analysis_dlq.url
        ANALYSIS_MODEL_LOCATION         = "s3://view-show-ingestion-123456789012-us-east-1/analysis/models/${filesha256("tests/fixtures/analysis-model.json")}.json"
        ANALYSIS_SCOPE_CATALOG_LOCATION = "s3://view-show-ingestion-123456789012-us-east-1/analysis/catalogs/${filesha256("tests/fixtures/analysis-catalog.json")}.json"
        ANALYSIS_MODEL_SHA256           = filesha256("tests/fixtures/analysis-model.json")
        LLM_PROVIDER                    = "none"
        LLM_MODEL_ID                    = "anthropic.claude-3-haiku-20240307-v1:0"
        OLLAMA_BASE_URL                 = ""
        OTEL_SERVICE_NAME               = "view-show-agentic"
        OTEL_DEPLOYMENT_ENVIRONMENT     = "aws"
        OTEL_SERVICE_VERSION            = local.analysis_worker_service_version
        OTEL_EXPORTER_OTLP_ENDPOINT     = ""
      },
      one(jsondecode(aws_ecs_task_definition.analysis_worker[0].container_definitions)).image == "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-analysis-worker:${local.analysis_worker_image_tag}",
      one(jsondecode(aws_ecs_task_definition.analysis_worker[0].container_definitions)).stopTimeout == 120,
    ])
    error_message = "O worker deve consumir a fila e a DLQ únicas da ingestão, ler os artefatos publicados e rodar sem LLM."
  }

  assert {
    condition = {
      for item in one(jsondecode(aws_ecs_task_definition.api.container_definitions)).environment : item.name => item.value
      if item.name == "ANALYSIS_QUEUE_URL"
    } == { ANALYSIS_QUEUE_URL = aws_sqs_queue.analysis.url }
    error_message = "A API deve publicar a reanálise na mesma fila que a ingestão alimenta quando há worker."
  }

  assert {
    condition = alltrue([
      length(aws_ecs_service.analysis_worker) == 1,
      aws_ecs_service.analysis_worker[0].desired_count == 0,
      aws_ecs_service.analysis_worker[0].launch_type == "FARGATE",
      !one(aws_ecs_service.analysis_worker[0].network_configuration).assign_public_ip,
    ])
    error_message = "O serviço do worker deve ser preparado em Fargate privado com zero tasks antes do gate."
  }

  assert {
    condition = alltrue([
      toset(keys(output.analysis_worker_operacao)) == toset([
        "cluster_name", "task_definition", "task_family", "container_name",
        "subnet_ids", "security_group_id", "assign_public_ip", "log_group",
        "analysis_queue_url", "operational_table", "desired_count",
      ]),
      output.analysis_worker_operacao.cluster_name == "view-show-iac-cluster",
      output.analysis_worker_operacao.task_family == "view-show-analysis-worker",
      output.analysis_worker_operacao.container_name == "analysis-worker",
      output.analysis_worker_operacao.assign_public_ip == false,
      output.analysis_worker_operacao.log_group == "/ecs/view-show-analysis-worker",
      output.analysis_worker_operacao.desired_count == 0,
    ])
    error_message = "O output operacional deve trazer apenas identificadores necessários ao rollout."
  }
}

run "analysis_worker_starts_one_replica_only_after_gate" {
  command = plan

  variables {
    analysis_worker_habilitado    = true
    analysis_worker_desired_count = 1
    analysis_llm_provider         = "none"
    analysis_model_file           = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file   = "tests/fixtures/analysis-catalog.json"
  }

  assert {
    condition     = aws_ecs_service.analysis_worker[0].desired_count == 1
    error_message = "A ativação deve iniciar exatamente uma réplica."
  }
}

run "analysis_worker_rejects_more_than_one_replica" {
  command = plan

  variables {
    analysis_worker_habilitado    = true
    analysis_worker_desired_count = 2
    analysis_llm_provider         = "none"
    analysis_model_file           = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file   = "tests/fixtures/analysis-catalog.json"
  }

  expect_failures = [var.analysis_worker_desired_count]
}

run "analysis_worker_rejects_replica_when_disabled" {
  command = plan

  variables {
    analysis_worker_desired_count = 1
  }

  expect_failures = [var.analysis_worker_desired_count]
}

run "analysis_worker_exports_to_private_otlp_when_observability_is_enabled" {
  command = plan

  variables {
    analysis_worker_habilitado  = true
    observabilidade_habilitada  = true
    analysis_llm_provider       = "none"
    analysis_model_file         = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
  }

  assert {
    condition = {
      for item in one(jsondecode(aws_ecs_task_definition.analysis_worker[0].container_definitions)).environment : item.name => item.value
      if startswith(item.name, "OTEL_")
      } == {
      OTEL_SERVICE_NAME           = "view-show-agentic"
      OTEL_DEPLOYMENT_ENVIRONMENT = "aws"
      OTEL_SERVICE_VERSION        = local.analysis_worker_service_version
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://10.0.20.10:4320"
    }
    error_message = "A task deve exportar OTLP para o Alloy privado da stack."
  }
}

run "analysis_worker_uses_artifacts_that_are_already_published" {
  command = plan

  variables {
    analysis_worker_habilitado      = true
    analysis_llm_provider           = "none"
    analysis_model_location         = "s3://view-show-ingestion-123456789012-us-east-1/analysis/models/published.json"
    analysis_scope_catalog_location = "s3://view-show-ingestion-123456789012-us-east-1/analysis/catalogs/published.json"
    analysis_model_sha256           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = alltrue([
      length(aws_s3_object.analysis_model) == 0,
      length(aws_s3_object.analysis_catalog) == 0,
      local.analysis_model_location == "s3://view-show-ingestion-123456789012-us-east-1/analysis/models/published.json",
      local.analysis_scope_catalog_location == "s3://view-show-ingestion-123456789012-us-east-1/analysis/catalogs/published.json",
      local.analysis_model_sha256 == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      length(aws_ecs_service.analysis_worker) == 1,
    ])
    error_message = "Artefatos já publicados não podem ser reenviados, e o SHA-256 informado deve chegar ao worker."
  }
}

run "analysis_worker_uses_a_given_image_without_building_one" {
  command = plan

  variables {
    analysis_worker_habilitado  = true
    analysis_llm_provider       = "none"
    analysis_worker_image_uri   = "123456789012.dkr.ecr.us-east-1.amazonaws.com/custom-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    analysis_model_file         = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
  }

  assert {
    condition = alltrue([
      length(aws_ecr_repository.analysis_worker) == 0,
      length(terraform_data.analysis_worker_image) == 0,
      one(jsondecode(aws_ecs_task_definition.analysis_worker[0].container_definitions)).image == "123456789012.dkr.ecr.us-east-1.amazonaws.com/custom-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ])
    error_message = "Com uma imagem informada o Terraform não pode criar repositório nem construir imagem."
  }
}

run "analysis_worker_requires_a_model_and_a_catalog" {
  command = plan

  variables {
    analysis_worker_habilitado = true
  }

  expect_failures = [var.analysis_model_location]
}

run "analysis_worker_requires_the_model_and_catalog_files_together" {
  command = plan

  variables {
    analysis_worker_habilitado = true
    analysis_model_file        = "tests/fixtures/analysis-model.json"
  }

  expect_failures = [var.analysis_model_file]
}

run "analysis_worker_rejects_mixing_local_files_and_published_uris" {
  command = plan

  variables {
    analysis_worker_habilitado  = true
    analysis_model_file         = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
    analysis_model_location     = "s3://view-show-ingestion-123456789012-us-east-1/analysis/models/published.json"
  }

  expect_failures = [var.analysis_model_location]
}

run "analysis_worker_rejects_a_model_file_that_does_not_exist" {
  command = plan

  variables {
    analysis_worker_habilitado  = true
    analysis_model_file         = "tests/fixtures/does-not-exist.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
  }

  expect_failures = [var.analysis_model_file]
}

run "analysis_worker_rejects_an_unknown_llm_provider" {
  command = plan

  variables {
    analysis_worker_habilitado  = true
    analysis_llm_provider       = "openai"
    analysis_model_file         = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
  }

  expect_failures = [var.analysis_llm_provider]
}
