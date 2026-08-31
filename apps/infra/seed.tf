// Popula as duas tabelas com apps/backend/api/scripts/seed.js: 4 incidentes,
// suas evidências e hipóteses, e 3 casos curados na golden set.
//
// Roda localmente, não dentro do container: o .dockerignore exclui scripts/, e
// o Dockerfile copia só src/ — então o seed não existe na imagem publicada e
// não dá para executá-lo com um exec na task.
//
// O script escreve direto no DynamoDB pelo SDK, sem passar pela API, então não
// depende do serviço ECS estar de pé.
resource "terraform_data" "seed" {
  count = var.semear_dados ? 1 : 0

  // O pk de cada item é um bucket de hora calculado no instante da semeadura, e
  // GET /api/v1/dashboard/summary consulta uma janela de 24 h. Dado semeado há
  // mais de ~25 h some da tela mesmo continuando na tabela — foi o que
  // aconteceu em artefatos/sprint2/testes-desempenho.md. Semear de novo é
  // barato e idempotente (PutCommand por chave fixa), então o timestamp abaixo
  // força uma re-semeadura a cada apply.
  triggers_replace = [
    aws_dynamodb_table.operacional.arn,
    aws_dynamodb_table.golden_set.arn,
    timestamp(),
  ]

  provisioner "local-exec" {
    working_dir = "${path.module}/../backend/api"
    interpreter = ["bash", "-c"]

    command = <<-EOT
      set -euo pipefail
      npm ci --omit=dev --no-audit --no-fund
      AWS_REGION=${var.regiao} \
      OPERATIONAL_TABLE_NAME=${aws_dynamodb_table.operacional.name} \
      GOLDEN_SET_TABLE_NAME=${aws_dynamodb_table.golden_set.name} \
        npm run seed
    EOT
  }
}
