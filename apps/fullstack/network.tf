// Dois security groups, com a mesma separação descrita na Tabela 7 de
// backend-sprint-2.md: o do serviço "só libera a porta do container a partir do
// SG do ALB". A porta 3000 nunca fica exposta à internet.

resource "aws_security_group" "alb" {
  name        = "${var.nome_alb}-sg"
  description = "Entrada publica na porta 80 do ALB"
  vpc_id      = data.aws_vpc.default.id

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
  name        = var.nome_security_group
  description = "Porta do container liberada apenas a partir do SG do ALB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Trafego do ALB para o container"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  // A task precisa de saída para puxar a imagem do ECR e falar com o DynamoDB.
  // Como ela roda em subnet pública com IP público (ver ecs.tf), essa saída vai
  // direto pelo internet gateway — sem NAT Gateway, que custaria ~US$ 32/mês e
  // não é desligado pelo laboratório no fim da sessão.
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
