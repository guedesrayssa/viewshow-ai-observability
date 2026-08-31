# Variáveis do provisionamento. Nenhuma credencial mora aqui — a AWS é
# resolvida pela cadeia padrão do provider (variáveis de ambiente ou
# ~/.aws/credentials), então quem aplica só precisa deixar o AWS CLI apontado
# para o perfil do próprio Learner Lab antes de rodar `terraform apply`.

variable "regiao" {
  description = "Região AWS. O AWS Academy Learner Lab só permite us-east-1 e us-west-2."
  type        = string
  default     = "us-east-1"
}

variable "prefixo" {
  description = "Prefixo aplicado a todo nome de recurso, para não colidir se mais de uma pessoa aplicar na mesma conta."
  type        = string
  default     = "g05"
}

variable "tipo_instancia" {
  description = "Tamanho da EC2. O Learner Lab permite de nano a large; t3.small comporta nginx, o Node da API e o build do Next confortavelmente."
  type        = string
  default     = "t3.small"
}

variable "volume_gb" {
  description = "Tamanho do volume EBS raiz, em GB. O snapshot do Amazon Linux 2023 já vem com 30 GB; um valor menor faz a criação da instância falhar com InvalidBlockDeviceMapping. O Learner Lab permite até 100."
  type        = number
  default     = 30

  validation {
    condition     = var.volume_gb >= 30
    error_message = "volume_gb precisa ser >= 30: é o tamanho do snapshot raiz do Amazon Linux 2023, e um volume menor faz a EC2 falhar ao criar (InvalidBlockDeviceMapping)."
  }
}

variable "nome_perfil_instancia" {
  description = "IAM instance profile pré-existente no Learner Lab. Não criamos role nenhuma — só é possível anexar a que já existe."
  type        = string
  default     = "LabInstanceProfile"
}

variable "nome_tabela_operacional" {
  description = "Nome da tabela DynamoDB de incidentes, evidências e hipóteses. Vira OPERATIONAL_TABLE_NAME na API."
  type        = string
  default     = "monitoracao-operacional"
}

variable "nome_tabela_golden_set" {
  description = "Nome da tabela DynamoDB de casos curados. Vira GOLDEN_SET_TABLE_NAME na API."
  type        = string
  default     = "monitoracao-golden-set"
}

variable "auth_email" {
  description = "E-mail do usuário de demonstração, comparado em texto plano pela API (não é um cadastro real)."
  type        = string
  default     = "demo@globoplay.com"
}

variable "auth_senha" {
  description = "Senha do usuário de demonstração. Troque do default se a demo ficar acessível por mais gente do que o esperado."
  type        = string
  default     = "demo123"
  sensitive   = true

  validation {
    # O valor vai para uma linha `Environment="AUTH_USER_PASSWORD=..."` de uma
    # unit do systemd (ver templates/user_data.sh.tftpl); aspas ou barra
    # invertida quebrariam o arquivo de um jeito que só aparece dentro do
    # bootstrap da instância, não no `plan`.
    condition     = !can(regex("[\"\\\\]", var.auth_senha))
    error_message = "auth_senha não pode conter aspas duplas nem barra invertida."
  }
}

variable "permitir_dado_exemplo" {
  description = <<-DESC
    Liga NEXT_PUBLIC_ALLOW_EXAMPLE_DATA no build do painel. Como esta infra não
    sobe a API de telemetria (Flask), as telas que dependem só dela mostram
    "indisponível" sem esta flag. Com `true`, mostram o conjunto de exemplo do
    próprio frontend, com o rótulo "Dados de exemplo" na tela — nunca um
    número sem procedência.
  DESC
  type        = bool
  default     = true
}

variable "ssh_cidr" {
  description = <<-DESC
    Bloco CIDR autorizado a entrar por SSH (porta 22). Deixe vazio para a
    própria máquina de quem está aplicando ser detectada automaticamente
    (recomendado). Só informe um valor se a detecção falhar ou se você quiser
    liberar de outro lugar.
  DESC
  type        = string
  default     = ""
}
