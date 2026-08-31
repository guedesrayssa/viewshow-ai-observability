# Uma única porta de entrada, além do SSH de conveniência para depuração. Não
# há Load Balancer nem regra de saída restrita: o objetivo aqui é uma demo de
# aprendizagem provisionável em minutos, não um perímetro de produção.

resource "aws_security_group" "app" {
  name        = "${var.prefixo}-view-show"
  description = "Painel + API operacional (porta 80) e SSH de depuracao (porta 22)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Painel e API, atras do nginx"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH de depuracao, so da maquina de quem aplicou (ver data.tf)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [local.ssh_cidr]
  }

  egress {
    description = "Build do Next precisa alcancar o npm registry e o Google Fonts, a API precisa alcancar o DynamoDB"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}
