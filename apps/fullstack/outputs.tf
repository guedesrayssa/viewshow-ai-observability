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

output "comando_seed" {
  description = "Repovoa as tabelas sem precisar de um apply inteiro. Rode de novo se o painel abrir vazio: o dado sai da janela de 24 h."
  value       = "cd ../backend/api && AWS_REGION=${var.regiao} OPERATIONAL_TABLE_NAME=${aws_dynamodb_table.operacional.name} GOLDEN_SET_TABLE_NAME=${aws_dynamodb_table.golden_set.name} npm run seed"
}

output "aviso_custo" {
  description = "Leia antes de fechar o laboratório."
  value       = "O End Lab para a EC2 de observabilidade, mas o EBS, o ALB e a task Fargate continuam cobrando. Rode 'terraform destroy' ao fim de cada sessao se nao precisar preservar o ambiente."
}

output "api_url_https" {
  description = "Endereço HTTPS da API, via API Gateway. É para onde o Amplify repassa /api, /auth e /health."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "grafana_acesso" {
  description = "Acesso ao Grafana. Por padrão use o túnel SSM; com grafana_cidr_acesso definido, use a URL direta."
  value = var.observabilidade_habilitada ? {
    usuario    = "admin"
    url_direta = var.grafana_cidr_acesso == null ? null : "http://${aws_instance.observabilidade[0].public_dns}:3000"
    tunel_ssm  = "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3002 --region ${var.regiao}"
    url_tunel  = "http://localhost:3002"
  } : null
}

output "grafana_senha" {
  description = "Senha do usuário admin do Grafana."
  value       = var.observabilidade_habilitada ? random_password.grafana[0].result : null
  sensitive   = true
}

output "observabilidade_instancia_id" {
  description = "ID da EC2 que hospeda Grafana, Prometheus, Loki e Tempo."
  value       = var.observabilidade_habilitada ? aws_instance.observabilidade[0].id : null
}

output "comando_status_observabilidade" {
  description = "Abre uma sessão SSM na EC2 para verificar cloud-init e os containers."
  value       = var.observabilidade_habilitada ? "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --region ${var.regiao}" : null
}
