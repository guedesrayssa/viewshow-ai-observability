locals {
  flow_logs_bucket_arn = "arn:aws:s3:::${local.nome_bucket_flow_logs}"
}

resource "terraform_data" "flow_logs_bucket" {
  input = {
    bucket = local.nome_bucket_flow_logs
    regiao = var.regiao
  }

  triggers_replace = [local.nome_bucket_flow_logs]

  provisioner "local-exec" {
    command = "node ${abspath("${path.module}/scripts/gerenciar-bucket-flow-logs.mjs")}"

    environment = {
      ACTION = "create"
      BUCKET = self.input.bucket
      REGIAO = self.input.regiao
    }
  }

  provisioner "local-exec" {
    when    = destroy
    command = "node ${abspath("${path.module}/scripts/gerenciar-bucket-flow-logs.mjs")}"

    environment = {
      ACTION = "delete"
      BUCKET = self.input.bucket
      REGIAO = self.input.regiao
    }
  }
}

resource "aws_s3_bucket_public_access_block" "flow_logs" {
  bucket = local.nome_bucket_flow_logs

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [terraform_data.flow_logs_bucket]
}

resource "aws_s3_bucket_ownership_controls" "flow_logs" {
  bucket = local.nome_bucket_flow_logs

  rule {
    object_ownership = "BucketOwnerPreferred"
  }

  depends_on = [terraform_data.flow_logs_bucket]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "flow_logs" {
  bucket = local.nome_bucket_flow_logs

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

  depends_on = [terraform_data.flow_logs_bucket]
}

resource "aws_s3_bucket_lifecycle_configuration" "flow_logs" {
  bucket = local.nome_bucket_flow_logs

  rule {
    id     = "expirar-flow-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }

  depends_on = [terraform_data.flow_logs_bucket]
}

resource "aws_s3_bucket_policy" "flow_logs" {
  bucket = local.nome_bucket_flow_logs
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AWSLogDeliveryAclCheck"
        Effect = "Allow"
        Principal = {
          Service = "delivery.logs.amazonaws.com"
        }
        Action   = "s3:GetBucketAcl"
        Resource = local.flow_logs_bucket_arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.atual.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:logs:${var.regiao}:${data.aws_caller_identity.atual.account_id}:*"
          }
        }
      },
      {
        Sid    = "AWSLogDeliveryWrite"
        Effect = "Allow"
        Principal = {
          Service = "delivery.logs.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${local.flow_logs_bucket_arn}/vpc-flow-logs/AWSLogs/${data.aws_caller_identity.atual.account_id}/*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.atual.account_id
            "s3:x-amz-acl"      = "bucket-owner-full-control"
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:logs:${var.regiao}:${data.aws_caller_identity.atual.account_id}:*"
          }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.flow_logs]
}

resource "aws_flow_log" "vpc" {
  vpc_id                   = aws_vpc.principal.id
  traffic_type             = "ALL"
  log_destination_type     = "s3"
  log_destination          = "${local.flow_logs_bucket_arn}/vpc-flow-logs"
  max_aggregation_interval = 60

  destination_options {
    file_format                = "parquet"
    hive_compatible_partitions = false
    per_hour_partition         = true
  }

  depends_on = [aws_s3_bucket_policy.flow_logs]

  tags = {
    Name   = "${var.deployment_namespace}-vpc-flow-logs"
    Camada = "observabilidade"
  }
}
