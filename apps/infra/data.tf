data "aws_caller_identity" "atual" {}

data "aws_region" "atual" {}

// A VPC default do laboratório. O Learner Lab entrega uma pronta, com subnets
// públicas em várias AZs — e criar VPC própria só gastaria tempo de apply sem
// mudar nada do que a arquitetura documentada descreve.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

// O ALB exige subnets em pelo menos duas zonas de disponibilidade. A default
// VPC tem uma por AZ, então basta pegar todas.
data "aws_subnet" "default" {
  for_each = toset(data.aws_subnets.default.ids)
  id       = each.value
}

// LabRole é a única role utilizável no AWS Academy: iam:CreateRole devolve
// AccessDenied (testado e registrado em artefatos/sprint2/backend-sprint-2.md,
// seção 8.1). Ela serve tanto como execution role quanto como task role, que é
// exatamente o que o task-definition.json versionado já fazia.
data "aws_iam_role" "lab" {
  name = "LabRole"
}
