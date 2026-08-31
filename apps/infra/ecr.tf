// Repositório da imagem, mais o build e o push.
//
// O pipeline do GitLab (scripts/ci/publish-backend-image.sh) faz isto a cada
// push na develop. Aqui o mesmo trabalho precisa acontecer pelo menos uma vez,
// senão o serviço ECS sobe apontando para uma imagem que não existe e as tasks
// ficam em CannotPullContainerError.

resource "aws_ecr_repository" "api" {
  name = var.nome_repositorio_ecr

  // Mutável porque o pipeline reaproveita a tag de cache do buildx.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }

  // Sem isto, terraform destroy falha enquanto houver imagem no repositório —
  // e num laboratório o destroy precisa ser confiável.
  force_delete = true

  tags = {
    Projeto = "view-show"
  }
}

// Só o código que entra na imagem: o Dockerfile copia package*.json e src.
// Mudou qualquer um desses, a imagem é reconstruída; mudou um teste ou um
// README, não é.
locals {
  api_dir = "${path.module}/../backend/api"

  hash_imagem = sha1(join("", [
    filesha1("${local.api_dir}/Dockerfile"),
    filesha1("${local.api_dir}/package.json"),
    filesha1("${local.api_dir}/package-lock.json"),
    sha1(join("", [for f in fileset("${local.api_dir}/src", "**") : filesha1("${local.api_dir}/src/${f}")])),
  ]))

  tag_imagem = substr(local.hash_imagem, 0, 12)
  uri_imagem = "${aws_ecr_repository.api.repository_url}:${local.tag_imagem}"
}

resource "terraform_data" "imagem" {
  triggers_replace = [local.hash_imagem]

  provisioner "local-exec" {
    working_dir = local.api_dir
    interpreter = ["bash", "-c"]

    // --platform linux/amd64 é obrigatório: Fargate roda x86_64, e um build
    // feito num Mac Apple Silicon sairia arm64 e a task morreria no start com
    // "exec format error".
    command = <<-EOT
      set -euo pipefail
      aws ecr get-login-password --region ${var.regiao} \
        | docker login --username AWS --password-stdin ${aws_ecr_repository.api.repository_url}
      docker build --platform linux/amd64 -t ${local.uri_imagem} .
      docker push ${local.uri_imagem}
    EOT
  }
}
