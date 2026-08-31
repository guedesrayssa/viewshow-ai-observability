# As duas tabelas que a API operacional lê e escreve. Nenhum código do
# repositório as cria — hoje elas existem porque alguém clicou no console.
# O esquema abaixo foi reconstruído a partir de como o código as usa
# (apps/backend/api/src/db/*.js e scripts/seed.js), não de um documento
# formal de schema, porque esse documento não existe no repositório.

resource "aws_dynamodb_table" "operacional" {
  name         = var.nome_tabela_operacional
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

  # Só as chaves usadas por hash_key/range_key/GSI entram como `attribute`
  # aqui — os outros campos do item (título, urgência, score...) são livres e
  # não precisam ser declarados.
  attribute {
    name = "trace_id"
    type = "S"
  }

  # incidents.js serializa a resposta HTTP diretamente do item devolvido pelo
  # Query neste índice, e evidenceService.js reconstrói a chave da tabela base
  # a partir de um item vindo dele — por isso a projeção precisa ser ALL, não
  # é só uma escolha de custo.
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
}

resource "aws_dynamodb_table" "golden_set" {
  name         = var.nome_tabela_golden_set
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "case_id"

  attribute {
    name = "case_id"
    type = "S"
  }

  # Sem range key, sem GSI, sem TTL: goldenSetService.js só faz GetItem por
  # `case_id` (a assinatura "<component>#<deviceType>#<region>"), e os casos
  # curados não devem expirar sozinhos.
}
