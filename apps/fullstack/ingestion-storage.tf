// Arquivo privado e versionado da ingestão; produção é gerida por recursos AWS,
// enquanto o Learner Lab usa uma compatibilidade limitada para sua SCP de S3.
locals {
  // O runtime publica nesses caminhos literais; mantê-los fechados impede que
  // uma customização de lifecycle expire objetos fora do contrato da aplicação.
  // canonical/ fica fora de toda regra de expiração por ser o arquivo canônico.
  ingestion_canonical_prefix       = "canonical/"
  ingestion_incremental_raw_prefix = "raw/argus/incremental/"
  ingestion_dumps_prefix           = "dumps/"
  ingestion_staging_prefix         = "staging/"
  ingestion_athena_results_prefix  = var.prefixo_resultados_athena_ingestao

  ingestion_lifecycle_prefixes = [
    local.ingestion_incremental_raw_prefix,
    local.ingestion_dumps_prefix,
    local.ingestion_staging_prefix,
    local.ingestion_athena_results_prefix,
  ]

  ingestion_lifecycle_prefixes_non_overlapping = (
    length(distinct(local.ingestion_lifecycle_prefixes)) == length(local.ingestion_lifecycle_prefixes) &&
    alltrue([
      for pair in setproduct(local.ingestion_lifecycle_prefixes, local.ingestion_lifecycle_prefixes) :
      pair[0] == pair[1] || !startswith(pair[0], pair[1])
    ])
  )

  ingestion_lifecycle_prefixes_isolated_from_canonical = alltrue([
    for prefix in local.ingestion_lifecycle_prefixes :
    !startswith(prefix, local.ingestion_canonical_prefix) &&
    !startswith(local.ingestion_canonical_prefix, prefix)
  ])

  ingestion_incremental_raw_prefix_isolated = alltrue([
    for prefix in [
      local.ingestion_canonical_prefix,
      local.ingestion_dumps_prefix,
      local.ingestion_staging_prefix,
      ] : (
      !startswith(local.ingestion_incremental_raw_prefix, prefix) &&
      !startswith(prefix, local.ingestion_incremental_raw_prefix)
    )
  ])

  ingestion_lifecycle_rule_ids = [
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
  ]

  ingestion_lifecycle_rules = {
    raw-argus-incremental = {
      status                       = "Enabled"
      prefix                       = local.ingestion_incremental_raw_prefix
      expiration_days              = var.retencao_raw_incremental_ingestao_dias - var.retencao_raw_incremental_noncurrent_ingestao_dias
      noncurrent_expiration_days   = var.retencao_raw_incremental_noncurrent_ingestao_dias
      abort_multipart_days         = null
      expired_object_delete_marker = false
    }
    dumps = {
      status                       = "Enabled"
      prefix                       = local.ingestion_dumps_prefix
      expiration_days              = var.retencao_dumps_ingestao_dias
      noncurrent_expiration_days   = var.retencao_dumps_ingestao_dias
      abort_multipart_days         = null
      expired_object_delete_marker = false
    }
    staging = {
      status                       = "Enabled"
      prefix                       = local.ingestion_staging_prefix
      expiration_days              = var.retencao_temporarios_ingestao_dias
      noncurrent_expiration_days   = var.retencao_temporarios_ingestao_dias
      abort_multipart_days         = null
      expired_object_delete_marker = false
    }
    staging-canonical-expiration = {
      status                       = "Enabled"
      prefix                       = "staging/canonical/"
      expiration_days              = 7
      noncurrent_expiration_days   = 7
      abort_multipart_days         = 1
      expired_object_delete_marker = false
    }
    athena-results = {
      status                       = "Enabled"
      prefix                       = local.ingestion_athena_results_prefix
      expiration_days              = var.retencao_temporarios_ingestao_dias
      noncurrent_expiration_days   = var.retencao_temporarios_ingestao_dias
      abort_multipart_days         = null
      expired_object_delete_marker = false
    }
    raw-argus-incremental-abort-multipart = {
      status                       = "Enabled"
      prefix                       = local.ingestion_incremental_raw_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = 1
      expired_object_delete_marker = false
    }
    dumps-abort-multipart = {
      status                       = "Enabled"
      prefix                       = local.ingestion_dumps_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = 1
      expired_object_delete_marker = false
    }
    staging-abort-multipart = {
      status                       = "Enabled"
      prefix                       = local.ingestion_staging_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = 1
      expired_object_delete_marker = false
    }
    athena-results-abort-multipart = {
      status                       = "Enabled"
      prefix                       = local.ingestion_athena_results_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = 1
      expired_object_delete_marker = false
    }
    raw-argus-incremental-expired-delete-markers = {
      status                       = "Enabled"
      prefix                       = local.ingestion_incremental_raw_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = null
      expired_object_delete_marker = true
    }
    dumps-expired-delete-markers = {
      status                       = "Enabled"
      prefix                       = local.ingestion_dumps_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = null
      expired_object_delete_marker = true
    }
    staging-expired-delete-markers = {
      status                       = "Enabled"
      prefix                       = local.ingestion_staging_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = null
      expired_object_delete_marker = true
    }
    athena-results-expired-delete-markers = {
      status                       = "Enabled"
      prefix                       = local.ingestion_athena_results_prefix
      expiration_days              = null
      noncurrent_expiration_days   = null
      abort_multipart_days         = null
      expired_object_delete_marker = true
    }
  }

  // A checagem cobre a configuração efetiva inteira, inclusive regras de
  // limpeza sem expiração. Prefixo ausente/vazio também é bucket-wide.
  ingestion_lifecycle_rules_isolated_from_canonical = alltrue([
    for rule in values(local.ingestion_lifecycle_rules) : try(
      length(rule.prefix) > 0 &&
      !startswith(rule.prefix, local.ingestion_canonical_prefix) &&
      !startswith(local.ingestion_canonical_prefix, rule.prefix),
      false,
    )
  ])

  // O mesmo contrato fechado é aplicado pelo provider em produção e pelo
  // script compatível no Learner Lab. Não há wildcard nem métodos de leitura.
  ingestion_import_cors_rule = {
    allowed_origins = [local.painel_url]
    allowed_methods = ["PUT", "HEAD"]
    allowed_headers = ["content-type", "x-amz-checksum-sha256"]
    expose_headers  = ["ETag", "x-amz-checksum-sha256"]
    max_age_seconds = 900
  }
}

resource "aws_s3_bucket" "ingestion" {
  count = local.ingestion_s3_learner_lab_compat_enabled ? 0 : 1

  bucket        = local.ingestion_bucket_name
  force_destroy = var.force_destroy_bucket_ingestao

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "terraform_data" "ingestion_bucket_learner_lab" {
  count = local.ingestion_s3_learner_lab_compat_enabled ? 1 : 0

  input = {
    bucket_name          = local.ingestion_bucket_name
    account_id           = data.aws_caller_identity.atual.account_id
    region               = data.aws_region.atual.name
    deployment_namespace = var.deployment_namespace
    frontend_origin      = local.painel_url
    script_interpreter   = "node"
    script_path          = abspath("${path.module}/scripts/ensure-ingestion-bucket.mjs")
  }

  triggers_replace = [
    local.ingestion_bucket_name,
    data.aws_caller_identity.atual.account_id,
    data.aws_region.atual.name,
    var.deployment_namespace,
    local.painel_url,
    filesha256("${path.module}/scripts/ensure-ingestion-bucket.mjs"),
  ]

  provisioner "local-exec" {
    // Apenas o Learner Lab delega esta criação ao script por compatibilidade de SCP.
    # O caminho é um argumento direto do Node; nenhum shell reinterpreta
    # espaços ou metacaracteres do diretório do worktree.
    command     = self.input.script_path
    interpreter = [self.input.script_interpreter]

    environment = {
      AWS_REGION             = data.aws_region.atual.name
      BUCKET_NAME            = local.ingestion_bucket_name
      DEPLOYMENT_ENVIRONMENT = var.ambiente
      EXPECTED_ACCOUNT_ID    = data.aws_caller_identity.atual.account_id
      DEPLOYMENT_NAMESPACE   = var.deployment_namespace
      FRONTEND_ORIGIN        = local.painel_url
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "ingestion" {
  count = local.ingestion_s3_learner_lab_compat_enabled ? 0 : 1

  bucket                = aws_s3_bucket.ingestion[0].id
  expected_bucket_owner = data.aws_caller_identity.atual.account_id

  cors_rule {
    allowed_origins = local.ingestion_import_cors_rule.allowed_origins
    allowed_methods = local.ingestion_import_cors_rule.allowed_methods
    allowed_headers = local.ingestion_import_cors_rule.allowed_headers
    expose_headers  = local.ingestion_import_cors_rule.expose_headers
    max_age_seconds = local.ingestion_import_cors_rule.max_age_seconds
  }
}

resource "aws_s3_bucket_versioning" "ingestion" {
  bucket = local.ingestion_bucket_name

  versioning_configuration {
    status = "Enabled"
  }

  depends_on = [
    aws_s3_bucket.ingestion,
    terraform_data.ingestion_bucket_learner_lab,
  ]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ingestion" {
  bucket = local.ingestion_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

  depends_on = [
    aws_s3_bucket.ingestion,
    terraform_data.ingestion_bucket_learner_lab,
  ]
}

resource "aws_s3_bucket_public_access_block" "ingestion" {
  bucket = local.ingestion_bucket_name

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [
    aws_s3_bucket.ingestion,
    terraform_data.ingestion_bucket_learner_lab,
  ]
}

resource "aws_s3_bucket_lifecycle_configuration" "ingestion" {
  bucket = local.ingestion_bucket_name

  dynamic "rule" {
    for_each = local.ingestion_lifecycle_rule_ids

    content {
      id     = rule.value
      status = local.ingestion_lifecycle_rules[rule.value].status

      filter {
        prefix = local.ingestion_lifecycle_rules[rule.value].prefix
      }

      dynamic "expiration" {
        for_each = local.ingestion_lifecycle_rules[rule.value].expiration_days != null || local.ingestion_lifecycle_rules[rule.value].expired_object_delete_marker ? [local.ingestion_lifecycle_rules[rule.value]] : []

        content {
          days                         = expiration.value.expiration_days
          expired_object_delete_marker = expiration.value.expired_object_delete_marker ? true : null
        }
      }

      dynamic "noncurrent_version_expiration" {
        for_each = local.ingestion_lifecycle_rules[rule.value].noncurrent_expiration_days != null ? [local.ingestion_lifecycle_rules[rule.value]] : []

        content {
          noncurrent_days = noncurrent_version_expiration.value.noncurrent_expiration_days
        }
      }

      dynamic "abort_incomplete_multipart_upload" {
        for_each = local.ingestion_lifecycle_rules[rule.value].abort_multipart_days != null ? [local.ingestion_lifecycle_rules[rule.value]] : []

        content {
          days_after_initiation = abort_incomplete_multipart_upload.value.abort_multipart_days
        }
      }
    }
  }

  depends_on = [
    aws_s3_bucket_versioning.ingestion,
    terraform_data.ingestion_bucket_learner_lab,
  ]
}
