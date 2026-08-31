output "painel_url" {
  description = "Endereço do painel. Abra depois de esperar o bootstrap (ver `tempo_estimado_boot`)."
  value       = "http://${aws_eip.app.public_ip}"
}

output "ip_publico" {
  description = "Elastic IP associado à instância. Não muda entre sessões do laboratório."
  value       = aws_eip.app.public_ip
}

output "comando_ssh" {
  description = "Conexão SSH de depuração, já com a chave gerada por este apply."
  value       = "ssh -i ${local_sensitive_file.chave_privada.filename} ec2-user@${aws_eip.app.public_ip}"
}

output "comando_seed" {
  description = "Repete a semeadura de dados manualmente, sem esperar a instância reiniciar."
  value       = "ssh -i ${local_sensitive_file.chave_privada.filename} ec2-user@${aws_eip.app.public_ip} 'cd /srv/app/api && AWS_REGION=${var.regiao} OPERATIONAL_TABLE_NAME=${var.nome_tabela_operacional} GOLDEN_SET_TABLE_NAME=${var.nome_tabela_golden_set} npm run seed'"
}

output "comando_logs_bootstrap" {
  description = "Acompanha o provisionamento dentro da instância em tempo real, útil nos primeiros minutos após o apply."
  value       = "ssh -i ${local_sensitive_file.chave_privada.filename} ec2-user@${aws_eip.app.public_ip} 'tail -f /var/log/g05-bootstrap.log'"
}

output "tempo_estimado_boot" {
  description = "Tempo entre a instância ficar `running` e o painel responder: instalar Node/nginx, `npm ci` das duas aplicações, o build do Next e a semeadura."
  value       = "3 a 4 minutos após o apply terminar"
}

output "tabela_operacional" {
  value = aws_dynamodb_table.operacional.name
}

output "tabela_golden_set" {
  value = aws_dynamodb_table.golden_set.name
}
