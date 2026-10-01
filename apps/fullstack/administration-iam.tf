// EC2 administration uses dedicated roles instead of the Academy-wide LabRole.
resource "aws_iam_role" "administration" {
  for_each           = local.eks_manages_iam ? toset(["bastion", "observabilidade"]) : toset([])
  name               = "${var.deployment_namespace}-${each.key}-ec2"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "administration_ssm" {
  for_each   = aws_iam_role.administration
  role       = each.value.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy_attachment" "observability_read" {
  count      = local.eks_manages_iam ? 1 : 0
  role       = aws_iam_role.administration["observabilidade"].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/CloudWatchReadOnlyAccess"
}
resource "aws_iam_instance_profile" "administration" {
  for_each = aws_iam_role.administration
  name     = each.value.name
  role     = each.value.name
}
