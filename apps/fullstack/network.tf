// Dois security groups, com a mesma separação descrita na Tabela 7 de
// backend-sprint-2.md: o do serviço "só libera a porta do container a partir do
// SG do ALB". A porta 3000 nunca fica exposta à internet.

resource "aws_security_group" "alb" {
  name        = "${local.nome_alb}-sg"
  description = "Entrada publica na porta 80 do ALB"
  vpc_id      = aws_vpc.principal.id

  ingress {
    description = "HTTP publico"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Encaminhamento para as tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Projeto = "view-show"
  }
}

resource "aws_security_group" "servico" {
  name        = local.nome_security_group
  description = "Porta do container liberada apenas a partir do SG do ALB"
  vpc_id      = aws_vpc.principal.id

  ingress {
    description     = "Trafego do ALB para o container"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  // A task precisa de saída para puxar a imagem do ECR e falar com serviços AWS.
  // Ela permanece privada e usa o NAT ou os endpoints de gateway da VPC.
  egress {
    description = "Saida para ECR, DynamoDB e CloudWatch"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Projeto = "view-show"
  }
}
