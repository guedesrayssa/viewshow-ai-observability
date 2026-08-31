// Nomes padrão idênticos aos da Tabela 7 de artefatos/sprint2/backend-sprint-2.md,
// para que o que este Terraform cria seja conferível linha a linha contra a
// documentação da arquitetura entregue. Trocar um nome aqui é divergir dela.

variable "regiao" {
  description = "Região da AWS. O Learner Lab só permite us-east-1 e us-west-2."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = contains(["us-east-1", "us-west-2"], var.regiao)
    error_message = "O AWS Academy Learner Lab só autoriza us-east-1 e us-west-2."
  }
}

variable "nome_cluster" {
  description = "Cluster ECS. Na conta compartilhada ele já existia, criado para o job de ingestão (BigQuery -> DynamoDB); aqui é criado do zero porque o job não faz parte deste repositório."
  type        = string
  default     = "data-ingestion-cluster"
}

variable "nome_alb" {
  description = "Application Load Balancer. Mesma origem do nome do cluster: era compartilhado com o job de ingestão."
  type        = string
  default     = "data-ingestion-alb"
}

variable "nome_servico" {
  description = "Serviço ECS que roda a API operacional."
  type        = string
  default     = "monitoracao-api-service"
}

variable "nome_task_definition" {
  description = "Família da task definition."
  type        = string
  default     = "monitoracao-api-task"
}

variable "nome_container" {
  description = "Nome do container dentro da task definition. Precisa bater com o que o target group referencia."
  type        = string
  default     = "monitoracao-api-container"
}

variable "nome_repositorio_ecr" {
  description = "Repositório ECR que guarda a imagem da API."
  type        = string
  default     = "monitoracao-api"
}

variable "nome_target_group" {
  description = "Target group do ALB. Limite de 32 caracteres imposto pela AWS."
  type        = string
  default     = "monitoracao-api-tg"
}

variable "nome_security_group" {
  description = "Security group do serviço ECS."
  type        = string
  default     = "monitoracao-api-sg"
}

variable "nome_app_amplify" {
  description = "App do Amplify Hosting que serve o painel Next.js."
  type        = string
  default     = "g05-painel"
}

variable "branch_amplify" {
  description = "Branch do Amplify. Vira o subdomínio: https://<branch>.<appId>.amplifyapp.com"
  type        = string
  default     = "producao"
}

variable "tabela_operacional" {
  description = "Tabela DynamoDB de incidentes, evidências e hipóteses."
  type        = string
  default     = "monitoracao-operacional"
}

variable "tabela_golden_set" {
  description = "Tabela DynamoDB dos casos curados."
  type        = string
  default     = "monitoracao-golden-set"
}

variable "cpu_task" {
  description = "CPU da task Fargate, em unidades de 1024. Igual ao task-definition.json versionado."
  type        = string
  default     = "256"
}

variable "memoria_task" {
  description = "Memória da task Fargate, em MiB. Igual ao task-definition.json versionado."
  type        = string
  default     = "512"
}

variable "quantidade_tasks" {
  description = "Tasks simultâneas no serviço."
  type        = number
  default     = 1
}

variable "auth_email" {
  description = "Usuário fixo de demonstração aceito pelo login."
  type        = string
  default     = "demo@globoplay.com"
}

variable "auth_senha" {
  description = "Senha do usuário fixo. O padrão é o mesmo do repositório; troque para qualquer coisa que não seja demonstração."
  type        = string
  default     = "demo123"
  sensitive   = true
}

variable "bedrock_habilitado" {
  description = "Liga a explicação em linguagem natural via Bedrock. Mantenha desligado: o Learner Lab não dá acesso ao Bedrock, e o código já cai para explicação por template."
  type        = bool
  default     = false
}

variable "permitir_dado_exemplo" {
  description = "Deixa o painel cair para o conjunto de exemplo quando uma leitura falha, rotulando isso na interface. As telas que dependem da API de telemetria (Flask), fora do escopo desta infra, só têm conteúdo com isto ligado."
  type        = bool
  default     = true
}

variable "semear_dados" {
  description = "Roda apps/backend/api/scripts/seed.js depois de criar as tabelas, para o painel não abrir vazio."
  type        = bool
  default     = true
}

variable "retencao_logs_dias" {
  description = "Retenção do log group do ECS."
  type        = number
  default     = 7
}
