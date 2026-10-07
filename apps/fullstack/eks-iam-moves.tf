moved {
  from = aws_iam_role.eks_cluster
  to   = aws_iam_role.eks_cluster[0]
}

moved {
  from = aws_iam_role.eks_node
  to   = aws_iam_role.eks_node[0]
}

moved {
  from = aws_iam_role_policy_attachment.eks_cluster
  to   = aws_iam_role_policy_attachment.eks_cluster[0]
}

moved {
  from = aws_iam_openid_connect_provider.eks
  to   = aws_iam_openid_connect_provider.eks[0]
}

moved {
  from = aws_iam_role_policy_attachment.vpc_cni
  to   = aws_iam_role_policy_attachment.vpc_cni[0]
}

moved {
  from = aws_iam_role_policy.load_balancer_controller
  to   = aws_iam_role_policy.load_balancer_controller[0]
}

moved {
  from = aws_iam_role_policy.cluster_autoscaler
  to   = aws_iam_role_policy.cluster_autoscaler[0]
}

moved {
  from = aws_eks_addon.pod_identity
  to   = aws_eks_addon.pod_identity[0]
}

moved {
  from = aws_eks_pod_identity_association.cloudwatch
  to   = aws_eks_pod_identity_association.cloudwatch[0]
}

moved {
  from = aws_iam_role_policy_attachment.observability_read
  to   = aws_iam_role_policy_attachment.observability_read[0]
}

moved {
  from = aws_iam_role_policy.api_runtime
  to   = aws_iam_role_policy.api_runtime[0]
}

moved {
  from = aws_iam_role_policy.analysis_runtime
  to   = aws_iam_role_policy.analysis_runtime[0]
}
