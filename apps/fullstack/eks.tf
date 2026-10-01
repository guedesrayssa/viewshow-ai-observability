variable "kubernetes_version" {
  description = "Versão minor do EKS, com suporte a sidecars nativos de Jobs."
  type        = string
  default     = "1.35"
}
variable "eks_admin_role_arn" {
  description = "Role IAM permanente do operador/CI (não use ARN de sessão STS)."
  type        = string
  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:role/.+$", var.eks_admin_role_arn))
    error_message = "Informe o ARN IAM da role de administração do cluster."
  }
}
variable "eks_public_access_cidrs" {
  description = "CIDRs do operador/CI que alcançam o endpoint Kubernetes. Endpoint privado sempre habilitado."
  type        = list(string)
  validation {
    condition     = length(var.eks_public_access_cidrs) > 0 && alltrue([for cidr in var.eks_public_access_cidrs : can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"])
    error_message = "Informe CIDRs IPv4 restritos para administração do EKS."
  }
}
variable "eks_node_root_volume_gib" {
  type    = number
  default = 300
  validation {
    condition     = var.eks_node_root_volume_gib >= 40
    error_message = "Node root volumes must have at least 40 GiB."
  }
}
variable "eks_node_instance_store" {
  description = "Use AL2023 nodeadm RAID0 for instance-store SSDs, preserving snapshot temporary capacity."
  type        = bool
  default     = false
}
variable "eks_node_min_size" { default = 2 }
variable "eks_node_max_size" { default = 6 }
variable "eks_node_desired_size" { default = 2 }
variable "eks_node_instance_types" {
  type    = list(string)
  default = ["m6i.xlarge"]
}

resource "aws_iam_role" "eks_cluster" {
  count              = local.eks_manages_iam ? 1 : 0
  name               = "${local.nome_cluster}-control-plane"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "eks_cluster" {
  count      = local.eks_manages_iam ? 1 : 0
  role       = aws_iam_role.eks_cluster[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}
resource "aws_eks_cluster" "principal" {
  name                      = local.nome_cluster
  version                   = var.kubernetes_version
  role_arn                  = local.eks_cluster_role_arn
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }
  vpc_config {
    subnet_ids              = values(aws_subnet.privada)[*].id
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.eks_public_access_cidrs
  }
  depends_on = [aws_iam_role_policy_attachment.eks_cluster, aws_cloudwatch_log_group.eks, terraform_data.eks_iam_guardrails]
}
resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.nome_cluster}/cluster"
  retention_in_days = var.retencao_logs_dias
}
resource "aws_eks_access_entry" "admin" {
  cluster_name  = aws_eks_cluster.principal.name
  principal_arn = var.eks_admin_role_arn
  type          = "STANDARD"
}
resource "aws_eks_access_policy_association" "admin" {
  cluster_name  = aws_eks_cluster.principal.name
  principal_arn = aws_eks_access_entry.admin.principal_arn
  policy_arn    = "arn:${data.aws_partition.current.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope { type = "cluster" }
}
resource "aws_iam_role" "eks_node" {
  count              = local.eks_manages_iam ? 1 : 0
  name               = "${local.nome_cluster}-nodes"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "eks_node" {
  for_each   = local.eks_manages_iam ? toset(["AmazonEKSWorkerNodePolicy", "AmazonEC2ContainerRegistryReadOnly"]) : toset([])
  role       = aws_iam_role.eks_node[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/${each.key}"
}
resource "aws_launch_template" "eks_node" {
  name_prefix            = "${local.nome_cluster}-"
  vpc_security_group_ids = [aws_eks_cluster.principal.vpc_config[0].cluster_security_group_id, aws_security_group.servico.id]
  user_data = var.eks_node_instance_store ? base64encode(<<-EOT
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="VIEW_SHOW_NODE"

    --VIEW_SHOW_NODE
    Content-Type: application/node.eks.aws

    apiVersion: node.eks.aws/v1alpha1
    kind: NodeConfig
    spec:
      instance:
        localStorage:
          strategy: RAID0

    --VIEW_SHOW_NODE--
    EOT
  ) : null
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = local.eks_manages_iam ? 1 : 2
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.eks_node_root_volume_gib
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.nome_cluster}-worker" }
  }
}
resource "aws_eks_node_group" "principal" {
  cluster_name    = aws_eks_cluster.principal.name
  node_group_name = "workloads"
  node_role_arn   = local.eks_node_role_arn
  subnet_ids      = values(aws_subnet.privada)[*].id
  instance_types  = var.eks_node_instance_types
  ami_type        = "AL2023_x86_64_STANDARD"
  capacity_type   = "ON_DEMAND"
  launch_template {
    id      = aws_launch_template.eks_node.id
    version = aws_launch_template.eks_node.latest_version
  }
  scaling_config {
    min_size     = var.eks_node_min_size
    max_size     = var.eks_node_max_size
    desired_size = var.eks_node_desired_size
  }
  update_config { max_unavailable = 1 }
  lifecycle { ignore_changes = [scaling_config[0].desired_size] }
  depends_on = [aws_iam_role_policy_attachment.eks_node, aws_eks_addon.vpc_cni, aws_route.privada_internet]
}
resource "aws_iam_openid_connect_provider" "eks" {
  count          = local.eks_manages_iam ? 1 : 0
  url            = aws_eks_cluster.principal.identity[0].oidc[0].issuer
  client_id_list = ["sts.amazonaws.com"]
  # AWS obtains the CA thumbprint for the OIDC provider.
}
locals {
  eks_oidc          = local.eks_manages_iam ? replace(aws_iam_openid_connect_provider.eks[0].url, "https://", "") : ""
  workload_accounts = toset(["api", "analysis-worker", "ingestion-backfill", "ingestion-import", "ingestion-sync", "ingestion-incremental-export", "ingestion-incremental-ingest"])
  system_accounts = {
    "load-balancer-controller" = "kube-system:aws-load-balancer-controller"
    "cluster-autoscaler"       = "kube-system:cluster-autoscaler"
    "vpc-cni"                  = "kube-system:aws-node"
    "cloudwatch"               = "amazon-cloudwatch:cloudwatch-agent"
  }
}
resource "aws_iam_role" "workload" {
  for_each = local.eks_manages_iam ? local.workload_accounts : toset([])
  name     = "${var.deployment_namespace}-k8s-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity", Principal = { Federated = aws_iam_openid_connect_provider.eks[0].arn }, Condition = { StringEquals = {
      "${local.eks_oidc}:aud" = "sts.amazonaws.com"
      "${local.eks_oidc}:sub" = "system:serviceaccount:${each.key == "ingestion-import" ? "${var.deployment_namespace}-imports" : var.deployment_namespace}:${each.key}"
    } } }]
  })
}
resource "aws_iam_role" "eks_system" {
  for_each = local.eks_manages_iam ? local.system_accounts : {}
  name     = "${var.deployment_namespace}-k8s-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(each.key == "cloudwatch" ? [{ Effect = "Allow", Action = ["sts:AssumeRole", "sts:TagSession"], Principal = { Service = "pods.eks.amazonaws.com" } }] : [], [{ Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity", Principal = { Federated = aws_iam_openid_connect_provider.eks[0].arn }, Condition = { StringEquals = {
      "${local.eks_oidc}:aud" = "sts.amazonaws.com"
      "${local.eks_oidc}:sub" = "system:serviceaccount:${each.value}"
    } } }])
  })
}
resource "aws_iam_role_policy_attachment" "vpc_cni" {
  count      = local.eks_manages_iam ? 1 : 0
  role       = aws_iam_role.eks_system["vpc-cni"].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.principal.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  service_account_role_arn    = local.eks_manages_iam ? aws_iam_role.eks_system["vpc-cni"].arn : null
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })
  depends_on                  = [aws_iam_role_policy_attachment.vpc_cni]
}
resource "aws_eks_addon" "core" {
  for_each                    = toset(["coredns", "kube-proxy"])
  cluster_name                = aws_eks_cluster.principal.name
  addon_name                  = each.key
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  depends_on                  = [aws_eks_node_group.principal]
}
resource "aws_iam_role_policy" "load_balancer_controller" {
  count  = local.eks_manages_iam ? 1 : 0
  role   = aws_iam_role.eks_system["load-balancer-controller"].name
  policy = file("${path.module}/../kubernetes/load-balancer-policy.json")
}
resource "aws_iam_role_policy" "cluster_autoscaler" {
  count = local.eks_manages_iam ? 1 : 0
  role  = aws_iam_role.eks_system["cluster-autoscaler"].name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeAutoScalingInstances", "autoscaling:DescribeLaunchConfigurations", "autoscaling:DescribeScalingActivities", "autoscaling:DescribeTags", "ec2:DescribeImages", "ec2:DescribeInstanceTypes", "ec2:DescribeLaunchTemplateVersions", "ec2:GetInstanceTypesFromInstanceRequirements", "eks:DescribeNodegroup"], Resource = "*" },
    { Effect = "Allow", Action = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup"], Resource = "*", Condition = { StringEquals = {
      "autoscaling:ResourceTag/k8s.io/cluster-autoscaler/enabled"               = "true"
      "autoscaling:ResourceTag/k8s.io/cluster-autoscaler/${local.nome_cluster}" = "owned"
    } } }
  ] })
}
resource "aws_autoscaling_group_tag" "discovery" {
  for_each               = { "k8s.io/cluster-autoscaler/enabled" = "true", "k8s.io/cluster-autoscaler/${local.nome_cluster}" = "owned" }
  autoscaling_group_name = aws_eks_node_group.principal.resources[0].autoscaling_groups[0].name
  tag {
    key                 = each.key
    value               = each.value
    propagate_at_launch = true
  }
}
resource "aws_iam_role_policy_attachment" "cloudwatch" {
  for_each   = local.eks_manages_iam ? toset(["cloudwatch"]) : toset([])
  role       = aws_iam_role.eks_system[each.key].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}
resource "aws_cloudwatch_log_group" "kubernetes_application" {
  name              = "/aws/containerinsights/${local.nome_cluster}/application"
  retention_in_days = var.retencao_logs_ingestao_dias
}

check "node_capacity" {
  assert {
    condition     = var.eks_node_min_size >= 2 && var.eks_node_min_size <= var.eks_node_desired_size && var.eks_node_desired_size <= var.eks_node_max_size
    error_message = "Mantenha pelo menos dois nós e min <= desired <= max."
  }
}

resource "aws_eks_addon" "pod_identity" {
  count        = local.eks_manages_iam ? 1 : 0
  cluster_name = aws_eks_cluster.principal.name
  addon_name   = "eks-pod-identity-agent"
  depends_on   = [aws_eks_node_group.principal]
}
resource "aws_eks_pod_identity_association" "cloudwatch" {
  count           = local.eks_manages_iam ? 1 : 0
  cluster_name    = aws_eks_cluster.principal.name
  namespace       = "amazon-cloudwatch"
  service_account = "cloudwatch-agent"
  role_arn        = aws_iam_role.eks_system["cloudwatch"].arn
  depends_on      = [aws_eks_addon.pod_identity]
}

resource "aws_cloudwatch_log_group" "kubernetes_system" {
  for_each          = toset(["performance", "dataplane", "host"])
  name              = "/aws/containerinsights/${local.nome_cluster}/${each.key}"
  retention_in_days = var.retencao_logs_ingestao_dias
}
