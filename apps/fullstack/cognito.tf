// User Pool do Cognito: o provedor de identidade que faltava para o login.
//
// Até esta sprint o contrato de identidade era exclusivamente federado (OIDC) e
// o adaptador corporativo nunca foi implementado, então POST /auth/login caía em
// 503 FEATURE_UNAVAILABLE. Este arquivo cria um User Pool próprio; a rota
// POST /auth/login (apps/backend/api/src/modules/auth) autentica usuário/senha
// contra ele pelo fluxo USER_PASSWORD_AUTH do InitiateAuth, sem passar pelo
// Hosted UI nem por SSO externo.
//
// O que NÃO está aqui, de propósito:
//   - Identity Pool: só serviria para trocar o token por credenciais AWS no
//     navegador. A API não precisa, e ele exigiria iam:CreateRole, que o AWS
//     Academy nega (mesma limitação de LabRole registrada em data.tf).
//   - Domínio custom no Hosted UI: exigiria certificado ACM e uma distribuição
//     CloudFront gerida pela AWS, e cloudfront:CreateDistribution é negado no
//     laboratório (ver apigateway.tf). Fica só o domínio de prefixo
//     *.auth.us-east-1.amazoncognito.com.
//   - Gatilhos Lambda e SES: a verificação de e-mail usa o remetente padrão do
//     Cognito (limite baixo, suficiente para a demonstração).

resource "aws_cognito_user_pool" "principal" {
  name = "${var.deployment_namespace}-user-pool"

  // Login por e-mail: o USERNAME enviado ao InitiateAuth é o próprio e-mail.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  // O laboratório recria a stack a cada sessão; proteção de exclusão deixaria o
  // `terraform destroy` travado, igual ao enable_deletion_protection = false do
  // ALB em alb.tf.
  deletion_protection = "INACTIVE"

  tags = {
    Projeto = "view-show"
  }
}

// Cliente confidencial, usado só pelo backend em Fargate. Como nunca chega ao
// navegador, pode ter secret — e por ter secret, o backend precisa enviar
// SECRET_HASH em cada InitiateAuth (ver cognito-password-authenticator.ts).
resource "aws_cognito_user_pool_client" "backend" {
  name         = "${var.deployment_namespace}-backend-client"
  user_pool_id = aws_cognito_user_pool.principal.id

  generate_secret = true

  // ALLOW_USER_PASSWORD_AUTH é obrigatório para o InitiateAuth com usuário e
  // senha; sem ele o Cognito devolve InvalidParameterException mesmo com a
  // credencial correta. O REFRESH_TOKEN_AUTH acompanha para permitir renovar o
  // token sem novo login.
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  // Janela alinhada à sessão HMAC de 8h emitida em app.ts (issueSession).
  access_token_validity  = 8
  id_token_validity      = 8
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  // Credencial inválida e usuário inexistente voltam ambos como
  // NotAuthorizedException, sem revelar qual dos dois foi.
  prevent_user_existence_errors = "ENABLED"

  supported_identity_providers = ["COGNITO"]

  // Sem OAuth/Hosted UI: este cliente só faz InitiateAuth server-side. Um fluxo
  // de redirecionamento (PKCE, callback_urls) precisaria de um segundo cliente,
  // público.
}

// Domínio de prefixo do Hosted UI. A rota POST /auth/login não usa, mas ele
// habilita o endpoint OIDC (issuer abaixo) para uma futura integração pelo
// caminho já previsto em src/modules/auth/config.ts (OIDC_ISSUER_URL).
resource "aws_cognito_user_pool_domain" "principal" {
  // O prefixo do Hosted UI é único GLOBALMENTE por região, não por conta. Com
  // `${var.deployment_namespace}-auth` fixo, a primeira conta que aplicar toma
  // o nome e todas as outras falham com "Domain already associated with
  // another user pool" — inclusive entre contas do Learner Lab de pessoas
  // diferentes, que é como o erro apareceu. O ID da conta mantém o nome estável
  // para quem aplica e livre de colisão entre contas.
  domain       = "${var.deployment_namespace}-${data.aws_caller_identity.atual.account_id}-iac-auth"
  user_pool_id = aws_cognito_user_pool.principal.id
}

output "cognito_user_pool_id" {
  description = "ID do User Pool. Vai para COGNITO_USER_POOL_ID na task ECS."
  value       = aws_cognito_user_pool.principal.id
}

output "cognito_client_id" {
  description = "ID do cliente confidencial do backend. Vai para COGNITO_CLIENT_ID na task ECS."
  value       = aws_cognito_user_pool_client.backend.id
}

output "cognito_client_secret" {
  description = "Segredo do cliente do backend. Vai para COGNITO_CLIENT_SECRET na task ECS."
  value       = aws_cognito_user_pool_client.backend.client_secret
  sensitive   = true
}

output "cognito_issuer_url" {
  description = "Issuer OIDC do User Pool, para o caminho OIDC_ISSUER_URL já previsto no backend."
  value       = "https://cognito-idp.${var.regiao}.amazonaws.com/${aws_cognito_user_pool.principal.id}"
}

output "cognito_hosted_ui_base_url" {
  description = "Base do Hosted UI (domínio de prefixo; sem domínio custom no laboratório)."
  value       = "https://${aws_cognito_user_pool_domain.principal.domain}.auth.${var.regiao}.amazoncognito.com"
}
