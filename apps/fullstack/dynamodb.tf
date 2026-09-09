// As duas tabelas da Seção 2 de artefatos/sprint2/backend-sprint-2.md.
//
// Nenhum código do repositório cria estas tabelas — elas foram criadas à mão no
// console durante a Sprint 2. Este arquivo é a primeira definição executável
// delas, e o esquema abaixo acompanha os adaptadores TypeScript que acessam a
// tabela operacional:
// apps/backend/api/src/modules/incidents/adapters/dynamodb-incident-repository.ts
// apps/backend/api/src/modules/dashboard/adapters/dynamodb-dashboard-read-repository.ts

resource "aws_dynamodb_table" "operacional" {
  name         = var.tabela_operacional
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "trace_id"
    type = "S"
  }

  // Projeção ALL não é preferência: o adaptador TypeScript de incidentes
  // consulta o bundle completo pelo trace-index, converte os itens em DTOs e
  // preserva {pk, sk} para a atualização condicional de revisões. Uma projeção
  // parcial quebraria essas operações.
  global_secondary_index {
    name            = "trace-index"
    hash_key        = "trace_id"
    range_key       = "sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Projeto = "view-show"
    Camada  = "dados"
  }
}

resource "aws_dynamodb_table" "golden_set" {
  name         = var.tabela_golden_set
  billing_mode = "PAY_PER_REQUEST"

  // Chave simples, sem sort key e sem GSI: o acesso é sempre GetItem por
  // assinatura determinística "<component>#<deviceType>#<region>". A API
  // TypeScript atual não possui adaptador operacional para esta tabela.
  hash_key = "case_id"

  attribute {
    name = "case_id"
    type = "S"
  }

  tags = {
    Projeto = "view-show"
    Camada  = "dados"
  }
}
