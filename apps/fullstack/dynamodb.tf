// As duas tabelas da Seção 2 de artefatos/sprint2/backend-sprint-2.md.
//
// Nenhum código do repositório cria estas tabelas — elas foram criadas à mão no
// console durante a Sprint 2. Este arquivo é a primeira definição executável
// delas, e o esquema abaixo foi derivado do código que lê e escreve:
// apps/backend/api/src/db/keys.js (convenção de chaves) e
// apps/backend/api/src/services/*.js (padrões de acesso).

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

  // Projeção ALL não é preferência: src/routes/incidents.js serializa o item
  // vindo do Query no índice direto para a resposta HTTP, e
  // src/services/evidenceService.js remonta a chave {pk, sk} da tabela base a
  // partir de um item vindo do índice. Com projeção parcial, as duas coisas
  // quebram.
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
  // assinatura determinística "<component>#<deviceType>#<region>"
  // (src/services/goldenSetService.js).
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
