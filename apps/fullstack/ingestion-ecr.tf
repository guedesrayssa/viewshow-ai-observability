// Repositório imutável e escaneado da imagem Python do worker de ingestão.
resource "aws_ecr_repository" "ingestion" {
  name                 = local.ingestion_ecr_repository
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete_ecr_ingestao

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Componente = "ingestion"
    Ambiente   = var.ambiente
  }
}
