locals {
  kubernetes_workloads = {
    api                          = local.workload_api
    ingestion-backfill           = local.workload_ingestion_backfill
    ingestion-import             = local.workload_ingestion_import
    ingestion-sync               = local.workload_ingestion_sync
    ingestion-incremental-export = local.workload_ingestion_incremental_export
    ingestion-incremental-ingest = local.workload_ingestion_incremental_ingest
    analysis-worker              = local.workload_analysis_worker
  }
}
output "kubernetes_deployment" {
  description = "Entrada sensível para apps/kubernetes/deploy.mjs; nunca versione este output."
  sensitive   = true
  value = {
    iam_mode                    = var.eks_iam_mode
    cluster_name                = aws_eks_cluster.principal.name
    cluster_arn                 = aws_eks_cluster.principal.arn
    region                      = var.regiao
    namespace                   = var.deployment_namespace
    vpc_id                      = aws_vpc.principal.id
    target_group_arn            = aws_lb_target_group.api.arn
    target_group_security_group = aws_security_group.alb.id
    node_security_group         = aws_security_group.servico.id
    system_roles                = { for key, role in aws_iam_role.eks_system : key => role.arn }
    workload_roles              = { for key, role in aws_iam_role.workload : key => role.arn }
    workloads                   = local.kubernetes_workloads
    api_min_replicas            = var.api_replicas_minima
    api_max_replicas            = var.api_replicas_maxima
    api_replicas                = var.quantidade_tasks
    api_cpu_target              = var.api_cpu_alvo
    analysis_enabled            = var.analysis_worker_habilitado
    sync_enabled                = var.scheduler_ingestao_habilitado
    incremental_enabled         = var.incremental_s3_enabled
    snapshot_storage_gib        = var.ingestion_backfill_ephemeral_storage_gib
    log_retention_days          = var.retencao_logs_ingestao_dias
    observability = var.observabilidade_habilitada ? {
      instance_id      = aws_instance.observabilidade[0].id
      dashboard_base64 = base64encode(local.dashboard_observabilidade)
    } : null
  }
  depends_on = [terraform_data.imagem, terraform_data.ingestion_image, terraform_data.analysis_worker_image, aws_s3_object.analysis_model, aws_s3_object.analysis_catalog, aws_secretsmanager_secret_version.snapshot_mysql, aws_eks_node_group.principal, aws_eks_pod_identity_association.cloudwatch]
}
output "kubernetes_runbook" {
  value = {
    cluster_name      = aws_eks_cluster.principal.name
    namespace         = var.deployment_namespace
    imports_namespace = "${var.deployment_namespace}-imports"
    region            = var.regiao
    kubeconfig        = "aws eks update-kubeconfig --name ${aws_eks_cluster.principal.name} --region ${var.regiao}${local.eks_manages_iam ? " --role-arn ${var.eks_admin_role_arn}" : ""}"
    api_logs          = "kubectl -n ${var.deployment_namespace} logs -f deployment/api"
    ingestion_logs    = "kubectl -n ${var.deployment_namespace}-imports logs -f job/IMPORT_JOB -c ingestion"
    deploy            = "node apps/kubernetes/deploy.mjs"
    storage           = { bucket = local.ingestion_bucket_name, operational_table = aws_dynamodb_table.operacional.name }
    schedules         = { sync = "ingestion-sync", incremental_export = "ingestion-incremental-export", incremental_ingest = "ingestion-incremental-ingest" }
  }
}
