// Worker de análise. Ele consome a fila de análise que a ingestão publica
// (aws_sqs_queue.analysis, em ingestion-messaging.tf): existe uma única fila e
// uma única DLQ para o produtor, o consumidor e a reanálise pedida pela API.
//
// Tudo aqui é condicional a var.analysis_worker_habilitado. No Learner Lab o
// próprio apply constrói a imagem e publica o modelo aprovado e o catálogo de
// séries no bucket da ingestão. Ambos os perfis usam uma role IRSA exclusiva.

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

  // Sem imagem informada, o Terraform constrói e publica a do módulo.
  analysis_worker_builds_image = var.analysis_worker_habilitado && var.analysis_worker_image_uri == ""

  // O sufixo [0] só é avaliado quando o repositório existe.
  analysis_worker_image_uri = !var.analysis_worker_habilitado ? "" : (
    var.analysis_worker_image_uri != "" ? var.analysis_worker_image_uri :
    "${aws_ecr_repository.analysis_worker[0].repository_url}:${local.analysis_worker_image_tag}"
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
