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
    scan_on_push = true
  }

  // Sem isto, terraform destroy falha enquanto houver imagem no repositório —
  // e num laboratório o destroy precisa ser confiável.
  force_delete = true

  tags = {
    Projeto = "view-show"
  }
}

// Manifesto determinístico de tudo que afeta o build da imagem. Além do
// Dockerfile e do .dockerignore, cobre cada origem de COPY usada no estágio de
// build. Testes, scripts de desenvolvimento e saídas dist continuam de fora.
locals {
  api_dir = "${path.module}/../backend/api"

  arquivos_build_api = sort(concat(
    [
      ".dockerignore",
      "Dockerfile",
      "package-lock.json",
      "package.json",
    ],
    [
      for arquivo in fileset(local.api_dir, "contracts/**") : arquivo
      if !strcontains(arquivo, "/dist/") && !endswith(arquivo, ".tsbuildinfo")
    ],
    tolist(fileset(local.api_dir, "src/**")),
    tolist(fileset(local.api_dir, "tsconfig*.json")),
  ))

  hash_imagem = sha1(join("", [
    for arquivo in local.arquivos_build_api : "${arquivo}:${filesha1("${local.api_dir}/${arquivo}")}\n"
  ]))

  tag_imagem = substr(local.hash_imagem, 0, 12)
  uri_imagem = "${aws_ecr_repository.api.repository_url}:${local.tag_imagem}"
}

resource "terraform_data" "imagem" {
  triggers_replace = [local.hash_imagem]

  lifecycle {
    replace_triggered_by = [aws_ecr_repository.api]
  }

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
