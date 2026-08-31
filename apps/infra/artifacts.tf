# Como levar o código até a instância sem credencial de repositório privado.
#
# O GitLab deste projeto é auto-hospedado e privado: uma EC2 recém-criada não
# tem como cloná-lo. A alternativa não é uma credencial embutida no
# provisionamento (ficaria legível via metadata service, e ainda precisaria
# ser gerenciada por fora do Terraform) — é empacotar o código aqui, do lado
# de quem está aplicando, e subir para um bucket privado que só a própria
# instância lê, pela role que ela já tem.
#
# `archive_file` é nativo do Terraform (provider oficial da HashiCorp): não
# chama `zip`, `tar` nem nenhum binário externo, então funciona do mesmo jeito
# em Linux e em Windows.

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/api"
  output_path = "${path.module}/.terraform-artifacts/api.zip"

  excludes = [
    "node_modules",
    "tests",
    "deploy",
    ".env",
  ]
}

data "archive_file" "frontend" {
  type        = "zip"
  source_dir  = "${path.module}/../frontend"
  output_path = "${path.module}/.terraform-artifacts/frontend.zip"

  excludes = [
    "node_modules",
    ".next",
    "out",
    "deploy",
    ".env.local",
  ]
}

# Nome com o id da conta: cada Learner Lab é uma conta nova, então isso evita
# colisão de nome de bucket entre alunos sem precisar de sufixo aleatório.
resource "aws_s3_bucket" "artefatos" {
  bucket        = "${var.prefixo}-view-show-${data.aws_caller_identity.atual.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artefatos" {
  bucket                  = aws_s3_bucket.artefatos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# A chave inclui o hash do conteúdo: uma mudança de código gera uma chave
# nova, o que muda o `user_data` (ver compute.tf) e, com
# `user_data_replace_on_change = true`, provoca uma instância nova já com o
# código atualizado. Não há passo de "reimplantar" separado do `apply`.
resource "aws_s3_object" "api" {
  bucket = aws_s3_bucket.artefatos.id
  key    = "api-${data.archive_file.api.output_md5}.zip"
  source = data.archive_file.api.output_path
  etag   = data.archive_file.api.output_md5
}

resource "aws_s3_object" "frontend" {
  bucket = aws_s3_bucket.artefatos.id
  key    = "frontend-${data.archive_file.frontend.output_md5}.zip"
  source = data.archive_file.frontend.output_path
  etag   = data.archive_file.frontend.output_md5
}
