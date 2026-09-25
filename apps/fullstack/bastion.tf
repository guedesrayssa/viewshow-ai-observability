resource "aws_security_group" "bastion" {
  name        = "${local.nome_bastion}-sg"
  description = "Bastion via SSM; SSH somente do CIDR administrativo informado"
  vpc_id      = aws_vpc.principal.id

  dynamic "ingress" {
    for_each = var.bastion_admin_cidr == null ? [] : [var.bastion_admin_cidr]
    content {
      description = "SSH administrativo restrito"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    description = "SSM, atualizacoes e acesso administrativo de saida"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name   = "${local.nome_bastion}-sg"
    Camada = "administracao"
  }
}

resource "aws_instance" "bastion" {
  ami                         = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type               = var.tipo_instancia_bastion
  subnet_id                   = aws_subnet.publica["a"].id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.bastion.id]
  iam_instance_profile        = data.aws_iam_instance_profile.lab.name
  key_name                    = var.bastion_key_name

  lifecycle {
    # The public SSM parameter is rolling. AMI replacement is deliberate
    # maintenance, not a side effect of stateless application updates.
    ignore_changes = [ami]
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name   = "${local.nome_bastion}-root"
      Camada = "administracao"
    }
  }

  tags = {
    Name   = local.nome_bastion
    Camada = "administracao"
  }
}
