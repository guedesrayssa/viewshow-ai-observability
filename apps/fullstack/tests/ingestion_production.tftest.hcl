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
  target          = aws_sqs_queue.analysis
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-analysis"
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-analysis"
  }
}

override_resource {
  target          = aws_dynamodb_table.operacional
  override_during = plan
  values = {
    arn = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional"
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

override_resource {
  target          = aws_sqs_queue.incremental_batches
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-incremental-batches.fifo"
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-incremental-batches.fifo"
  }
}

override_resource {
  target          = aws_scheduler_schedule.ingestion_sync
  override_during = plan
  values = {
    arn = "arn:aws:scheduler:us-east-1:123456789012:schedule/view-show-ingestion/view-show-ingestion-sync"
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

variables {
  deployment_namespace                     = "view-show"
  ambiente                                 = "production"
  imagem_ingestao                          = "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  imagem_mysql_snapshot                    = "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad"
  ecs_execution_role_arn_ingestao          = "arn:aws:iam::123456789012:role/ingestion-execution"
  ecs_task_role_arn_ingestao               = "arn:aws:iam::123456789012:role/ingestion-task"
  ecs_task_role_arn_importacao             = "arn:aws:iam::123456789012:role/ingestion-import-task"
  ecs_task_role_arn_exportacao_incremental = "arn:aws:iam::123456789012:role/ingestion-incremental-export-task"
  ecs_task_role_arn_ingestao_incremental   = "arn:aws:iam::123456789012:role/ingestion-incremental-ingest-task"
  api_task_role_arn                        = "arn:aws:iam::123456789012:role/application/api-task"
  scheduler_execution_role_arn_ingestao    = "arn:aws:iam::123456789012:role/ingestion-scheduler"
  snapshot_mysql_secret_arn_ingestao       = "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot"
  live_mysql_secret_arn_ingestao           = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live"
  force_destroy_bucket_ingestao            = false
  force_delete_ecr_ingestao                = false
}

run "production_hardened" {
  command = plan

  assert {
    condition = (
      aws_ecs_task_definition.api.task_role_arn == "arn:aws:iam::123456789012:role/application/api-task" &&
      length(aws_iam_role_policy.api_argus_live_sync) == 1 &&
      aws_iam_role_policy.api_argus_live_sync[0].role == "api-task" &&
      jsondecode(aws_iam_role_policy.api_argus_live_sync[0].policy) == {
        Version = "2012-10-17"
        Statement = [
          {
            Sid      = "ArgusLiveSyncState"
            Effect   = "Allow"
            Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
            Resource = aws_dynamodb_table.operacional.arn
          },
          {
            Sid      = "ArgusLiveSyncSchedule"
            Effect   = "Allow"
            Action   = ["scheduler:GetSchedule", "scheduler:UpdateSchedule"]
            Resource = aws_scheduler_schedule.ingestion_sync.arn
          },
          {
            Sid      = "PassArgusSchedulerRole"
            Effect   = "Allow"
            Action   = ["iam:PassRole"]
            Resource = "arn:aws:iam::123456789012:role/ingestion-scheduler"
            Condition = {
              StringEquals = {
                "iam:PassedToService" = "scheduler.amazonaws.com"
              }
            }
          },
        ]
      }
    )
    error_message = "Produção deve anexar à task role explícita da API somente o contrato necessário ao controle live do ARGUS."
  }

  assert {
    condition = alltrue([
      length(aws_s3_bucket_cors_configuration.ingestion) == 1,
      aws_s3_bucket_cors_configuration.ingestion[0].expected_bucket_owner == "123456789012",
      toset(one(aws_s3_bucket_cors_configuration.ingestion[0].cors_rule).allowed_origins) == toset(["https://producao.d111111abcdef8.amplifyapp.com"]),
      toset(one(aws_s3_bucket_cors_configuration.ingestion[0].cors_rule).allowed_methods) == toset(["PUT", "HEAD"]),
      toset(one(aws_s3_bucket_cors_configuration.ingestion[0].cors_rule).allowed_headers) == toset(["content-type", "x-amz-checksum-sha256"]),
      toset(one(aws_s3_bucket_cors_configuration.ingestion[0].cors_rule).expose_headers) == toset(["ETag", "x-amz-checksum-sha256"]),
      one(aws_s3_bucket_cors_configuration.ingestion[0].cors_rule).max_age_seconds == 900,
    ])
    error_message = "Produção deve configurar CORS nativo fechado para a origem Amplify exata."
  }

  assert {
    condition = alltrue([
      aws_ecs_task_definition.api.task_role_arn == "arn:aws:iam::123456789012:role/application/api-task",
      length(aws_iam_role_policy.api_import) == 1,
      length(aws_iam_role_policy.ingestion_import) == 1,
      aws_iam_role_policy.api_import[0].role == "api-task",
      aws_iam_role_policy.ingestion_import[0].role == "ingestion-import-task",
      aws_ecs_task_definition.ingestion_import.task_role_arn == "arn:aws:iam::123456789012:role/ingestion-import-task",
      aws_ecs_task_definition.ingestion_backfill.task_role_arn == "arn:aws:iam::123456789012:role/ingestion-task",
      aws_ecs_task_definition.ingestion_import.execution_role_arn == "arn:aws:iam::123456789012:role/ingestion-execution",
      aws_ecs_task_definition.ingestion_import.ephemeral_storage[0].size_in_gib == 200,
      length(jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions)) == 3,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container if container.name == "ingestion"]).command == ["import-dump"],
      [for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : merge(container, container.name == "ingestion" ? { command = ["backfill"] } : {})] == jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions),
      aws_ecs_task_definition.ingestion_import.volume == aws_ecs_task_definition.ingestion_backfill.volume,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container if container.name == "ingestion"]).environment[index(one([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container if container.name == "ingestion"]).environment[*].name, "ACTIVATE_CANDIDATE")].value == "false",
      output.ingestion_runbook.imports.disk_budget_bytes == 68719476736,
      output.ingestion_runbook.imports.iam_isolation_enforced == true,
      { for item in one(jsondecode(aws_ecs_task_definition.api.container_definitions)).environment : item.name => item.value if startswith(item.name, "IMPORT_") } == {
        IMPORT_BUCKET                        = "view-show-ingestion-123456789012-us-east-1"
        IMPORT_CANONICAL_FIRST_ENABLED       = "false"
        IMPORT_CURSOR_SECRET                 = random_password.cursor_secret.result
        IMPORT_EXPECTED_BUCKET_OWNER         = "123456789012"
        IMPORT_INGESTION_CLUSTER_ARN         = "arn:aws:ecs:us-east-1:123456789012:cluster/view-show-cluster"
        IMPORT_INGESTION_CONTAINER_NAME      = "ingestion"
        IMPORT_INGESTION_SECURITY_GROUP_ID   = "sg-ingestion"
        IMPORT_INGESTION_SUBNET_IDS          = "subnet-private-a,subnet-private-b"
        IMPORT_INGESTION_TASK_DEFINITION_ARN = "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-import"
      },
    ])
    error_message = "Produção deve usar a role explícita e injetar o contrato exato do reconciliador."
  }

  assert {
    condition = alltrue([
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : statement.Action
        if statement.Sid == "ImportRecordsAndControl"
        ])) == toset([
        "dynamodb:ConditionCheckItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
        if statement.Sid == "ImportRecordsAndControl"
        ])) == toset([
        "IMPORTS",
        "CONTROL#IMPORT",
        "IMPORT_IDEMPOTENCY#*",
        "IMPORT_RESTART#*",
        "IMPORT_COMPLETION#*",
      ]),
      !strcontains(aws_iam_role_policy.api_import[0].policy, "\"Resource\":\"*\""),
      strcontains(aws_iam_role_policy.api_import[0].policy, "arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-import:*"),
      !strcontains(aws_iam_role_policy.api_import[0].policy, aws_ecs_task_definition.ingestion_backfill.arn),
      strcontains(aws_iam_role_policy.api_import[0].policy, aws_ecs_cluster.principal.arn),
      strcontains(aws_iam_role_policy.api_import[0].policy, "arn:aws:iam::123456789012:role/ingestion-execution"),
      strcontains(aws_iam_role_policy.api_import[0].policy, "arn:aws:iam::123456789012:role/ingestion-import-task"),
      !strcontains(aws_iam_role_policy.api_import[0].policy, "arn:aws:iam::123456789012:role/ingestion-task"),
      strcontains(aws_iam_role_policy.api_import[0].policy, "staging/imports/*"),
      strcontains(aws_iam_role_policy.ingestion_import[0].policy, "staging/imports/*"),
      strcontains(aws_iam_role_policy.ingestion_import[0].policy, "dumps/*"),
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "ACTIVATE_CANDIDATE"),
      strcontains(aws_iam_role_policy.api_import[0].policy, "IMPORT_COMPLETION#*"),
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "IMPORT_COMPLETION#*"),
    ])
    error_message = "A policy da API deve autorizar as ações constituintes reais e restringir staging, ECS e PassRole aos recursos esperados."
  }

  assert {
    condition = alltrue([
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Action
        if statement.Sid == "WriteCandidateData"
        ])) == toset([
        "dynamodb:ConditionCheckItem",
        "dynamodb:DeleteItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
        if statement.Sid == "WriteCandidateData"
        ])) == toset([
        "IMPORTS",
        "CONTROL#IMPORT",
        "INGESTION#*",
        "DATASET#*",
        "CANDIDATE#DATASET#*",
      ]),
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition.Null["dynamodb:LeadingKeys"]
        if statement.Sid == "WriteCandidateData"
      ]) == "false",
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Action
        if statement.Sid == "ReadActiveManifest"
      ])) == toset(["dynamodb:GetItem"]),
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition.StringEquals["dynamodb:LeadingKeys"]
        if statement.Sid == "ReadActiveManifest"
      ]) == "CONTROL#DATASET",
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAnyValue:StringNotLike"]["dynamodb:LeadingKeys"]
        if statement.Sid == "DenyWritesOutsideCandidateNamespaces"
        ]) == [
        "IMPORTS",
        "CONTROL#IMPORT",
        "INGESTION#*",
        "DATASET#*",
        "CANDIDATE#DATASET#*",
      ],
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition.Null["dynamodb:LeadingKeys"]
        if statement.Sid == "DenyWritesWithoutLeadingKeys"
      ]) == "true",
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"]
        if statement.Sid == "DenyActiveManifestWrites"
      ]) == ["CONTROL#DATASET"],
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
        if statement.Sid == "DenyActiveManifestWrites"
      ])) == toset(["dynamodb:GetItem"]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
        if statement.Sid == "DenyWritesOutsideCandidateNamespaces"
        ])) == toset([
        "dynamodb:BatchGetItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
        if statement.Sid == "DenyWritesWithoutLeadingKeys"
        ])) == toset([
        "dynamodb:BatchGetItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
        if statement.Sid == "DenyUnapprovedCandidateActions"
        ])) == toset([
        "dynamodb:BatchGetItem",
        "dynamodb:ConditionCheckItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
      ]),
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "dynamodb:TransactWriteItems"),
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "dynamodb:TransactGetItems"),
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "dynamodb:BatchWriteItem"),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAnyValue:StringNotLike"]["dynamodb:LeadingKeys"]
        if statement.Sid == "DenyReadsOutsideImportNamespaces"
        ])) == toset([
        "IMPORTS",
        "CONTROL#IMPORT",
        "INGESTION#*",
        "DATASET#*",
        "CANDIDATE#DATASET#*",
        "CONTROL#DATASET",
      ]),
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition.Null["dynamodb:LeadingKeys"]
        if statement.Sid == "DenyReadsWithoutLeadingKeys"
      ]) == "true",
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Resource
        if statement.Sid == "DenyScanOperationalData"
        ])) == toset([
        "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional",
        "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/*",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
        if statement.Sid == "DenyNonQueryIndexActions"
      ])) == toset(["dynamodb:Query"]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotResource, [])
        if statement.Sid == "DenyQueryOutsidePendingOutboxIndex"
        ])) == toset([
        "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional",
        "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/outbox-pending-index",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Action
        if statement.Sid == "QueryPendingOutbox"
      ])) == toset(["dynamodb:Query"]),
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Resource
        if statement.Sid == "QueryPendingOutbox"
      ]) == ["arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/outbox-pending-index"],
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Action
        if statement.Sid == "UseIngestionCatalog"
        ])) == toset([
        "glue:CreatePartition",
        "glue:CreateTable",
        "glue:GetPartition",
        "glue:GetTable",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Action
        if statement.Sid == "UseIngestionAthenaWorkgroup"
        ])) == toset([
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StartQueryExecution",
      ]),
    ])
    error_message = "A role dedicada deve permitir somente os writes constituintes do candidato e negar ACTIVE, chaves externas e contexto ausente."
  }

  assert {
    condition = alltrue([
      // A policy externa sintética concede dynamodb:*; qualquer ação que não
      // pertença ao NotAction de ao menos uma deny aplicável continua DENY.
      alltrue([
        for action in [
          "dynamodb:ConditionCheckItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:PartiQLInsert",
          "dynamodb:PartiQLUpdate",
          "dynamodb:PartiQLDelete",
          "dynamodb:ExecuteStatement",
          "dynamodb:BatchExecuteStatement",
          "dynamodb:ExecuteTransaction",
          "dynamodb:TransactWriteItems",
          "dynamodb:FutureWriteItem",
          ] : !contains(one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
            if statement.Sid == "DenyActiveManifestWrites"
        ]), action)
      ]),
      contains(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
        if statement.Sid == "DenyActiveManifestWrites"
      ]), "dynamodb:GetItem"),
      alltrue([
        for action in [
          "dynamodb:ConditionCheckItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:PartiQLInsert",
          "dynamodb:PartiQLUpdate",
          "dynamodb:PartiQLDelete",
          "dynamodb:ExecuteStatement",
          "dynamodb:BatchExecuteStatement",
          "dynamodb:ExecuteTransaction",
          "dynamodb:TransactWriteItems",
          "dynamodb:FutureWriteItem",
          ] : !contains(one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
            if statement.Sid == "DenyWritesOutsideCandidateNamespaces"
        ]), action)
      ]),
      alltrue([
        for action in [
          "dynamodb:ConditionCheckItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:PartiQLInsert",
          "dynamodb:PartiQLUpdate",
          "dynamodb:PartiQLDelete",
          "dynamodb:ExecuteStatement",
          "dynamodb:BatchExecuteStatement",
          "dynamodb:ExecuteTransaction",
          "dynamodb:TransactWriteItems",
          "dynamodb:FutureWriteItem",
          ] : !contains(one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
            if statement.Sid == "DenyWritesWithoutLeadingKeys"
        ]), action)
      ]),
      alltrue([
        for action in [
          "dynamodb:BatchWriteItem",
          "dynamodb:PartiQLInsert",
          "dynamodb:PartiQLUpdate",
          "dynamodb:PartiQLDelete",
          "dynamodb:ExecuteStatement",
          "dynamodb:BatchExecuteStatement",
          "dynamodb:ExecuteTransaction",
          "dynamodb:TransactWriteItems",
          "dynamodb:FutureWriteItem",
          ] : !contains(one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
            if statement.Sid == "DenyUnapprovedCandidateActions"
        ]), action)
      ]),
      alltrue([
        for action in [
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          ] : contains(one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : try(statement.NotAction, [])
            if statement.Sid == "DenyUnapprovedCandidateActions"
        ]), action)
      ]),
    ])
    error_message = "Uma policy externa dynamodb:* não pode reabrir ACTIVE, namespaces externos/sem contexto ou ações de mutação fora do conjunto constituinte real."
  }

  assert {
    condition = alltrue([
      for request in [
        { name = "get mutable", action = "dynamodb:GetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["IMPORTS"], has_keys = true, denied = false },
        { name = "batch get mutable", action = "dynamodb:BatchGetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["IMPORTS", "DATASET#dsv_1#SIGNAL"], has_keys = true, denied = false },
        { name = "query mutable", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["INGESTION#RUN#run-1"], has_keys = true, denied = false },
        { name = "put candidate", action = "dynamodb:PutItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["CANDIDATE#DATASET#dsv_1"], has_keys = true, denied = false },
        { name = "get active", action = "dynamodb:GetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["CONTROL#DATASET"], has_keys = true, denied = false },
        { name = "write active", action = "dynamodb:PutItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["CONTROL#DATASET"], has_keys = true, denied = true },
        { name = "batch get active", action = "dynamodb:BatchGetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["CONTROL#DATASET"], has_keys = true, denied = true },
        { name = "query active", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["CONTROL#DATASET"], has_keys = true, denied = true },
        { name = "get completion ledger", action = "dynamodb:GetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["IMPORT_COMPLETION#import-1"], has_keys = true, denied = true },
        { name = "batch get mixed outside", action = "dynamodb:BatchGetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["IMPORTS", "TENANT#other"], has_keys = true, denied = true },
        { name = "query outside", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["TENANT#other"], has_keys = true, denied = true },
        { name = "get missing context", action = "dynamodb:GetItem", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = [], has_keys = false, denied = true },
        { name = "query missing context", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = [], has_keys = false, denied = true },
        { name = "scan table", action = "dynamodb:Scan", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["IMPORTS"], has_keys = true, denied = true },
        { name = "future table action", action = "dynamodb:FutureReadWrite", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional", keys = ["IMPORTS"], has_keys = true, denied = true },
        { name = "query outbox index", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/outbox-pending-index", keys = [], has_keys = false, denied = false },
        { name = "scan outbox index", action = "dynamodb:Scan", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/outbox-pending-index", keys = [], has_keys = false, denied = true },
        { name = "future outbox action", action = "dynamodb:FutureIndexRead", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/outbox-pending-index", keys = [], has_keys = false, denied = true },
        { name = "query trace index", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/trace-index", keys = [], has_keys = false, denied = true },
        { name = "scan trace index", action = "dynamodb:Scan", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/trace-index", keys = [], has_keys = false, denied = true },
        { name = "query future index", action = "dynamodb:Query", resource = "arn:aws:dynamodb:us-east-1:123456789012:table/view-show-operacional/index/future-index", keys = [], has_keys = false, denied = true },
        ] : anytrue([
          for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement :
          statement.Effect == "Deny" &&
          (
            (length(try(statement.Action, [])) > 0 && contains(try(statement.Action, []), request.action)) ||
            (length(try(statement.NotAction, [])) > 0 && !contains(try(statement.NotAction, []), request.action))
          ) &&
          (
            (length(try(statement.Resource, [])) > 0 && anytrue([
              for pattern in try(statement.Resource, []) : endswith(pattern, "*") ? startswith(request.resource, trimsuffix(pattern, "*")) : request.resource == pattern
            ])) ||
            (length(try(statement.NotResource, [])) > 0 && alltrue([
              for pattern in try(statement.NotResource, []) : endswith(pattern, "*") ? !startswith(request.resource, trimsuffix(pattern, "*")) : request.resource != pattern
            ]))
          ) &&
          (
            length(try(statement.Condition["ForAnyValue:StringNotLike"]["dynamodb:LeadingKeys"], [])) == 0 ||
            (request.has_keys && anytrue([
              for key in request.keys : alltrue([
                for pattern in try(statement.Condition["ForAnyValue:StringNotLike"]["dynamodb:LeadingKeys"], []) : endswith(pattern, "*") ? !startswith(key, trimsuffix(pattern, "*")) : key != pattern
              ])
            ]))
          ) &&
          (
            length(try(statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"], [])) == 0 ||
            (request.has_keys && anytrue([
              for key in request.keys : anytrue([
                for pattern in try(statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"], []) : endswith(pattern, "*") ? startswith(key, trimsuffix(pattern, "*")) : key == pattern
              ])
            ]))
          ) &&
          (
            length(try(statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], [])) == 0 ||
            (request.has_keys && alltrue([
              for key in request.keys : anytrue([
                for pattern in try(statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], []) : endswith(pattern, "*") ? startswith(key, trimsuffix(pattern, "*")) : key == pattern
              ])
            ]))
          ) &&
          (
            try(statement.Condition.Null["dynamodb:LeadingKeys"], null) == null ||
            (try(statement.Condition.Null["dynamodb:LeadingKeys"], null) == "true" ? !request.has_keys : request.has_keys)
          )
      ]) == request.denied
    ])
    error_message = "A composição com dynamodb:* deve aplicar explicit deny por ação, recurso e LeadingKeys, permitindo somente reads/writes reais e Query no outbox-pending-index."
  }

  assert {
    condition = alltrue([
      one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : try(statement.NotResource, [])
        if statement.Sid == "DenyOtherImportTasks"
      ]) == ["arn:aws:ecs:us-east-1:123456789012:task-definition/view-show-ingestion-import:*"],
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : try(statement.NotResource, [])
        if statement.Sid == "DenyOtherPassedRoles"
        ])) == toset([
        "arn:aws:iam::123456789012:role/ingestion-execution",
        "arn:aws:iam::123456789012:role/ingestion-import-task",
      ]),
      !contains(one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : try(statement.NotResource, [])
        if statement.Sid == "DenyOtherImportTasks"
      ]), aws_ecs_task_definition.ingestion_backfill.arn),
      !contains(one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : try(statement.NotResource, [])
        if statement.Sid == "DenyOtherPassedRoles"
      ]), "arn:aws:iam::123456789012:role/ingestion-task"),
      one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : try(statement.Condition.ArnNotEquals["ecs:cluster"], null)
        if statement.Sid == "DenyImportTaskOutsideCluster"
      ]) == aws_ecs_cluster.principal.arn,
      one([
        for statement in jsondecode(aws_iam_role_policy.api_import[0].policy).Statement : try(statement.Condition.StringNotEquals["iam:PassedToService"], null)
        if statement.Sid == "DenyImportRolesToOtherServices"
      ]) == "ecs-tasks.amazonaws.com",
    ])
    error_message = "Allows externas ecs:* e iam:PassRole devem continuar negadas para qualquer task ou role fora do runtime de importação."
  }

  assert {
    condition = alltrue([
      alltrue([
        for key in ["IMPORTS", "CONTROL#IMPORT", "INGESTION#RUN#run-1", "DATASET#dsv_1#SIGNAL", "CANDIDATE#DATASET#dsv_1"] : anytrue([
          for pattern in one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
            if statement.Sid == "WriteCandidateData"
          ]) : endswith(pattern, "*") ? startswith(key, trimsuffix(pattern, "*")) : key == pattern
        ])
      ]),
      !alltrue([
        for key in ["CANDIDATE#DATASET#dsv_1", "CONTROL#DATASET", "INGESTION#IDEMPOTENCY#activation"] : anytrue([
          for pattern in one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
            if statement.Sid == "WriteCandidateData"
          ]) : endswith(pattern, "*") ? startswith(key, trimsuffix(pattern, "*")) : key == pattern
        ])
      ]),
      !alltrue([
        for key in ["IMPORTS", "TENANT#other"] : anytrue([
          for pattern in one([
            for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
            if statement.Sid == "WriteCandidateData"
          ]) : endswith(pattern, "*") ? startswith(key, trimsuffix(pattern, "*")) : key == pattern
        ])
      ]),
    ])
    error_message = "Os vetores de LeadingKeys devem autorizar o fluxo candidato e negar transações mistas com ACTIVE ou namespaces externos."
  }

  assert {
    condition = alltrue([
      toset(try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "UseArchiveStagingObjects"
        ]).Action, [])) == toset([
        "s3:AbortMultipartUpload",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
      ]),
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "UseArchiveStagingObjects"
        ]).Resource, []) == [
        "arn:aws:s3:::view-show-ingestion-123456789012-us-east-1/staging/run_id=*/dataset=*/date=*/*.parquet",
      ],
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "arn:aws:s3:::view-show-ingestion-123456789012-us-east-1/staging/*"),
      !strcontains(aws_iam_role_policy.ingestion_import[0].policy, "s3:DeleteObject"),
    ])
    error_message = "A task role do worker deve cobrir somente o layout real de staging Parquet e suas operações reais de stage/HEAD/promotion."
  }

  assert {
    condition = alltrue([
      toset(try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "LocateAthenaResultsBucket"
      ]).Action, [])) == toset(["s3:GetBucketLocation", "s3:GetBucketVersioning"]),
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "LocateAthenaResultsBucket"
      ]).Resource, []) == ["arn:aws:s3:::view-show-ingestion-123456789012-us-east-1"],
      toset(try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "ListAthenaResultsPrefix"
      ]).Action, [])) == toset(["s3:ListBucket"]),
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "ListAthenaResultsPrefix"
      ]).Resource, []) == ["arn:aws:s3:::view-show-ingestion-123456789012-us-east-1"],
      toset(try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "ListAthenaResultsPrefix"
        ]).Condition.StringLike["s3:prefix"], [])) == toset([
        "athena-results/",
        "athena-results/*",
      ]),
      toset(try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "UseAthenaResultObjects"
        ]).Action, [])) == toset([
        "s3:AbortMultipartUpload",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListMultipartUploadParts",
        "s3:PutObject",
      ]),
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "UseAthenaResultObjects"
        ]).Resource, []) == [
        "arn:aws:s3:::view-show-ingestion-123456789012-us-east-1/athena-results/*",
      ],
    ])
    error_message = "A task role do worker deve conceder ao Athena somente localização do bucket, listagem do prefixo configurado e multipart nos objetos de resultado."
  }

  assert {
    condition = alltrue([
      length(aws_iam_role_policy.ingestion_incremental_export) == 1,
      length(aws_iam_role_policy.ingestion_incremental_ingest) == 1,
      length(aws_iam_role_policy.ingestion_incremental_scheduler) == 1,
      aws_iam_role_policy.ingestion_incremental_export[0].role == "ingestion-incremental-export-task",
      aws_iam_role_policy.ingestion_incremental_ingest[0].role == "ingestion-incremental-ingest-task",
      aws_iam_role_policy.ingestion_incremental_scheduler[0].role == "ingestion-scheduler",
      aws_ecs_task_definition.ingestion_incremental_export.task_role_arn == "arn:aws:iam::123456789012:role/ingestion-incremental-export-task",
      aws_ecs_task_definition.ingestion_incremental_ingest.task_role_arn == "arn:aws:iam::123456789012:role/ingestion-incremental-ingest-task",
      !strcontains(aws_iam_role_policy.ingestion_incremental_export[0].policy, "\"Resource\":\"*\""),
      !strcontains(aws_iam_role_policy.ingestion_incremental_ingest[0].policy, "\"Resource\":\"*\""),
      !strcontains(lower(aws_iam_role_policy.ingestion_incremental_ingest[0].policy), "secretsmanager"),
      !strcontains(aws_iam_role_policy.ingestion_incremental_ingest[0].policy, "arn:aws:secretsmanager:us-east-1:123456789012:secret:live"),
    ])
    error_message = "Produção deve separar as roles incrementais e manter o consumidor sem segredos live."
  }

  assert {
    condition = alltrue([
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : statement.Resource
        if statement.Sid == "UseIncrementalRawObjects"
      ]), "") == "arn:aws:s3:::view-show-ingestion-123456789012-us-east-1/raw/argus/incremental/*",
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : statement.Resource
        if statement.Sid == "SendIncrementalBatchReference"
      ]), "") == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-incremental-batches.fifo",
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_ingest[0].policy).Statement : statement.Resource
        if statement.Sid == "ConsumeIncrementalBatchReferences"
      ]), "") == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-incremental-batches.fifo",
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_ingest[0].policy).Statement : statement.Resource
        if statement.Sid == "PublishAnalysisRequests"
      ]), "") == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-analysis",
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_scheduler[0].policy).Statement : statement.Resource
        if statement.Sid == "SendSchedulerDeadLetters"
      ]), "") == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-scheduler-dlq",
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_scheduler[0].policy).Statement : statement.Action
        if statement.Sid == "SendSchedulerDeadLetters"
      ]), []) == ["sqs:SendMessage"],
      !strcontains(aws_iam_role_policy.ingestion_incremental_export[0].policy, "dynamodb:TransactWriteItems"),
      !strcontains(aws_iam_role_policy.ingestion_incremental_ingest[0].policy, "dynamodb:TransactWriteItems"),
    ])
    error_message = "Produção deve limitar os recursos S3/SQS incrementais e evitar transações amplas."
  }

  assert {
    condition = alltrue([
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : statement.Action
        if statement.Sid == "ReadExportControlItems"
      ])) == toset(["dynamodb:GetItem"]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : try(statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], [])
        if statement.Sid == "ReadExportControlItems"
        ])) == toset([
        "CONTROL#DATASET",
        "DATASET#*#INGESTION#SOURCE#export:signal_bucket",
        "INGESTION#SOURCE#EXPORT_INCREMENTAL",
        "INGESTION#IDEMPOTENCY#lease-acquire#*",
        "INGESTION#IDEMPOTENCY#lease-release#*",
        "INGESTION#IDEMPOTENCY#window-commit#*",
      ]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : statement.Action
        if statement.Sid == "PutExportControlItems"
      ])) == toset(["dynamodb:PutItem"]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : statement.Action
        if statement.Sid == "DeleteExportLease"
      ])) == toset(["dynamodb:DeleteItem"]),
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_export[0].policy).Statement : try(statement.Condition.StringEquals["dynamodb:LeadingKeys"], null)
        if statement.Sid == "DeleteExportLease"
      ]) == "INGESTION#SOURCE#EXPORT_INCREMENTAL",
    ])
    error_message = "Produção deve restringir o controle DynamoDB da exportação incremental."
  }

  assert {
    condition = alltrue([
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_ingest[0].policy).Statement : statement.Action
        if statement.Sid == "ReadIncrementalOperationalData"
      ])) == toset(["dynamodb:BatchGetItem", "dynamodb:GetItem"]),
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_ingest[0].policy).Statement : statement.Action
        if statement.Sid == "QueryIncrementalHotPartitions"
      ])) == toset(["dynamodb:Query"]),
      one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_ingest[0].policy).Statement : statement.Resource
        if statement.Sid == "QueryIncrementalOutbox"
      ]) == "${aws_dynamodb_table.operacional.arn}/index/outbox-pending-index",
      !strcontains(aws_iam_role_policy.ingestion_incremental_ingest[0].policy, "/index/*"),
      alltrue([
        for statement in jsondecode(aws_iam_role_policy.ingestion_incremental_ingest[0].policy).Statement :
        try(statement.Condition.Null["dynamodb:LeadingKeys"], null) == "false"
        if contains([
          "ReadIncrementalOperationalData",
          "QueryIncrementalHotPartitions",
          "QueryIncrementalOutbox",
          "PutIncrementalOperationalData",
          "UpdateIncrementalOperationalData",
          "DeleteIncrementalLease",
          "CheckIncrementalRetentionGate",
        ], statement.Sid)
      ]),
    ])
    error_message = "Produção deve restringir as ações e chaves DynamoDB da ingestão incremental."
  }

  assert {
    condition = alltrue([
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_incremental_export.container_definitions) : container if container.name == "ingestion"]).command == ["export-incremental"],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_incremental_ingest.container_definitions) : container if container.name == "ingestion"]).command == ["ingest-incremental", "--limit", "20"],
      toset(one([for container in jsondecode(aws_ecs_task_definition.ingestion_incremental_export.container_definitions) : container if container.name == "ingestion"]).secrets[*].name) == toset(["LIVE_MYSQL_HOST", "LIVE_MYSQL_PORT", "LIVE_MYSQL_USER", "LIVE_MYSQL_PASSWORD", "LIVE_MYSQL_DATABASE"]),
      try(length(one([for container in jsondecode(aws_ecs_task_definition.ingestion_incremental_ingest.container_definitions) : container if container.name == "ingestion"]).secrets), 0) == 0,
      contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_incremental_export.container_definitions) : container if container.name == "ingestion"]).environment, { name = "INCREMENTAL_BATCH_BUCKET", value = "view-show-ingestion-123456789012-us-east-1" }),
      contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_incremental_ingest.container_definitions) : container if container.name == "ingestion"]).environment, { name = "INCREMENTAL_BATCH_QUEUE_URL", value = "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-incremental-batches.fifo" }),
    ])
    error_message = "As task definitions incrementais devem consumir exatamente as interfaces da Task 6 e isolar segredos live no export."
  }

  assert {
    condition = alltrue([
      !local.ingestion_s3_learner_lab_compat_enabled,
      length(aws_s3_bucket.ingestion) == 1,
      length(terraform_data.ingestion_bucket_learner_lab) == 0,
      !aws_s3_bucket.ingestion[0].force_destroy,
      !aws_ecr_repository.ingestion.force_delete,
      local.ingestion_canonical_prefix == "canonical/",
      local.ingestion_incremental_raw_prefix == "raw/argus/incremental/",
      local.ingestion_lifecycle_prefixes == ["raw/argus/incremental/", "dumps/", "staging/", "athena-results/"],
      local.ingestion_lifecycle_prefixes_non_overlapping,
      local.ingestion_lifecycle_prefixes_isolated_from_canonical,
      local.ingestion_lifecycle_rules_isolated_from_canonical,
      local.ingestion_incremental_raw_prefix_isolated,
      local.ingestion_lifecycle_rules["staging-canonical-expiration"].prefix == "staging/canonical/",
      local.ingestion_lifecycle_rules["staging-canonical-expiration"].expiration_days == 7,
      local.ingestion_lifecycle_rules["staging-canonical-expiration"].abort_multipart_days == 1,
      local.ingestion_lifecycle_rules["raw-argus-incremental"].expiration_days > 0,
      local.ingestion_lifecycle_rules["raw-argus-incremental"].noncurrent_expiration_days > 0,
      local.ingestion_lifecycle_rules["raw-argus-incremental"].expiration_days + local.ingestion_lifecycle_rules["raw-argus-incremental"].noncurrent_expiration_days <= var.retencao_raw_incremental_ingestao_dias,
    ])
    error_message = "Produção deve preservar bucket e imagens no destroy."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket.ingestion[0].bucket == "view-show-ingestion-123456789012-us-east-1",
      aws_s3_bucket_versioning.ingestion.bucket == aws_s3_bucket.ingestion[0].bucket,
      aws_s3_bucket_server_side_encryption_configuration.ingestion.bucket == aws_s3_bucket.ingestion[0].bucket,
      aws_s3_bucket_public_access_block.ingestion.bucket == aws_s3_bucket.ingestion[0].bucket,
      aws_s3_bucket_lifecycle_configuration.ingestion.bucket == aws_s3_bucket.ingestion[0].bucket,
      output.ingestion_runbook.storage.bucket == aws_s3_bucket.ingestion[0].bucket,
      one([for item in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : item if item.name == "ingestion"]).environment[index(one([for item in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : item if item.name == "ingestion"]).environment[*].name, "ARCHIVE_BUCKET")].value == aws_s3_bucket.ingestion[0].bucket,
    ])
    error_message = "Produção deve continuar gerenciando o bucket nativamente e preservar as referências de configuração, runtime e output."
  }

  assert {
    condition     = !aws_athena_workgroup.ingestion.force_destroy
    error_message = "Produção deve preservar consultas nomeadas do Athena no destroy."
  }

  assert {
    condition = alltrue([
      local.ingestion_vpc_id == "vpc-dedicated",
      toset(local.ingestion_subnet_ids) == toset(["subnet-private-a", "subnet-private-b"]),
      !local.ingestion_assign_public_ip,
      local.ingestion_ecs_execution_role_arn == "arn:aws:iam::123456789012:role/ingestion-execution",
      local.ingestion_ecs_task_role_arn == "arn:aws:iam::123456789012:role/ingestion-task",
      local.ingestion_incremental_export_task_role_arn == "arn:aws:iam::123456789012:role/ingestion-incremental-export-task",
      local.ingestion_incremental_ingest_task_role_arn == "arn:aws:iam::123456789012:role/ingestion-incremental-ingest-task",
      local.ingestion_scheduler_execution_role_arn == "arn:aws:iam::123456789012:role/ingestion-scheduler",
      local.ingestion_snapshot_mysql_secret_arn == "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot",
      local.ingestion_live_mysql_secret_arn == "arn:aws:secretsmanager:us-east-1:123456789012:secret:live",
    ])
    error_message = "Produção deve usar a rede privada dedicada e consumir roles e segredos fornecidos."
  }

  assert {
    condition     = length(aws_secretsmanager_secret.snapshot_mysql) == 0 && length(aws_secretsmanager_secret.live_mysql) == 0
    error_message = "Produção não deve criar segredos paralelos quando os ARNs existentes são obrigatórios."
  }

  assert {
    condition = alltrue([
      !var.incremental_s3_enabled,
      aws_scheduler_schedule.ingestion_incremental_export.state == "DISABLED",
      aws_scheduler_schedule.ingestion_incremental_ingest.state == "DISABLED",
      aws_scheduler_schedule.ingestion_incremental_export.schedule_expression == "rate(15 minutes)",
      aws_scheduler_schedule.ingestion_incremental_ingest.schedule_expression == "rate(5 minutes)",
    ])
    error_message = "Mesmo em produção, export e ingest S3 incrementais devem nascer explicitamente desligados."
  }
}

run "production_rejects_empty_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = ""
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "production_rejects_canonical_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "canonical/archive/"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_overlapping_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "dumps/athena/"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_athena_path_traversal" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "reports/../canonical/"
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "production_rejects_control_character_in_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "athena-\nresults/"
  }

  expect_failures = [var.prefixo_resultados_athena_ingestao]
}

run "production_accepts_isolated_custom_athena_prefix" {
  command = plan

  variables {
    prefixo_resultados_athena_ingestao = "query-results/production/"
  }

  assert {
    condition = alltrue([
      local.ingestion_athena_results_prefix == "query-results/production/",
      local.ingestion_lifecycle_rules["athena-results"].prefix == "query-results/production/",
      aws_athena_workgroup.ingestion.configuration[0].result_configuration[0].output_location == "s3://view-show-ingestion-123456789012-us-east-1/query-results/production/",
      toset(try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "ListAthenaResultsPrefix"
        ]).Condition.StringLike["s3:prefix"], [])) == toset([
        "query-results/production/",
        "query-results/production/*",
      ]),
      try(one([
        for statement in jsondecode(aws_iam_role_policy.ingestion_import[0].policy).Statement : statement
        if statement.Sid == "UseAthenaResultObjects"
        ]).Resource, []) == [
        "arn:aws:s3:::view-show-ingestion-123456789012-us-east-1/query-results/production/*",
      ],
    ])
    error_message = "Produção deve aceitar um prefixo Athena relativo, isolado e canônico em runtime, lifecycle e IAM."
  }
}

run "production_rejects_mutable_ingestion_image" {
  command = plan

  variables {
    imagem_ingestao = "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion:latest"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_mutable_mysql_image" {
  command = plan

  variables {
    imagem_mysql_snapshot = "mysql:8.4"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_requires_ecs_execution_role" {
  command = plan

  variables {
    ecs_execution_role_arn_ingestao = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_requires_ecs_task_role" {
  command = plan

  variables {
    ecs_task_role_arn_ingestao = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_requires_import_task_role" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_import_role_from_another_account" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws:iam::999999999999:role/ingestion-import-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_import_role_from_another_partition" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws-us-gov:iam::123456789012:role/ingestion-import-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_wildcard_import_role" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws:iam::123456789012:role/*"
  }

  expect_failures = [var.ecs_task_role_arn_importacao]
}

run "production_rejects_import_role_equal_to_api_role" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws:iam::123456789012:role/application/api-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_import_role_equal_to_execution_role" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws:iam::123456789012:role/ingestion-execution"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_import_role_equal_to_scheduler_role" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws:iam::123456789012:role/ingestion-scheduler"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_import_role_equal_to_general_worker_role" {
  command = plan

  variables {
    ecs_task_role_arn_importacao = "arn:aws:iam::123456789012:role/ingestion-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_requires_api_task_role" {
  command = plan

  variables {
    api_task_role_arn = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_invalid_api_task_role" {
  command = plan

  variables {
    api_task_role_arn = "not-an-arn"
  }

  expect_failures = [var.api_task_role_arn]
}

run "production_rejects_wildcard_api_task_role" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws:iam::123456789012:role/*"
  }

  expect_failures = [var.api_task_role_arn]
}

run "production_rejects_empty_api_role_path" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws:iam::123456789012:role/"
  }

  expect_failures = [var.api_task_role_arn]
}

run "production_rejects_api_role_whitespace" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws:iam::123456789012:role/application/api task"
  }

  expect_failures = [var.api_task_role_arn]
}

run "production_rejects_api_role_trailing_slash" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws:iam::123456789012:role/application/api-task/"
  }

  expect_failures = [var.api_task_role_arn]
}

run "production_rejects_api_role_trailing_junk" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws:iam::123456789012:role/application/api-task:extra"
  }

  expect_failures = [var.api_task_role_arn]
}

run "production_rejects_api_role_from_another_account" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws:iam::999999999999:role/application/api-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_api_role_from_another_partition" {
  command = plan

  variables {
    api_task_role_arn = "arn:aws-us-gov:iam::123456789012:role/application/api-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_worker_role_from_another_account" {
  command = plan

  variables {
    ecs_task_role_arn_ingestao = "arn:aws:iam::999999999999:role/application/ingestion-task"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_wildcard_worker_role" {
  command = plan

  variables {
    ecs_task_role_arn_ingestao = "arn:aws:iam::123456789012:role/*"
  }

  expect_failures = [var.ecs_task_role_arn_ingestao]
}

run "production_rejects_execution_role_from_another_partition" {
  command = plan

  variables {
    ecs_execution_role_arn_ingestao = "arn:aws-us-gov:iam::123456789012:role/application/ingestion-execution"
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_scheduler_role_trailing_slash" {
  command = plan

  variables {
    scheduler_execution_role_arn_ingestao = "arn:aws:iam::123456789012:role/application/ingestion-scheduler/"
  }

  expect_failures = [var.scheduler_execution_role_arn_ingestao]
}

run "production_accepts_concrete_api_role_with_path" {
  command = plan

  variables {
    api_task_role_arn            = "arn:aws:iam::123456789012:role/application/security/api-task"
    ecs_task_role_arn_ingestao   = "arn:aws:iam::123456789012:role/application/data/ingestion-task"
    ecs_task_role_arn_importacao = "arn:aws:iam::123456789012:role/application/data/ingestion-import-task"
  }

  assert {
    condition = alltrue([
      local.api_task_role_name == "api-task",
      local.ingestion_ecs_task_role_name == "ingestion-task",
      local.ingestion_import_task_role_name == "ingestion-import-task",
      aws_ecs_task_definition.api.task_role_arn == "arn:aws:iam::123456789012:role/application/security/api-task",
      aws_ecs_task_definition.ingestion_backfill.task_role_arn == "arn:aws:iam::123456789012:role/application/data/ingestion-task",
      aws_ecs_task_definition.ingestion_import.task_role_arn == "arn:aws:iam::123456789012:role/application/data/ingestion-import-task",
      aws_iam_role_policy.api_import[0].role == "api-task",
      aws_iam_role_policy.ingestion_import[0].role == "ingestion-import-task",
    ])
    error_message = "Um ARN concreto com path deve preservar o ARN da task e extrair somente o RoleName para a inline policy."
  }
}

run "production_requires_scheduler_execution_role" {
  command = plan

  variables {
    scheduler_execution_role_arn_ingestao = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_requires_snapshot_mysql_secret_arn" {
  command = plan

  variables {
    snapshot_mysql_secret_arn_ingestao = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_requires_live_mysql_secret_arn" {
  command = plan

  variables {
    live_mysql_secret_arn_ingestao = null
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_force_destroy_bucket" {
  command = plan

  variables {
    force_destroy_bucket_ingestao = true
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_force_delete_ecr" {
  command = plan

  variables {
    force_delete_ecr_ingestao = true
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_learner_lab_s3_compatibility" {
  command = plan

  variables {
    compatibilidade_s3_learner_lab = true
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_rejects_incremental_s3_without_live_integration_gate" {
  command = plan

  variables {
    incremental_s3_enabled = true
    live_sync_enabled      = false
  }

  expect_failures = [
    terraform_data.ingestion_guardrails,
    aws_scheduler_schedule.ingestion_incremental_export,
    aws_scheduler_schedule.ingestion_incremental_ingest,
  ]
}

run "production_runtime_uses_immutable_images_and_scheduler_network" {
  command = plan

  variables {
    scheduler_ingestao_habilitado = true
    live_sync_enabled             = true
    incremental_s3_enabled        = true
  }

  assert {
    condition = alltrue([
      aws_ecs_task_definition.ingestion_backfill.execution_role_arn == "arn:aws:iam::123456789012:role/ingestion-execution",
      aws_ecs_task_definition.ingestion_backfill.task_role_arn == "arn:aws:iam::123456789012:role/ingestion-task",
      aws_ecs_task_definition.ingestion_sync.execution_role_arn == "arn:aws:iam::123456789012:role/ingestion-execution",
      aws_ecs_task_definition.ingestion_sync.task_role_arn == "arn:aws:iam::123456789012:role/ingestion-task",
      aws_ecs_task_definition.ingestion_backfill.runtime_platform[0].operating_system_family == "LINUX",
      aws_ecs_task_definition.ingestion_backfill.runtime_platform[0].cpu_architecture == "X86_64",
      aws_ecs_task_definition.ingestion_sync.runtime_platform[0].cpu_architecture == "X86_64",
      aws_ecs_task_definition.ingestion_sync.runtime_platform[0].operating_system_family == "LINUX",
      toset(aws_ecs_task_definition.ingestion_backfill.requires_compatibilities) == toset(["FARGATE"]),
      toset(aws_ecs_task_definition.ingestion_sync.requires_compatibilities) == toset(["FARGATE"]),
      aws_ecs_task_definition.ingestion_backfill.cpu == "2048",
      aws_ecs_task_definition.ingestion_backfill.memory == "8192",
      aws_ecs_task_definition.ingestion_backfill.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_sync.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_incremental_export.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_incremental_ingest.ephemeral_storage[0].size_in_gib == 200,
      aws_ecs_task_definition.ingestion_sync.cpu == "1024",
      aws_ecs_task_definition.ingestion_sync.memory == "2048",
      aws_scheduler_schedule.ingestion_sync.state == "ENABLED",
      aws_scheduler_schedule.ingestion_incremental_export.state == "ENABLED",
      aws_scheduler_schedule.ingestion_incremental_ingest.state == "ENABLED",
      aws_scheduler_schedule.ingestion_sync.target[0].role_arn == "arn:aws:iam::123456789012:role/ingestion-scheduler",
      aws_scheduler_schedule.ingestion_incremental_export.target[0].role_arn == "arn:aws:iam::123456789012:role/ingestion-scheduler",
      aws_scheduler_schedule.ingestion_incremental_ingest.target[0].role_arn == "arn:aws:iam::123456789012:role/ingestion-scheduler",
      aws_scheduler_schedule.ingestion_sync.target[0].dead_letter_config[0].arn == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-scheduler-dlq",
      aws_scheduler_schedule.ingestion_incremental_export.target[0].dead_letter_config[0].arn == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-scheduler-dlq",
      aws_scheduler_schedule.ingestion_incremental_ingest.target[0].dead_letter_config[0].arn == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-scheduler-dlq",
      aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].launch_type == "FARGATE",
      aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].platform_version == "1.4.0",
      !aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].network_configuration[0].assign_public_ip,
      toset(aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].network_configuration[0].subnets) == toset(["subnet-private-a", "subnet-private-b"]),
      toset(aws_scheduler_schedule.ingestion_sync.target[0].ecs_parameters[0].network_configuration[0].security_groups) == toset(["sg-ingestion"]),
      toset(aws_scheduler_schedule.ingestion_incremental_export.target[0].ecs_parameters[0].network_configuration[0].security_groups) == toset(["sg-ingestion"]),
      toset(aws_scheduler_schedule.ingestion_incremental_ingest.target[0].ecs_parameters[0].network_configuration[0].security_groups) == toset(["sg-ingestion"]),
      length(aws_cloudwatch_metric_alarm.ingestion_sync_absence) == 1,
      aws_cloudwatch_metric_alarm.ingestion_sync_absence[0].metric_name == "Runs",
      aws_cloudwatch_metric_alarm.ingestion_sync_absence[0].treat_missing_data == "breaching",
      aws_cloudwatch_metric_alarm.scheduler_target_errors.namespace == "AWS/Scheduler",
      aws_cloudwatch_metric_alarm.scheduler_target_errors.metric_name == "TargetErrorCount",
    ])
    error_message = "Produção deve preservar a seed inicial habilitada do Scheduler e executar a task sync somente com rede privada e Fargate 1.4.0+."
  }

  assert {
    condition = alltrue([
      contains(local.ingestion_import_environment, { name = "ARCHIVE_BUCKET_OWNER", value = "123456789012" }),
      contains(local.ingestion_import_environment, { name = "INGESTION_DISK_BUDGET_BYTES", value = "68719476736" }),
      contains(local.ingestion_import_environment, { name = "IMPORT_HOT_MATERIALIZATION_ENABLED", value = "false" }),
      contains(local.ingestion_import_environment, { name = "ACTIVATE_CANDIDATE", value = "false" }),
      contains(one([for container in jsondecode(aws_ecs_task_definition.api.container_definitions) : container if container.name == "view-show-api"]).environment, { name = "IMPORT_CANONICAL_FIRST_ENABLED", value = "false" }),
      var.import_canonical_first_enabled == false,
      var.import_hot_materialization_enabled == false,
      var.import_canonical_first_production_approved == false,
      output.ingestion_runbook.imports.api_task_role_arn == "arn:aws:iam::123456789012:role/application/api-task",
      output.ingestion_runbook.imports.worker_task_role_arn == "arn:aws:iam::123456789012:role/ingestion-import-task",
      !contains(keys(output.ingestion_runbook.imports), "cursor_secret"),
      !contains(keys(output.ingestion_runbook.imports), "import_cursor_secret"),
    ])
    error_message = "O runtime production de import deve manter owner, budget e activation=false sem expor o cursor."
  }

  assert {
    condition = alltrue([
      length(jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions)) == 3,
      length(jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions)) == 2,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).image == "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad",
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).command == [
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
      !contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).command, "--innodb-doublewrite=0"),
      !contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).command, "--innodb-redo-log-enabled=OFF"),
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).healthCheck.command == ["CMD-SHELL", "mysqladmin ping --silent --protocol=TCP -h 127.0.0.1 -uroot -p\"$MYSQL_ROOT_PASSWORD\""],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container if container.name == "mysql-snapshot"]).healthCheck.command == ["CMD-SHELL", "mysqladmin ping --silent --protocol=TCP -h 127.0.0.1 -uroot -p\"$MYSQL_ROOT_PASSWORD\""],
      !one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).readonlyRootFilesystem,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).mountPoints == [{ containerPath = "/var/lib/mysql", readOnly = false, sourceVolume = "mysql-data" }],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).secrets == [{ name = "MYSQL_ROOT_PASSWORD", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot" }],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "ingestion"]).image == "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "ingestion"]).readonlyRootFilesystem,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "ingestion"]).mountPoints == [{ containerPath = "/tmp", readOnly = false, sourceVolume = "ingestion-tmp" }],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "ingestion"]).dependsOn == [
        { condition = "HEALTHY", containerName = "mysql-snapshot" },
        { condition = "SUCCESS", containerName = "tmp-owner" },
      ],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "ingestion"]).secrets == [{ name = "MYSQL_PASSWORD", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot" }],
      { for item in one([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container if container.name == "ingestion"]).environment : item.name => item.value if contains([
        "PAGE_SIZE",
        "MYSQL_CONNECT_TIMEOUT_SECONDS",
        "MYSQL_READ_TIMEOUT_SECONDS",
        "MYSQL_WRITE_TIMEOUT_SECONDS",
        "MYSQL_DDL_TIMEOUT_SECONDS",
        "MYSQL_QUERY_MAX_ATTEMPTS",
        "MYSQL_QUERY_RETRY_BASE_MS",
        "MYSQL_QUERY_RETRY_MAX_MS",
        "MYSQL_SNAPSHOT_PREPARE_ENABLED",
        ], item.name) } == {
        PAGE_SIZE                      = "500"
        MYSQL_CONNECT_TIMEOUT_SECONDS  = "10"
        MYSQL_READ_TIMEOUT_SECONDS     = "300"
        MYSQL_WRITE_TIMEOUT_SECONDS    = "300"
        MYSQL_DDL_TIMEOUT_SECONDS      = "1800"
        MYSQL_QUERY_MAX_ATTEMPTS       = "4"
        MYSQL_QUERY_RETRY_BASE_MS      = "250"
        MYSQL_QUERY_RETRY_MAX_MS       = "4000"
        MYSQL_SNAPSHOT_PREPARE_ENABLED = "false"
      },
      var.ingestion_snapshot_page_size == 500,
      var.ingestion_snapshot_prepare_enabled == false,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).command == ["sync"],
      !contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).environment[*].name, "LIVE_SYNC_ENABLED"),
      contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).environment, { name = "SYNC_MAX_CATCHUP_WINDOWS", value = "96" }),
      contains(one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).environment, { name = "SYNC_FINALIZATION_DELAY_SECONDS", value = "900" }),
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).image == "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).readonlyRootFilesystem,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).mountPoints == [{ containerPath = "/tmp", readOnly = false, sourceVolume = "ingestion-tmp" }],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).secrets == [
        { name = "LIVE_MYSQL_HOST", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:host::" },
        { name = "LIVE_MYSQL_PORT", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:port::" },
        { name = "LIVE_MYSQL_USER", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:username::" },
        { name = "LIVE_MYSQL_PASSWORD", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:password::" },
        { name = "LIVE_MYSQL_DATABASE", valueFrom = "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:database::" },
      ],
      try(length(one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).portMappings), 0) == 0,
      try(length(one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "ingestion"]).portMappings), 0) == 0,
      try(length(one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).portMappings), 0) == 0,
    ])
    error_message = "O backfill deve usar sidecar MySQL saudável, imagem de ingestão por digest, rootfs somente leitura em /tmp e nenhuma porta exposta."
  }
  // O Fargate entrega um volume host vazio como root:root 0755 e NAO herda o
  // 1777 que a imagem tem em /tmp. O runtime roda como uid 10001 com rootfs
  // somente leitura, entao sem preparar o volume ele nao tem onde escrever e
  // recusa ARCHIVE_WORKDIR antes de qualquer efeito. O smoke local nao pega
  // isso porque monta --tmpfs com mode=1777, permissao que o Fargate nao da.
  assert {
    condition = alltrue([
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "tmp-owner"]).user == "0",
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "tmp-owner"]).user == "0",
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "tmp-owner"]).essential == false,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "tmp-owner"]).essential == false,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "tmp-owner"]).entryPoint == ["/usr/bin/chown"],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "tmp-owner"]).command == ["10001:10001", "/tmp"],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "tmp-owner"]).entryPoint == ["/usr/bin/chown"],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "tmp-owner"]).command == ["10001:10001", "/tmp"],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "tmp-owner"]).mountPoints == [{ containerPath = "/tmp", readOnly = false, sourceVolume = "ingestion-tmp" }],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "tmp-owner"]).mountPoints == [{ containerPath = "/tmp", readOnly = false, sourceVolume = "ingestion-tmp" }],
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_sync.container_definitions) : container if container.name == "ingestion"]).dependsOn == [{ condition = "SUCCESS", containerName = "tmp-owner" }],
      // Somente o worker pode ser essencial: quando ele termina, o ECS deve
      // encerrar o MySQL de suporte em vez de manter a task ociosa.
      toset([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container.name if container.essential]) == toset(["ingestion"]),
      toset([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container.name if container.essential]) == toset(["ingestion"]),
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_backfill.container_definitions) : container if container.name == "mysql-snapshot"]).essential == false,
      one([for container in jsondecode(aws_ecs_task_definition.ingestion_import.container_definitions) : container if container.name == "mysql-snapshot"]).essential == false,
    ])
    error_message = "Os containers de suporte devem ser nao essenciais, deixando apenas o worker encerrar a task depois da ingestao."
  }


  assert {
    condition = alltrue([
      output.ingestion_runbook.deployment_namespace == "view-show",
      output.ingestion_runbook.storage.bucket == "view-show-ingestion-123456789012-us-east-1",
      output.ingestion_runbook.storage.glue_database == "view_show_ingestion",
      output.ingestion_runbook.storage.athena_workgroup == "view-show-ingestion",
      output.ingestion_runbook.messaging.analysis_queue_url == "https://sqs.us-east-1.amazonaws.com/123456789012/view-show-ingestion-analysis",
      output.ingestion_runbook.messaging.scheduler_dlq_arn == "arn:aws:sqs:us-east-1:123456789012:view-show-ingestion-scheduler-dlq",
      output.ingestion_runbook.data.operational_table == "view-show-operacional",
      output.ingestion_runbook.data.outbox_pending_index == "outbox-pending-index",
      output.ingestion_runbook.data.snapshot_secret_arn == "arn:aws:secretsmanager:us-east-1:123456789012:secret:snapshot",
      output.ingestion_runbook.data.live_mysql_secret_arn == "arn:aws:secretsmanager:us-east-1:123456789012:secret:live",
      toset(keys(output.ingestion_runbook.data)) == toset(["operational_table", "outbox_pending_index", "snapshot_secret_arn", "live_mysql_secret_arn"]),
      output.ingestion_runbook.runtime.backfill_task_family == "view-show-ingestion-backfill",
      output.ingestion_runbook.runtime.sync_task_family == "view-show-ingestion-sync",
      output.ingestion_runbook.runtime.platform_version == "1.4.0",
      output.ingestion_runbook.scheduler.group_name == "view-show-ingestion",
      try(output.ingestion_runbook.scheduler.name, "") == "view-show-ingestion-sync",
      toset(keys(output.ingestion_runbook.scheduler)) == toset(["group_name", "name", "schedule_arn", "state"]),
      output.ingestion_runbook.scheduler.state == "ENABLED",
      output.ingestion_runbook.observability.dashboard_name == "view-show-ingestion",
      strcontains(output.comando_ingestion_backfill, "--platform-version 1.4.0"),
      strcontains(output.comando_ingestion_backfill, "--launch-type FARGATE"),
      output.comandos_logs_ingestao.backfill == "aws logs tail /ecs/view-show-ingestion-backfill --follow --region us-east-1",
      output.comandos_logs_ingestao.sync == "aws logs tail /ecs/view-show-ingestion-sync --follow --region us-east-1",
    ])
    error_message = "O runbook deve expor somente identificadores operacionais da Task 20/21, inclusive ARNs de segredo sem seus valores, e preservar Fargate 1.4.0 no comando de backfill."
  }
}

run "production_rejects_unapproved_canonical_first" {
  command = plan

  variables {
    import_canonical_first_enabled = true
  }

  expect_failures = [terraform_data.ingestion_guardrails]
}

run "production_accepts_explicitly_approved_canonical_first" {
  command = plan

  variables {
    import_canonical_first_enabled             = true
    import_canonical_first_production_approved = true
  }

  assert {
    condition     = contains(one([for container in jsondecode(aws_ecs_task_definition.api.container_definitions) : container if container.name == "view-show-api"]).environment, { name = "IMPORT_CANONICAL_FIRST_ENABLED", value = "true" })
    error_message = "A aprovação explícita deve habilitar canonical-first somente no runtime da API."
  }
}
