# Fontes de dado: tudo que este provisionamento lê da conta em vez de criar.
# Nenhuma delas exige permissão além do que o LabRole já concede.

data "aws_caller_identity" "atual" {}

# Amazon Linux 2023 mais recente, x86_64. Buscada por data source, e não
# fixada por AMI ID, porque um ID trocaria de significado entre regiões e
# entre contas — cada AWS Academy Learner Lab é uma conta nova.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# O Learner Lab não permite criar uma VPC própria em todo cenário testado, e
# não há necessidade: uma instância pública só precisa do que a VPC default
# já oferece — sub-rede pública com rota de internet.
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
}

# Endereço IP público de quem está aplicando, só para liberar a porta 22 da
# própria máquina em vez de abrir SSH para a internet inteira. Se o serviço
# estiver fora do ar ou bloqueado por algum proxy corporativo, defina
# `ssh_cidr` manualmente na variável.
data "http" "meu_ip" {
  count = var.ssh_cidr == "" ? 1 : 0
  url   = "https://checkip.amazonaws.com"
}

locals {
  ssh_cidr = var.ssh_cidr != "" ? var.ssh_cidr : "${chomp(data.http.meu_ip[0].response_body)}/32"

  # Primeira sub-rede pública default da região — qualquer uma serve, já que
  # não há nada multi-AZ nesta topologia (uma instância só).
  subnet_id = data.aws_subnets.default.ids[0]
}
