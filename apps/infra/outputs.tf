output "painel_url" {
  description = "Endereço do painel. É por aqui que se entra — o Amplify serve o Next.js e repassa /api, /auth e /health para o ALB."
  value       = local.painel_url
}

output "api_url" {
  description = "Endereço direto do ALB. Serve para curl e Postman; o navegador deve usar painel_url, porque uma página HTTPS não pode chamar uma API em HTTP."
  value       = "http://${aws_lb.principal.dns_name}"
}

output "credenciais_demo" {
  description = "Usuário aceito pelo login do painel."
  value       = "${var.auth_email} / ${var.auth_senha}"
  sensitive   = true
}

output "tabelas_dynamodb" {
  description = "Tabelas criadas."
  value = {
    operacional = aws_dynamodb_table.operacional.name
    golden_set  = aws_dynamodb_table.golden_set.name
  }
}

output "imagem_ecr" {
  description = "Imagem publicada no ECR e rodando na task."
  value       = local.uri_imagem
}

output "comando_logs" {
  description = "Acompanha o log da API em tempo real."
  value       = "aws logs tail ${aws_cloudwatch_log_group.api.name} --follow --region ${var.regiao}"
}

output "aviso_custo" {
  description = "Leia antes de fechar o laboratório."
  value       = "O ALB e a task Fargate NAO sao desligados pelo End Lab: so a EC2 e, e aqui nao ha EC2. Rode 'terraform destroy' ao fim de cada sessao, ou eles seguem cobrando ~US$ 25/mes do orcamento do lab."
}

output "api_url_https" {
  description = "Endereço HTTPS da API, via API Gateway. É para onde o Amplify repassa /api, /auth e /health."
  value       = aws_apigatewayv2_stage.default.invoke_url
}
