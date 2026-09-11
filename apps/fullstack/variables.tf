// Os nomes de recursos desta entrega derivam de deployment_namespace em
// names.tf. Isso impede uma aplicação acidental na stack legada compartilhada.

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
