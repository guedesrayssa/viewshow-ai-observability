// Os nomes de recursos desta entrega derivam de deployment_namespace em
// names.tf. O padrão mantém a aplicação isolada sem exigir argumentos no apply.

variable "regiao" {
  description = "Região fixa da stack isolada no AWS Academy Learner Lab."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.regiao == "us-east-1"
    error_message = "Esta stack só pode ser aplicada em us-east-1."
  }
}

variable "deployment_namespace" {
  description = "Namespace isolado desta entrega da Sprint 3."
  type        = string
  default     = "g05-s3"
  nullable    = false

  validation {
    condition     = var.deployment_namespace == "g05-s3"
    error_message = "Esta stack só pode ser aplicada com deployment_namespace=g05-s3."
  }
}

variable "branch_amplify" {
  description = "Branch do Amplify. Vira o subdomínio: https://<branch>.<appId>.amplifyapp.com"
  type        = string
  default     = "producao"
}

variable "cpu_task" {
  description = "CPU da task Fargate, em unidades de 1024."
  type        = string
  default     = "256"
}

variable "memoria_task" {
  description = "Memória da task Fargate, em MiB."
  type        = string
  default     = "512"
}

variable "quantidade_tasks" {
  description = "Tasks simultâneas no serviço."
  type        = number
  default     = 1

  validation {
    condition     = var.quantidade_tasks >= 1 && var.quantidade_tasks <= 4
    error_message = "quantidade_tasks deve ficar entre 1 e 4."
  }
}

variable "ecs_capacidade_minima" {
  description = "Quantidade mínima de tasks mantida pelo ECS Service Auto Scaling."
  type        = number
  default     = 1

  validation {
    condition     = var.ecs_capacidade_minima >= 1 && var.ecs_capacidade_minima <= 4
    error_message = "ecs_capacidade_minima deve ficar entre 1 e 4."
  }
}

variable "ecs_capacidade_maxima" {
  description = "Quantidade máxima de tasks permitida pelo ECS Service Auto Scaling."
  type        = number
  default     = 4

  validation {
    condition     = var.ecs_capacidade_maxima >= 1 && var.ecs_capacidade_maxima <= 4
    error_message = "ecs_capacidade_maxima deve ficar entre 1 e 4."
  }
}

variable "ecs_cpu_alvo" {
  description = "Percentual médio de CPU perseguido pela política target tracking."
  type        = number
  default     = 50

  validation {
    condition     = var.ecs_cpu_alvo >= 1 && var.ecs_cpu_alvo <= 100
    error_message = "ecs_cpu_alvo deve ficar entre 1 e 100."
  }
}

check "limites_escalonamento_ecs" {
  assert {
    condition = (
      var.ecs_capacidade_minima <= var.quantidade_tasks &&
      var.quantidade_tasks <= var.ecs_capacidade_maxima
    )
    error_message = "quantidade_tasks deve ficar entre as capacidades mínima e máxima do ECS."
  }
}

variable "rate_limit_por_minuto" {
  description = "Requisições/minuto por IP antes de RATE_LIMITED (rateLimiter em src/app.ts). 180 é o padrão de produção; suba temporariamente numa janela de teste de carga para medir a API sem o teto do rate limiter (ver apps/backend/api/loadtest/README.md)."
  type        = number
  default     = 180
}

variable "bedrock_habilitado" {
  description = "Liga a explicação em linguagem natural via Bedrock. Mantenha desligado: o Learner Lab não dá acesso ao Bedrock, e o código já cai para explicação por template."
  type        = bool
  default     = false
}

variable "retencao_logs_dias" {
  description = "Retenção do log group do ECS."
  type        = number
  default     = 7
}

variable "observabilidade_habilitada" {
  description = "Cria, somente quando explicitamente habilitada, a stack Grafana, Prometheus, Loki, Tempo e Alloy em uma EC2."
  type        = bool
  default     = false
}

variable "tipo_instancia_observabilidade" {
  description = "Tipo da EC2 da stack. t3.medium fornece 4 GiB para os cinco componentes de observabilidade."
  type        = string
  default     = "t3.medium"
}

variable "disco_observabilidade_gib" {
  description = "Tamanho do volume gp3 que guarda métricas, logs, traces e dados do Grafana."
  type        = number
  default     = 30

  validation {
    condition     = var.disco_observabilidade_gib >= 20
    error_message = "A stack de observabilidade precisa de pelo menos 20 GiB."
  }
}

variable "grafana_cidr_acesso" {
  description = "CIDR autorizado a abrir o Grafana em :3000. null mantém a porta privada e exige túnel SSM (recomendado)."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.grafana_cidr_acesso == null || (
      can(cidrnetmask(var.grafana_cidr_acesso)) && var.grafana_cidr_acesso != "0.0.0.0/0"
    )
    error_message = "grafana_cidr_acesso deve ser null ou um CIDR IPv4 restrito; 0.0.0.0/0 não é permitido."
  }
}

variable "bastion_admin_cidr" {
  description = "CIDR IPv4 autorizado a usar SSH no bastion; null mantém somente SSM."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.bastion_admin_cidr == null ? true : (
      can(cidrhost(var.bastion_admin_cidr, 0)) && var.bastion_admin_cidr != "0.0.0.0/0"
    )
    error_message = "Use null para SSM ou um CIDR IPv4 restrito; 0.0.0.0/0 não é permitido."
  }
}

variable "bastion_key_name" {
  description = "Key pair existente no Learner Lab para o SSH opcional."
  type        = string
  default     = "vockey"
}

variable "tipo_instancia_bastion" {
  description = "Tipo da EC2 administrativa; t3.micro é suficiente para o bastion."
  type        = string
  default     = "t3.micro"
}
