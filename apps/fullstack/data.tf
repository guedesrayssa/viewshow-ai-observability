data "aws_caller_identity" "atual" {}

data "aws_partition" "current" {}

data "aws_region" "atual" {}

data "aws_availability_zones" "disponiveis" {
  state = "available"
}

check "subnets_alb" {
  assert {
    condition     = length(data.aws_availability_zones.disponiveis.names) >= 2
    error_message = "A região precisa oferecer pelo menos duas zonas de disponibilidade para o ALB."
  }
}

data "aws_ssm_parameter" "amazon_linux_2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

// LabRole é a única role utilizável no AWS Academy: iam:CreateRole devolve
// AccessDenied (registrado em artefatos/sprint2/backend-sprint-2.md, seção 8.1).
// Ela serve tanto como execution role quanto como task role.
data "aws_iam_role" "lab" {
  name = "LabRole"
}

// Perfil preexistente do Learner Lab. Dá à EC2 acesso às APIs da AWS sem
// gravar credenciais temporárias no disco e permite abrir o Grafana via SSM.
data "aws_iam_instance_profile" "lab" {
  name = "LabInstanceProfile"
}
