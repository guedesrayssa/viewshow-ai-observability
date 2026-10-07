// Superfície pública de configuração: defaults econômicos no Learner Lab e
// guardrails fail-closed que exigem valores explícitos e não destrutivos em produção.
variable "ambiente" {
  description = "Perfil de implantação da ingestão. Learner Lab mantém defaults econômicos; production exige configuração explícita e não destrutiva."
  type        = string
  default     = "learner-lab"

  validation {
    condition     = contains(["learner-lab", "production"], var.ambiente)
    error_message = "ambiente deve ser learner-lab ou production."
  }
}

variable "nome_repositorio_ecr_ingestao" {
  description = "Override opcional do nome físico do repositório ECR da imagem de ingestão."
  type        = string
  default     = null
  nullable    = true
}

variable "nome_bucket_ingestao" {
  description = "Reservado para compatibilidade de entrada; o bucket é sempre derivado do namespace, conta e região."
  type        = string
  default     = null
  nullable    = true
}

variable "compatibilidade_s3_learner_lab" {
  description = "Contorna apenas no Learner Lab a leitura de Object Lock negada pela SCP. Nulo habilita no Learner Lab e desabilita em produção."
  type        = bool
  default     = null
  nullable    = true
}

variable "prefixo_resultados_athena_ingestao" {
  description = "Prefixo S3 relativo e isolado para resultados do Athena."
  type        = string
  default     = "athena-results/"

  validation {
    condition = (
      length(var.prefixo_resultados_athena_ingestao) > 0 &&
      endswith(var.prefixo_resultados_athena_ingestao, "/") &&
      !startswith(var.prefixo_resultados_athena_ingestao, "/") &&
      !strcontains(lower(var.prefixo_resultados_athena_ingestao), "s3://") &&
      !strcontains(var.prefixo_resultados_athena_ingestao, "//") &&
      !strcontains(var.prefixo_resultados_athena_ingestao, "..") &&
      !can(regex("(^|/)\\.(/|$)", var.prefixo_resultados_athena_ingestao)) &&
      !can(regex("[[:cntrl:]]", var.prefixo_resultados_athena_ingestao))
    )
    error_message = "O prefixo de resultados do Athena deve ser relativo, não vazio, terminar em / e não conter URI S3, //, segmentos . ou .., nem caracteres de controle."
  }
}

variable "retencao_dumps_ingestao_dias" {
  description = "Retenção de dumps e de suas versões não correntes."
  type        = number
  default     = 30
}

variable "retencao_temporarios_ingestao_dias" {
  description = "Retenção de staging, resultados Athena e suas versões não correntes."
  type        = number
  default     = 7
}

variable "retencao_raw_incremental_ingestao_dias" {
  description = "Teto efetivo, em dias, para versões raw incrementais correntes e não correntes; também limita a vida de lotes órfãos."
  type        = number
  default     = 90

  validation {
    condition     = var.retencao_raw_incremental_ingestao_dias >= 2 && floor(var.retencao_raw_incremental_ingestao_dias) == var.retencao_raw_incremental_ingestao_dias
    error_message = "retencao_raw_incremental_ingestao_dias deve ser um inteiro de pelo menos dois dias."
  }
}

variable "retencao_raw_incremental_noncurrent_ingestao_dias" {
  description = "Janela pós-delete, em dias, reservada às versões raw incrementais não correntes dentro do teto efetivo."
  type        = number
  default     = 1

  validation {
    condition     = var.retencao_raw_incremental_noncurrent_ingestao_dias >= 1 && floor(var.retencao_raw_incremental_noncurrent_ingestao_dias) == var.retencao_raw_incremental_noncurrent_ingestao_dias
    error_message = "retencao_raw_incremental_noncurrent_ingestao_dias deve ser um inteiro positivo."
  }
}

variable "nome_database_glue_ingestao" {
  description = "Override opcional do database Glue; tabelas e partições continuam sob responsabilidade do runtime."
  type        = string
  default     = null
  nullable    = true
}

variable "nome_workgroup_athena_ingestao" {
  description = "Override opcional do workgroup Athena usado pelas consultas da ingestão."
  type        = string
  default     = null
  nullable    = true
}

variable "nome_fila_analysis" {
  description = "Override opcional da fila Standard consumida pelo pipeline de análise."
  type        = string
  default     = null
  nullable    = true
}

variable "nome_fila_analysis_dlq" {
  description = "Override opcional da DLQ exclusiva da fila de análise."
  type        = string
  default     = null
  nullable    = true
}

variable "retencao_filas_ingestao_segundos" {
  description = "Retenção das filas da ingestão, em segundos."
  type        = number
  default     = 1209600
}

variable "nome_segredo_snapshot_mysql_ingestao" {
  description = "Override opcional do contêiner de segredo criado somente no Learner Lab para o snapshot MySQL."
  type        = string
  default     = null
  nullable    = true
}

variable "nome_segredo_live_mysql_ingestao" {
  description = "Override opcional do contêiner de segredo criado somente no Learner Lab para o MySQL live."
  type        = string
  default     = null
  nullable    = true
}

variable "ingestion_backfill_cpu" {
  description = "CPU da futura task Kubernetes de backfill, em unidades de 1024."
  type        = string
  default     = "2048"
}

variable "ingestion_backfill_memoria" {
  description = "Memória da futura task Kubernetes de backfill, em MiB."
  type        = string
  default     = "8192"
}

variable "ingestion_backfill_ephemeral_storage_gib" {
  description = "Contrato de storage efêmero de snapshot preservado em 200 GiB; os Pods reservam 192 GiB e usam nós com disco de 300 GiB."
  type        = number
  default     = 200

  validation {
    condition     = var.ingestion_backfill_ephemeral_storage_gib == 200
    error_message = "Mantenha o contrato de snapshot em 200 GiB de storage efêmero."
  }
}

variable "ingestion_snapshot_page_size" {
  description = "Quantidade de linhas por página no MySQL de snapshot; 500 é o default seguro e os canários do Learner Lab avaliam somente 2.000, 5.000 e 10.000."
  type        = number
  default     = 500

  validation {
    condition     = contains([500, 2000, 5000, 10000], var.ingestion_snapshot_page_size)
    error_message = "ingestion_snapshot_page_size deve ser 500, 2000, 5000 ou 10000."
  }
}

variable "ingestion_snapshot_prepare_enabled" {
  description = "Feature flag do preflight de índices de cursor do snapshot; permanece desligada por default e afeta somente novas tasks."
  type        = bool
  default     = false
}

variable "import_canonical_first_enabled" {
  description = "Habilita canonical-first somente para novos imports reservados pela API; imports já reservados preservam o pipeline."
  type        = bool
  default     = false
}

variable "import_hot_materialization_enabled" {
  description = "Habilita materialização hot no worker de import; permanece desligada durante o rollout canonical-first."
  type        = bool
  default     = false
}

variable "import_canonical_first_production_approved" {
  description = "Registra a aprovação operacional explícita exigida para habilitar canonical-first em produção."
  type        = bool
  default     = false
}

variable "ingestion_sync_cpu" {
  description = "CPU da futura task Kubernetes de sincronização, em unidades de 1024."
  type        = string
  default     = "1024"
}

variable "ingestion_sync_memoria" {
  description = "Memória da futura task Kubernetes de sincronização, em MiB."
  type        = string
  default     = "2048"
}

variable "sync_max_catchup_windows" {
  description = "Máximo de janelas fechadas de 15 minutos processadas por uma task sync."
  type        = number
  default     = 96

  validation {
    condition     = var.sync_max_catchup_windows > 0 && floor(var.sync_max_catchup_windows) == var.sync_max_catchup_windows
    error_message = "sync_max_catchup_windows deve ser um inteiro positivo."
  }
}

variable "sync_finalization_delay_seconds" {
  description = "Margem para materialização tardia antes de fechar uma janela sync de 15 minutos."
  type        = number
  default     = 900

  validation {
    condition     = var.sync_finalization_delay_seconds >= 900 && floor(var.sync_finalization_delay_seconds) == var.sync_finalization_delay_seconds && var.sync_finalization_delay_seconds % 900 == 0
    error_message = "sync_finalization_delay_seconds deve ser inteiro, no mínimo 900 e múltiplo de 900."
  }
}

variable "retencao_logs_ingestao_dias" {
  description = "Retenção dos futuros log groups da ingestão."
  type        = number
  default     = 7
}

variable "snapshot_mysql_secret_arn_ingestao" {
  description = "ARN de segredo existente com a senha raw do snapshot MySQL, obrigatório em produção."
  type        = string
  default     = null
  nullable    = true
}

variable "live_mysql_secret_arn_ingestao" {
  description = "ARN de segredo existente com credenciais do MySQL live, obrigatório em produção."
  type        = string
  default     = null
  nullable    = true
}

variable "imagem_ingestao" {
  description = "URI da imagem de ingestão; em produção deve ser explicitamente fixada por digest sha256."
  type        = string
  default     = null
  nullable    = true
}

variable "imagem_mysql_snapshot" {
  description = "Imagem MySQL do sidecar de snapshot, sempre fixada por digest."
  type        = string
  default     = "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad"
}

variable "scheduler_ingestao_habilitado" {
  description = "Define o estado inicial do schedule de sincronização no primeiro deploy; depois a aplicação o gerencia em runtime."
  type        = bool
  default     = false
}

variable "live_sync_enabled" {
  description = "Gate de implantação que autoriza a automação incremental a ler o MySQL live homologado; sync e reprocess usam o controle dinâmico."
  type        = bool
  default     = false
}

variable "incremental_s3_enabled" {
  description = "Habilita explicitamente os schedules de export e ingest incremental via S3; exige o gate live homologado."
  type        = bool
  default     = false
}

variable "namespace_metricas_ingestao" {
  description = "Override opcional do namespace CloudWatch das métricas EMF da ingestão."
  type        = string
  default     = null
  nullable    = true
}

variable "acoes_alarme_ingestao" {
  description = "ARNs das ações usadas pelos futuros alarmes da ingestão."
  type        = list(string)
  default     = []
}

variable "limiar_duracao_projecao_ingestao_ms" {
  description = "Duração máxima aceitável, em milissegundos, para a etapa PROJECTING do backfill."
  type        = number
  default     = 300000

  validation {
    condition     = var.limiar_duracao_projecao_ingestao_ms > 0
    error_message = "O limiar de duração da projeção deve ser positivo."
  }
}

variable "limiar_falhas_rebuild_projecoes_ingestao" {
  description = "Quantidade de execuções FAILED de rebuild-projections que abre o alarme."
  type        = number
  default     = 1

  validation {
    condition     = var.limiar_falhas_rebuild_projecoes_ingestao > 0
    error_message = "O limiar de falhas do rebuild de projeções deve ser positivo."
  }
}

variable "limiar_idade_upload_importacao_segundos" {
  description = "Idade de upload ativo que abre o alarme antes da expiração de 24 horas."
  type        = number
  default     = 82800

  validation {
    condition     = var.limiar_idade_upload_importacao_segundos > 0 && var.limiar_idade_upload_importacao_segundos < 86400
    error_message = "O limiar de idade de upload deve ser positivo e inferior a 24 horas."
  }
}

variable "limiar_falhas_importacao" {
  description = "Quantidade de falhas de reconciliação ou worker que abre os alarmes de importação."
  type        = number
  default     = 1

  validation {
    condition     = var.limiar_falhas_importacao > 0
    error_message = "O limiar de falhas de importação deve ser positivo."
  }
}

variable "force_destroy_bucket_ingestao" {
  description = "Permite esvaziar o bucket no destroy. Deve ser falso em produção."
  type        = bool
  default     = true
}

variable "force_delete_ecr_ingestao" {
  description = "Permite apagar o ECR com imagens. Deve ser falso em produção."
  type        = bool
  default     = true
}

locals {
  ingestion_name_prefix = "${var.deployment_namespace}-ingestion"

  ingestion_ecr_repository    = coalesce(var.nome_repositorio_ecr_ingestao, "${local.ingestion_name_prefix}")
  ingestion_glue_database     = coalesce(var.nome_database_glue_ingestao, "${replace(var.deployment_namespace, "-", "_")}_ingestion")
  ingestion_workgroup         = coalesce(var.nome_workgroup_athena_ingestao, "${local.ingestion_name_prefix}")
  ingestion_analysis_queue    = coalesce(var.nome_fila_analysis, "${local.ingestion_name_prefix}-analysis")
  ingestion_analysis_dlq      = coalesce(var.nome_fila_analysis_dlq, "${local.ingestion_name_prefix}-analysis-dlq")
  ingestion_incremental_queue = "${local.ingestion_name_prefix}-incremental-batches.fifo"
  ingestion_incremental_dlq   = "${local.ingestion_name_prefix}-incremental-batches-dlq.fifo"
  ingestion_snapshot_secret_name = coalesce(
    var.nome_segredo_snapshot_mysql_ingestao,
    "${local.ingestion_name_prefix}/snapshot-mysql",
  )
  ingestion_live_secret_name = coalesce(
    var.nome_segredo_live_mysql_ingestao,
    "${local.ingestion_name_prefix}/live-mysql",
  )
  ingestion_backfill_family           = "${local.ingestion_name_prefix}-backfill"
  ingestion_import_family             = "${local.ingestion_name_prefix}-import"
  ingestion_sync_family               = "${local.ingestion_name_prefix}-sync"
  ingestion_incremental_export_family = "${local.ingestion_name_prefix}-incremental-export"
  ingestion_incremental_ingest_family = "${local.ingestion_name_prefix}-incremental-ingest"
  ingestion_log_service_name          = local.ingestion_name_prefix
  ingestion_metrics_namespace = coalesce(
    var.namespace_metricas_ingestao,
    "${var.deployment_namespace}/Ingestion",
  )

  // A bifurcação concentra compatibilidades de laboratório e requisitos de produção.
  ingestion_is_production = var.ambiente == "production"

  ingestion_s3_learner_lab_compat_enabled = var.compatibilidade_s3_learner_lab != null ? var.compatibilidade_s3_learner_lab : !local.ingestion_is_production

  ingestion_default_bucket_name = "${local.ingestion_name_prefix}-${data.aws_caller_identity.atual.account_id}-${data.aws_region.atual.name}"
  ingestion_bucket_name         = local.ingestion_default_bucket_name

  ingestion_name_overrides_match_namespace = alltrue([
    var.nome_repositorio_ecr_ingestao == null || startswith(var.nome_repositorio_ecr_ingestao, local.ingestion_name_prefix),
    var.nome_database_glue_ingestao == null || startswith(var.nome_database_glue_ingestao, "${replace(var.deployment_namespace, "-", "_")}_ingestion"),
    var.nome_workgroup_athena_ingestao == null || startswith(var.nome_workgroup_athena_ingestao, local.ingestion_name_prefix),
    var.nome_fila_analysis == null || startswith(var.nome_fila_analysis, local.ingestion_name_prefix),
    var.nome_fila_analysis_dlq == null || startswith(var.nome_fila_analysis_dlq, local.ingestion_name_prefix),
    var.nome_segredo_snapshot_mysql_ingestao == null || startswith(var.nome_segredo_snapshot_mysql_ingestao, "${local.ingestion_name_prefix}/"),
    var.nome_segredo_live_mysql_ingestao == null || startswith(var.nome_segredo_live_mysql_ingestao, "${local.ingestion_name_prefix}/"),
    var.namespace_metricas_ingestao == null || startswith(var.namespace_metricas_ingestao, "${var.deployment_namespace}/"),
  ])

  ingestion_athena_output_location = "s3://${local.ingestion_bucket_name}/${local.ingestion_athena_results_prefix}"

  // A ingestão compartilha a VPC dedicada da API. As tasks ficam sempre nas
  // subnets privadas e usam o NAT/endpoints já declarados para saída.
  ingestion_vpc_id           = aws_vpc.principal.id
  ingestion_subnet_ids       = values(aws_subnet.privada)[*].id
  ingestion_assign_public_ip = false

  api_task_role_arn                           = local.eks_manages_iam ? aws_iam_role.workload["api"].arn : var.eks_existing_node_role_arn
  api_task_role_name                          = local.eks_manages_iam ? aws_iam_role.workload["api"].name : null
  ingestion_import_task_role_arn              = local.eks_manages_iam ? aws_iam_role.workload["ingestion-import"].arn : var.eks_existing_node_role_arn
  ingestion_import_task_role_name             = local.eks_manages_iam ? aws_iam_role.workload["ingestion-import"].name : null
  ingestion_incremental_export_task_role_arn  = local.eks_manages_iam ? aws_iam_role.workload["ingestion-incremental-export"].arn : var.eks_existing_node_role_arn
  ingestion_incremental_export_task_role_name = local.eks_manages_iam ? aws_iam_role.workload["ingestion-incremental-export"].name : null
  ingestion_incremental_ingest_task_role_arn  = local.eks_manages_iam ? aws_iam_role.workload["ingestion-incremental-ingest"].arn : var.eks_existing_node_role_arn
  ingestion_incremental_ingest_task_role_name = local.eks_manages_iam ? aws_iam_role.workload["ingestion-incremental-ingest"].name : null

  ingestion_snapshot_mysql_secret_arn = local.ingestion_is_production ? var.snapshot_mysql_secret_arn_ingestao : aws_secretsmanager_secret.snapshot_mysql[0].arn
  ingestion_live_mysql_secret_arn     = local.ingestion_is_production ? var.live_mysql_secret_arn_ingestao : aws_secretsmanager_secret.live_mysql[0].arn

  ingestion_expected_role_arn_pattern = "^arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.atual.account_id}:role/[A-Za-z0-9+=,.@_-]{1,64}(/[A-Za-z0-9+=,.@_-]{1,64})*$"

  ingestion_production_secrets_valid = alltrue([
    for secret_arn in [
      var.snapshot_mysql_secret_arn_ingestao,
      var.live_mysql_secret_arn_ingestao,
    ] : can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+", secret_arn))
  ])
}

resource "terraform_data" "ingestion_guardrails" {
  input = var.ambiente

  lifecycle {
    precondition {
      condition     = local.ingestion_lifecycle_prefixes_non_overlapping
      error_message = "Os prefixos de lifecycle da ingestão devem ser distintos e não podem ser pais ou filhos entre si."
    }

    precondition {
      condition     = var.nome_bucket_ingestao == null
      error_message = "O bucket da ingestão é sempre derivado de deployment_namespace, conta e região; não há override seguro."
    }

    precondition {
      condition     = local.ingestion_name_overrides_match_namespace
      error_message = "Overrides de nomes da ingestão devem permanecer no namespace deployment_namespace."
    }

    precondition {
      condition     = local.ingestion_lifecycle_prefixes_isolated_from_canonical
      error_message = "Nenhum prefixo com expiração pode ser igual, pai ou filho de canonical/."
    }

    precondition {
      condition     = local.ingestion_lifecycle_rules_isolated_from_canonical
      error_message = "Toda regra de lifecycle deve ter prefixo não vazio e permanecer fora de canonical/."
    }

    precondition {
      condition     = local.ingestion_incremental_raw_prefix_isolated
      error_message = "raw/argus/incremental/ deve permanecer isolado de canonical/, dumps/ e staging/."
    }

    precondition {
      condition = !local.ingestion_is_production || can(regex(
        "^.+@sha256:[0-9a-fA-F]{64}$",
        var.imagem_ingestao,
      ))
      error_message = "Produção exige imagem de ingestão explícita e fixada por digest sha256."
    }

    precondition {
      condition = !local.ingestion_is_production || can(regex(
        "^.+@sha256:[0-9a-fA-F]{64}$",
        var.imagem_mysql_snapshot,
      ))
      error_message = "Produção exige imagem MySQL fixada por digest sha256."
    }









    precondition {
      condition     = !local.ingestion_is_production || local.ingestion_production_secrets_valid
      error_message = "Produção exige os ARNs dos segredos snapshot e live existentes."
    }

    precondition {
      condition     = !local.ingestion_is_production || (!var.force_destroy_bucket_ingestao && !var.force_delete_ecr_ingestao)
      error_message = "Produção exige force_destroy=false no S3 e force_delete=false no ECR."
    }

    precondition {
      condition     = !local.ingestion_is_production || !local.ingestion_s3_learner_lab_compat_enabled
      error_message = "A compatibilidade S3 que evita a leitura de Object Lock é exclusiva do Learner Lab."
    }

    precondition {
      condition     = !var.incremental_s3_enabled || var.live_sync_enabled
      error_message = "Os schedules incrementais S3 só podem ser habilitados quando live_sync_enabled=true e a integração ARGUS estiver homologada."
    }

    precondition {
      condition     = !local.ingestion_is_production || !var.import_canonical_first_enabled || var.import_canonical_first_production_approved
      error_message = "Produção exige import_canonical_first_production_approved=true para habilitar canonical-first."
    }

    precondition {
      condition     = var.retencao_raw_incremental_noncurrent_ingestao_dias < var.retencao_raw_incremental_ingestao_dias
      error_message = "A janela noncurrent raw incremental deve ser positiva e menor que o teto efetivo para preservar uma janela current positiva."
    }
  }
}
