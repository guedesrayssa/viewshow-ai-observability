// Fila de análise, duas DLQs e contêineres de segredos; valores de segredos
// continuam externos ao Terraform.
resource "aws_sqs_queue" "analysis_dlq" {
  name                      = local.ingestion_analysis_dlq
  fifo_queue                = false
  message_retention_seconds = var.retencao_filas_ingestao_segundos
  sqs_managed_sse_enabled   = true

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_sqs_queue" "analysis" {
  name                       = local.ingestion_analysis_queue
  fifo_queue                 = false
  message_retention_seconds  = var.retencao_filas_ingestao_segundos
  receive_wait_time_seconds  = 20
  visibility_timeout_seconds = 300
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.analysis_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_sqs_queue" "incremental_batches_dlq" {
  name                        = local.ingestion_incremental_dlq
  fifo_queue                  = true
  content_based_deduplication = false
  message_retention_seconds   = var.retencao_filas_ingestao_segundos
  receive_wait_time_seconds   = 20
  visibility_timeout_seconds  = 300
  sqs_managed_sse_enabled     = true

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "incremental-batches-dlq"
  }
}

resource "aws_sqs_queue" "incremental_batches" {
  name                        = local.ingestion_incremental_queue
  fifo_queue                  = true
  content_based_deduplication = false
  message_retention_seconds   = var.retencao_filas_ingestao_segundos
  receive_wait_time_seconds   = 20
  visibility_timeout_seconds  = 300
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.incremental_batches_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
    Operacao   = "incremental-batches"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "incremental_batches_dlq" {
  queue_url = aws_sqs_queue.incremental_batches_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.incremental_batches.arn]
  })
}

resource "aws_secretsmanager_secret" "snapshot_mysql" {
  count = local.ingestion_is_production ? 0 : 1

  name = local.ingestion_snapshot_secret_name
  // Terraform cria somente o contêiner; o valor raw é abastecido por operação.
  description             = "Contêiner do segredo raw usado pelo MySQL de snapshot; o valor é preenchido fora do Terraform."
  recovery_window_in_days = 0

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_secretsmanager_secret" "live_mysql" {
  count = local.ingestion_is_production ? 0 : 1

  name = local.ingestion_live_secret_name
  // Terraform cria somente o contêiner; as credenciais live permanecem externas.
  description             = "Contêiner das credenciais do MySQL live; o valor é preenchido fora do Terraform."
  recovery_window_in_days = 0

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

// A shared password is sufficient for isolated import Pods; manual backfills use
// their own per-Job Secret and never rotate this value while imports are active.
resource "random_password" "snapshot_mysql" {
  count   = local.ingestion_is_production ? 0 : 1
  length  = 48
  special = false
}
resource "aws_secretsmanager_secret_version" "snapshot_mysql" {
  count         = local.ingestion_is_production ? 0 : 1
  secret_id     = aws_secretsmanager_secret.snapshot_mysql[0].id
  secret_string = random_password.snapshot_mysql[0].result
}
