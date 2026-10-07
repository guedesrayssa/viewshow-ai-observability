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
