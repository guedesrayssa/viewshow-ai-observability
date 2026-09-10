output "painel_url" {
  description = "Endereço do painel. É por aqui que se entra — o Amplify serve o Next.js e repassa /api, /auth e /health para o ALB."
  value       = local.painel_url
}

output "deployment_namespace" {
  description = "Namespace isolado que identifica todos os recursos desta stack."
  value       = var.deployment_namespace
}

output "api_url" {
  description = "Endereço direto do ALB. Serve para curl e Postman; o navegador deve usar painel_url, porque uma página HTTPS não pode chamar uma API em HTTP."
  value       = "http://${aws_lb.principal.dns_name}"
}

output "tabelas_dynamodb" {
  description = "Tabelas criadas."
  value = {
    operacional = aws_dynamodb_table.operacional.name
    golden_set  = aws_dynamodb_table.golden_set.name
  }
}

output "imagem_ecr" {
  description = "URI da imagem referenciada pela task ECS."
  value       = local.uri_imagem
}

output "comando_logs" {
  description = "Acompanha o log da API em tempo real."
  value       = "aws logs tail ${aws_cloudwatch_log_group.api.name} --follow --region ${var.regiao}"
}

output "aviso_custo" {
  description = "Leia antes de fechar o laboratório."
  value       = "Preserve a stack e o novo estado local ao fim da sessao para inspecao e diagnostico. Execute 'terraform destroy' somente sob pedido explicito posterior, usando esse mesmo estado. Enquanto provisionados, o ALB e a task Fargate continuam gerando custo."
}

output "api_url_https" {
  description = "Endereço HTTPS da API, via API Gateway. É para onde o Amplify repassa /api, /auth e /health."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "grafana_acesso" {
  description = "Acesso ao Grafana quando a observabilidade estiver habilitada. Por padrão, use o túnel SSM."
  value = var.observabilidade_habilitada ? {
    usuario    = "admin"
    url_direta = var.grafana_cidr_acesso == null ? null : "http://${aws_instance.observabilidade[0].public_dns}:3000"
    tunel_ssm  = "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3002 --region ${var.regiao}"
    url_tunel  = "http://localhost:3002"
  } : null
}

output "grafana_senha" {
  description = "Senha gerada para o usuário admin do Grafana."
  value       = var.observabilidade_habilitada ? random_password.grafana[0].result : null
  sensitive   = true
}

output "observabilidade_instancia_id" {
  description = "ID da EC2 que hospeda Grafana, Prometheus, Loki e Tempo."
  value       = var.observabilidade_habilitada ? aws_instance.observabilidade[0].id : null
}

output "comando_status_observabilidade" {
  description = "Abre uma sessão SSM na EC2 para verificar cloud-init e containers."
  value       = var.observabilidade_habilitada ? "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --region ${var.regiao}" : null
}
