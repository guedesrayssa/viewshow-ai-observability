// Explicit Academy profile: use pre-provisioned roles without mutating IAM.
variable "eks_iam_mode" {
  type    = string
  default = "managed"
  validation {
    condition     = contains(["managed", "learner-lab-existing"], var.eks_iam_mode)
    error_message = "Use managed or learner-lab-existing."
  }
}
variable "eks_existing_cluster_role_arn" {
  type    = string
  default = null
}
variable "eks_existing_node_role_arn" {
  type    = string
  default = null
}
variable "eks_existing_instance_profile" {
  type    = string
  default = null
}
locals {
  eks_manages_iam      = var.eks_iam_mode == "managed"
  eks_cluster_role_arn = local.eks_manages_iam ? aws_iam_role.eks_cluster[0].arn : var.eks_existing_cluster_role_arn
  eks_node_role_arn    = local.eks_manages_iam ? aws_iam_role.eks_node[0].arn : var.eks_existing_node_role_arn
  administration_profiles = {
    for name in ["bastion", "observabilidade"] : name => local.eks_manages_iam ? aws_iam_instance_profile.administration[name].name : var.eks_existing_instance_profile
  }
}
resource "terraform_data" "eks_iam_guardrails" {
  lifecycle {
    precondition {
      condition     = var.eks_node_root_volume_gib >= 256 || var.eks_node_instance_store
      error_message = "Snapshot Pods require at least 256 GiB on root or instance-store SSDs provisioned by nodeadm."
    }
    precondition {
      condition = local.eks_manages_iam || (var.ambiente == "learner-lab" &&
        can(regex("^arn:[^:]+:iam::${data.aws_caller_identity.atual.account_id}:role/.+$", var.eks_existing_cluster_role_arn)) &&
        can(regex("^arn:[^:]+:iam::${data.aws_caller_identity.atual.account_id}:role/LabRole$", var.eks_existing_node_role_arn)) &&
      var.eks_existing_instance_profile == "LabInstanceProfile")
      error_message = "Existing IAM mode is exclusive to Learner Lab, with roles from the current account, LabRole nodes and LabInstanceProfile. Production requires managed IAM/IRSA."
    }
  }
}
