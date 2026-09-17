// Terraform possui o database Glue e o workgroup Athena; o runtime possui as
// tabelas e partições que materializam os dados canônicos.
resource "aws_glue_catalog_database" "ingestion" {
  name        = local.ingestion_glue_database
  description = "Catálogo dos dados canônicos da ingestão; tabelas e partições são criadas pelo runtime."

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}

resource "aws_athena_workgroup" "ingestion" {
  name          = local.ingestion_workgroup
  description   = "Consultas controladas sobre os dados canônicos da ingestão."
  state         = "ENABLED"
  force_destroy = !local.ingestion_is_production

  configuration {
    bytes_scanned_cutoff_per_query     = 1073741824
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = local.ingestion_athena_output_location

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }

  depends_on = [
    aws_s3_bucket_server_side_encryption_configuration.ingestion,
    aws_s3_bucket_public_access_block.ingestion,
  ]
}
