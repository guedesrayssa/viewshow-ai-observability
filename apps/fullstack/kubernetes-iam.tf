resource "aws_iam_role_policy" "api_runtime" {
  count = local.eks_manages_iam ? 1 : 0
  role  = aws_iam_role.workload["api"].name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"], Resource = [aws_dynamodb_table.operacional.arn, "${aws_dynamodb_table.operacional.arn}/index/*", aws_dynamodb_table.golden_set.arn, "${aws_dynamodb_table.golden_set.arn}/index/*"] },
    { Effect = "Allow", Action = ["cognito-idp:InitiateAuth", "cognito-idp:RespondToAuthChallenge"], Resource = aws_cognito_user_pool.principal.arn },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.analysis.arn },
    { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:${data.aws_partition.current.partition}:bedrock:${var.regiao}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0" }
  ] })
}
resource "aws_iam_role_policy" "ingestion_runtime" {
  for_each = local.eks_manages_iam ? toset(["ingestion-backfill", "ingestion-sync"]) : toset([])
  role     = aws_iam_role.workload[each.key].name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"], Resource = [aws_dynamodb_table.operacional.arn, "${aws_dynamodb_table.operacional.arn}/index/*"] },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.analysis.arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:AbortMultipartUpload", "s3:GetObjectAttributes", "s3:GetObjectVersionAttributes"], Resource = "arn:aws:s3:::${local.ingestion_bucket_name}/*" },
    { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketVersioning"], Resource = "arn:aws:s3:::${local.ingestion_bucket_name}" },
    { Effect = "Allow", Action = ["glue:GetDatabase", "glue:GetTable", "glue:CreateTable", "glue:UpdateTable", "glue:GetPartitions", "glue:BatchCreatePartition", "glue:BatchGetPartition"], Resource = ["arn:aws:glue:${var.regiao}:${data.aws_caller_identity.atual.account_id}:catalog", aws_glue_catalog_database.ingestion.arn, "arn:aws:glue:${var.regiao}:${data.aws_caller_identity.atual.account_id}:table/${aws_glue_catalog_database.ingestion.name}/*"] },
    { Effect = "Allow", Action = ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution", "athena:GetWorkGroup"], Resource = aws_athena_workgroup.ingestion.arn }
  ] })
}
resource "aws_iam_role_policy" "analysis_runtime" {
  count = local.eks_manages_iam ? 1 : 0
  role  = aws_iam_role.workload["analysis-worker"].name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.analysis.arn },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.analysis_dlq.arn },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:BatchGetItem"], Resource = [aws_dynamodb_table.operacional.arn, "${aws_dynamodb_table.operacional.arn}/index/*"] },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["arn:aws:s3:::${local.ingestion_bucket_name}/analysis/*"] },
    { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:${data.aws_partition.current.partition}:bedrock:${var.regiao}::foundation-model/${var.analysis_llm_model_id}" }
  ] })
}
