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
  region              = var.regiao
  # AWS Academy Learner Lab: a conta rotaciona a cada novo lab. Atualize este
  # ID sempre que `terraform plan` recusar com "account ID not allowed" —
  # confirme a conta ativa com `aws sts get-caller-identity`.
  allowed_account_ids = ["080158589617"]

  default_tags {
    tags = {
      Projeto   = "view-show"
      Stack     = "g05-sprint3-entrega"
      ManagedBy = "terraform"
    }
  }
}
