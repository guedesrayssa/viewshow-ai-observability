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

  // O trabalho vive em scripts/publicar-imagem.mjs, e não num comando embutido
  // aqui, para rodar igual em Linux, macOS e Windows: `node arquivo.mjs` é a
  // mesma linha nos três, enquanto um script de shell não é. As variáveis vão
  // pelo bloco `environment`, que o Terraform repassa de forma portável — sem
  // ele seria `VAR=x comando` no bash e `set VAR=x` no cmd.
  provisioner "local-exec" {
    command = "node ${abspath("${path.module}/scripts/publicar-imagem.mjs")}"

    environment = {
      REGIAO   = var.regiao
      REPO_URL = aws_ecr_repository.api.repository_url
      TAG      = local.tag_imagem
      CONTEXTO = abspath(local.api_dir)
    }
  }
}
