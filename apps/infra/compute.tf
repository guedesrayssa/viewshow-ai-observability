# A única máquina que este provisionamento cria. Painel, API operacional e
# nginx moram todos nela — ver templates/user_data.sh.tftpl para o porquê de
# uma origem só, e o README para o raciocínio completo por trás da topologia.

locals {
  # Mesma major do Dockerfile da API (apps/backend/api/Dockerfile), para não
  # rodar em algo que o time nunca testou.
  node_major = "22"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.tipo_instancia
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = var.nome_perfil_instancia
  key_name               = aws_key_pair.ssh.key_name

  root_block_device {
    volume_size = var.volume_gb
    volume_type = "gp3"
  }

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    node_major            = local.node_major
    regiao                = var.regiao
    bucket                = aws_s3_bucket.artefatos.id
    chave_api             = aws_s3_object.api.key
    chave_frontend        = aws_s3_object.frontend.key
    tabela_operacional    = aws_dynamodb_table.operacional.name
    tabela_golden_set     = aws_dynamodb_table.golden_set.name
    auth_email            = var.auth_email
    auth_senha            = var.auth_senha
    auth_cookie_secret    = random_password.cookie.result
    permitir_dado_exemplo = var.permitir_dado_exemplo
  })

  # Sem isto, editar o `user_data` (ex.: trocar o código e gerar uma chave S3
  # nova) faria a AWS aplicar stop/start na instância existente — e o
  # cloud-init não reexecuta o `runcmd`/user_data num boot que não seja o
  # primeiro. O apply reportaria sucesso e a máquina continuaria rodando o
  # código antigo, sem erro nenhum aparente. Com esta flag, mudança de
  # user_data = instância nova, sempre.
  user_data_replace_on_change = true

  lifecycle {
    # Uma AMI de Amazon Linux 2023 mais nova publicada entre duas sessões do
    # laboratório não deve, sozinha, destruir e recriar a instância no meio
    # de uma demonstração.
    ignore_changes = [ami]
  }

  depends_on = [
    aws_dynamodb_table.operacional,
    aws_dynamodb_table.golden_set,
    aws_s3_object.api,
    aws_s3_object.frontend,
  ]

  tags = {
    Name = "${var.prefixo}-view-show"
  }
}

# Sem isto, o IP público muda a cada Start do laboratório e invalida
# qualquer link já compartilhado. Não é preciso saber o endereço antes de a
# instância existir: como painel e API vivem na mesma origem (ver
# user_data.sh.tftpl), nada precisa do IP embutido em tempo de build.
resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id

  tags = {
    Name = "${var.prefixo}-view-show"
  }
}

# Segredo do cookie de sessão. O repositório traz um placeholder committado
# (`troque-este-segredo-em-producao` / `REPLACE_BEFORE_DEPLOY_...`) que nunca
# deve chegar a uma instância de verdade — aqui cada apply gera o seu.
resource "random_password" "cookie" {
  length  = 64
  special = false
}
