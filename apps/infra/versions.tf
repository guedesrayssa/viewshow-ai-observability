# Versões travadas: um Terraform ou provider mais novo publicado entre a
# entrega e a correção deste projeto não deve mudar o comportamento por baixo
# dos pés de quem está reproduzindo a demonstração.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.regiao

  default_tags {
    tags = {
      Projeto   = "view-show"
      ManagedBy = "terraform"
    }
  }
}
