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

  filter {
    name   = "default-for-az"
    values = ["true"]
  }

  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

// O ALB exige subnets em pelo menos duas zonas de disponibilidade. A default
// VPC tem uma por AZ, então basta pegar todas.
data "aws_subnet" "default" {
  for_each = toset(data.aws_subnets.default.ids)
  id       = each.value
}

check "subnets_alb" {
  assert {
    condition     = length(data.aws_subnets.default.ids) >= 2
    error_message = "A VPC default precisa ter pelo menos duas subnets públicas default-for-AZ para o ALB."
  }

  assert {
    condition = length(distinct([
      for subnet in data.aws_subnet.default : subnet.availability_zone
    ])) >= 2
    error_message = "A VPC default precisa ter subnets em pelo menos duas zonas de disponibilidade para o ALB."
  }
}

// LabRole é a única role utilizável no AWS Academy: iam:CreateRole devolve
// AccessDenied (registrado em artefatos/sprint2/backend-sprint-2.md, seção 8.1).
// Ela serve tanto como execution role quanto como task role.
data "aws_iam_role" "lab" {
  name = "LabRole"
}
