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

// Sem allowed_account_ids de propósito: a stack precisa ser aplicável em
// qualquer conta do Learner Lab trocando apenas o profile. A conferência de
// conta é do operador, no pré-voo do runbook (aws sts get-caller-identity), e a
// checagem que de fato protege uma operação — a credencial pertencer à mesma
// conta do stack — vive em run_task.py, derivada dos ARNs do terraform output.
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
