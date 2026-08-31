# Chave SSH gerada pelo próprio apply, só para depuração (ver o comentário em
# network.tf). Ninguém precisa ter uma chave pronta: o Terraform cria o par,
# manda a pública para a AWS e grava a privada num arquivo local.

resource "tls_private_key" "ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "ssh" {
  key_name   = "${var.prefixo}-view-show"
  public_key = tls_private_key.ssh.public_key_openssh
}

resource "local_sensitive_file" "chave_privada" {
  content         = tls_private_key.ssh.private_key_pem
  filename        = "${path.module}/${var.prefixo}-view-show.pem"
  file_permission = "0400"
}
