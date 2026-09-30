mock_provider "aws" {
  mock_data "aws_availability_zones" { defaults = { names = ["us-east-1a", "us-east-1b"] } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_region" { defaults = { name = "us-east-1" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/test" } }
  mock_resource "aws_eks_cluster" {
    defaults = {
      arn      = "arn:aws:eks:us-east-1:123456789012:cluster/view-show-iac-cluster"
      identity = [{ oidc = [{ issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/TEST" }] }]
    }
  }
  mock_resource "aws_eks_node_group" { defaults = { resources = [{ autoscaling_groups = [{ name = "mock-asg" }] }] } }
}
mock_provider "random" {
  mock_resource "random_password" { defaults = { result = "deterministic-test-secret-not-deployed" } }
}
mock_provider "archive" {}
variables {
  deployment_namespace    = "view-show"
  eks_admin_role_arn      = "arn:aws:iam::123456789012:role/operator"
  eks_public_access_cidrs = ["192.0.2.1/32"]
}
override_resource {
  target          = aws_dynamodb_table.operacional
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/operacional" }
}
override_resource {
  target          = aws_sqs_queue.analysis
  override_during = plan
  values          = { arn = "arn:aws:sqs:us-east-1:123456789012:analysis" }
}
run "kubernetes_runtime_preserves_data_contract" {
  command = plan
  assert {
    condition     = aws_eks_cluster.principal.version == "1.35" && aws_eks_cluster.principal.access_config[0].authentication_mode == "API"
    error_message = "Cluster must support native sidecars and explicit access entries."
  }
  assert {
    condition     = local.workload_ingestion_import.containers[0].name == "mysql-snapshot" && local.workload_ingestion_import.containers[1].args == ["import-dump"]
    error_message = "Snapshot import must retain both MySQL and worker."
  }
  assert {
    condition     = !var.scheduler_ingestao_habilitado && !var.incremental_s3_enabled
    error_message = "Live schedules must remain disabled by default."
  }
  assert {
    condition     = local.workload_ingestion_import.containers[1].secrets[0].name == "MYSQL_PASSWORD" && local.ingestion_snapshot_disk_budget_bytes == 68719476736
    error_message = "Import secrets/disk budget contract changed."
  }
  assert {
    condition     = strcontains(local.api_import_policy, "ImportMultipartStaging") && !strcontains(local.api_import_policy, "ecs:RunTask") && strcontains(local.ingestion_import_policy, "DenyActiveManifestWrites")
    error_message = "Import IAM must preserve data protections and remove ECS launch privileges."
  }
  assert {
    condition     = aws_launch_template.eks_node.metadata_options[0].http_put_response_hop_limit == 1 && aws_launch_template.eks_node.block_device_mappings[0].ebs[0].volume_size == 300
    error_message = "Nodes must isolate IMDS from Pods and hold the snapshot working set."
  }
}
run "incremental_gate" {
  command = plan
  variables { incremental_s3_enabled = true }
  expect_failures = [terraform_data.ingestion_guardrails]
}
run "production_requires_immutable_images_and_secrets" {
  command = plan
  variables { ambiente = "production" }
  expect_failures = [terraform_data.ingestion_guardrails]
}
run "analysis_runtime_enabled" {
  command = plan
  variables {
    analysis_worker_habilitado  = true
    analysis_model_file         = "tests/fixtures/analysis-model.json"
    analysis_scope_catalog_file = "tests/fixtures/analysis-catalog.json"
  }
  assert {
    condition     = local.workload_analysis_worker.containers[0].name == "analysis-worker" && length(aws_s3_object.analysis_model) == 1
    error_message = "Analysis artifacts and consumer must be provisioned together."
  }
}

run "observability_migration_preserves_history" {
  command = plan
  variables { observabilidade_habilitada = true }
  assert {
    condition     = !aws_instance.observabilidade[0].user_data_replace_on_change
    error_message = "Observability must update the EKS dashboard without replacing historical volumes."
  }
}
