# Faixas de compatibilidade do Terraform e dos providers. As versões exatas dos
# providers são registradas no .terraform.lock.hcl versionado.

terraform {
  required_version = ">= 1.7.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  // Usa a cadeia padrão de credenciais da AWS. Portanto, AWS_PROFILE seleciona
  // o perfil tanto para o provider quanto para os scripts executados no apply.
  region = var.regiao

  default_tags {
    tags = {
      Projeto   = "view-show"
      Stack     = "g05-sprint3-entrega"
      ManagedBy = "terraform"
    }
  }
}
