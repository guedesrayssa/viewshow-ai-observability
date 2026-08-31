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

  // Só re-semeia se as tabelas forem recriadas. Usar timestamp() aqui forçaria
  // uma re-semeadura a cada apply, mas ao custo de o `terraform plan` nunca
  // ficar limpo — e um plan que sempre acusa mudança é um plan em que ninguém
  // repara quando a mudança é de verdade.
  //
  // O contraponto é que o dado envelhece: o pk de cada item é um bucket de hora
  // calculado na semeadura, e o dashboard consulta uma janela de 24 h, então
  // dado com mais de ~25 h some da tela mesmo continuando na tabela (foi o que
  // aconteceu em artefatos/sprint2/testes-desempenho.md). Re-semear é um
  // comando à parte, idempotente, exposto no output `comando_seed`.
  triggers_replace = [
    aws_dynamodb_table.operacional.arn,
    aws_dynamodb_table.golden_set.arn,
  ]

  provisioner "local-exec" {
    command     = "npm ci --omit=dev --no-audit --no-fund && npm run seed"
    working_dir = "${path.module}/../backend/api"

    environment = {
      AWS_REGION             = var.regiao
      OPERATIONAL_TABLE_NAME = aws_dynamodb_table.operacional.name
      GOLDEN_SET_TABLE_NAME  = aws_dynamodb_table.golden_set.name
    }
  }
}
