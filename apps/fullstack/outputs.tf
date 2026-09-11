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

output "rede_vpc" {
  description = "Identificadores da VPC e das sub-redes para conferência no console."
  value = {
    vpc_id            = aws_vpc.principal.id
    subredes_publicas = { for chave, subnet in aws_subnet.publica : chave => subnet.id }
    subredes_privadas = { for chave, subnet in aws_subnet.privada : chave => subnet.id }
    nat_gateway_id    = aws_nat_gateway.principal.id
  }
}

output "bastion_acesso" {
  description = "Identificação e comandos de acesso ao bastion. SSH só aparece quando um CIDR administrativo foi autorizado."
  value = {
    instancia_id = aws_instance.bastion.id
    ip_publico   = aws_instance.bastion.public_ip
    sessao_ssm   = "aws ssm start-session --target ${aws_instance.bastion.id} --region ${var.regiao}"
    ssh          = var.bastion_admin_cidr == null ? null : "ssh ec2-user@${aws_instance.bastion.public_ip}"
  }
}

output "flow_logs" {
  description = "Destino e identificador dos VPC Flow Logs."
  value = {
    flow_log_id = aws_flow_log.vpc.id
    bucket      = local.nome_bucket_flow_logs
    prefixo     = "vpc-flow-logs/AWSLogs/${data.aws_caller_identity.atual.account_id}"
  }
}

output "ecs_auto_scaling" {
  description = "Limites e alvo da política de escalonamento das tasks Fargate."
  value = {
    minimo   = aws_appautoscaling_target.api.min_capacity
    maximo   = aws_appautoscaling_target.api.max_capacity
    cpu_alvo = var.ecs_cpu_alvo
    politica = aws_appautoscaling_policy.cpu_api.name
  }
}

output "aviso_custo" {
  description = "Leia antes de fechar o laboratório."
  value       = "Preserve a stack e o novo estado local ao fim da sessao para inspecao e diagnostico. Execute 'terraform destroy' somente sob pedido explicito posterior, usando esse mesmo estado. Enquanto provisionados, ALB, NAT Gateway, bastion, tasks Fargate e a EC2 opcional de observabilidade continuam gerando custo."
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
  description = "ID da EC2 que hospeda Grafana, Prometheus, Loki, Tempo e Alloy."
  value       = var.observabilidade_habilitada ? aws_instance.observabilidade[0].id : null
}

output "observabilidade_otlp_workers_endpoint" {
  description = "Endpoint OTLP/HTTP privado do Alloy para os futuros workers ECS que usam o security group da aplicacao."
  value       = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:4320" : null
}

output "observabilidade_loki_push_url" {
  description = "URL privada para envio assíncrono dos logs estruturados da API."
  value       = var.observabilidade_habilitada ? "http://${aws_instance.observabilidade[0].private_ip}:3100/loki/api/v1/push" : null
}

output "comando_status_observabilidade" {
  description = "Abre uma sessão SSM na EC2 para verificar cloud-init e containers."
  value       = var.observabilidade_habilitada ? "aws ssm start-session --target ${aws_instance.observabilidade[0].id} --region ${var.regiao}" : null
}
