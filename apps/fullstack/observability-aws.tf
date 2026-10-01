// Stack LGTM do View Show na AWS.
//
// Uma única EC2 é deliberada para o Learner Lab: preserva a stack Grafana já
// usada localmente, custa menos do que quatro serviços Kubernetes e é parada pelo
// próprio laboratório ao fim da sessão. O desenho é adequado para demonstração
// e homologação; não oferece alta disponibilidade nem armazenamento distribuído.

resource "random_password" "grafana" {
  count   = var.observabilidade_habilitada ? 1 : 0
  length  = 24
  special = false
}

resource "aws_security_group" "observabilidade" {
  count = var.observabilidade_habilitada ? 1 : 0
  name  = "${local.nome_observabilidade}-sg"
  // Keep the original immutable description to preserve the existing SG.
  description = "Grafana via SSM; telemetria somente a partir dos servicos ECS"
  vpc_id      = aws_vpc.principal.id

  dynamic "ingress" {
    for_each = var.grafana_cidr_acesso == null ? [] : [var.grafana_cidr_acesso]
    content {
      description = "Grafana restrito ao CIDR informado"
      from_port   = 3000
      to_port     = 3000
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    description = "Pull das imagens e acesso as APIs AWS"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Projeto = "view-show"
    Camada  = "observabilidade"
  }
}

resource "aws_security_group_rule" "otlp_api" {
  count                    = var.observabilidade_habilitada ? 1 : 0
  type                     = "ingress"
  description              = "OTLP HTTP enviado pela API no EKS"
  from_port                = 4318
  to_port                  = 4318
  protocol                 = "tcp"
  security_group_id        = aws_security_group.observabilidade[0].id
  source_security_group_id = aws_security_group.servico.id
}

resource "aws_security_group_rule" "loki_api" {
  count                    = var.observabilidade_habilitada ? 1 : 0
  type                     = "ingress"
  description              = "Logs estruturados enviados pela API no EKS"
  from_port                = 3100
  to_port                  = 3100
  protocol                 = "tcp"
  security_group_id        = aws_security_group.observabilidade[0].id
  source_security_group_id = aws_security_group.servico.id
}

resource "aws_security_group_rule" "otlp_workers" {
  count                    = var.observabilidade_habilitada ? 1 : 0
  type                     = "ingress"
  description              = "OTLP HTTP enviado pelos workers no EKS ao Alloy"
  from_port                = 4320
  to_port                  = 4320
  protocol                 = "tcp"
  security_group_id        = aws_security_group.observabilidade[0].id
  source_security_group_id = aws_security_group.servico.id
}

resource "aws_security_group_rule" "ssh_bastion_observabilidade" {
  count                    = var.observabilidade_habilitada ? 1 : 0
  type                     = "ingress"
  description              = "SSH administrativo somente a partir do bastion"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  security_group_id        = aws_security_group.observabilidade[0].id
  source_security_group_id = aws_security_group.bastion.id
}

locals {
  dashboard_observabilidade = var.observabilidade_habilitada ? templatefile(
    "${path.module}/observability/aws/view-show-aws.json.tftpl",
    {
      account_id        = data.aws_caller_identity.atual.account_id
      aws_region        = var.regiao
      cluster_name      = local.nome_cluster
      namespace         = var.deployment_namespace
      service_name      = local.nome_servico
      load_balancer     = aws_lb.principal.arn_suffix
      target_group      = aws_lb_target_group.api.arn_suffix
      operational_table = aws_dynamodb_table.operacional.name
      log_group         = aws_cloudwatch_log_group.kubernetes_application.name
    }
  ) : ""
}

resource "aws_instance" "observabilidade" {
  count                       = var.observabilidade_habilitada ? 1 : 0
  ami                         = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type               = var.tipo_instancia_observabilidade
  subnet_id                   = aws_subnet.privada["a"].id
  associate_public_ip_address = false
  vpc_security_group_ids      = [aws_security_group.observabilidade[0].id]
  iam_instance_profile        = local.administration_profiles["observabilidade"]

  user_data = templatefile("${path.module}/observability/aws/user-data.sh.tftpl", {
    aws_region              = var.regiao
    grafana_password_base64 = base64encode(random_password.grafana[0].result)
    compose_gzip            = base64gzip(file("${path.module}/observability/aws/docker-compose.yml"))
    prometheus_gzip = base64gzip(replace(
      file("${path.module}/observability/aws/prometheus.yml"),
      "__API_TARGET__",
      "${aws_lb.principal.dns_name}:80"
    ))
    prometheus_rules_gzip      = base64gzip(file("${path.module}/observability/prometheus/rules/view-show.yml"))
    alloy_gzip                 = base64gzip(file("${path.module}/observability/alloy/config.alloy"))
    loki_gzip                  = base64gzip(file("${path.module}/observability/loki/loki-config.yml"))
    tempo_gzip                 = base64gzip(file("${path.module}/observability/tempo/tempo.yml"))
    datasources_gzip           = base64gzip(file("${path.module}/observability/grafana/provisioning/datasources/datasources.yml"))
    cloudwatch_datasource_gzip = base64gzip(file("${path.module}/observability/aws/cloudwatch-datasource.yml"))
    dashboard_provider_gzip    = base64gzip(file("${path.module}/observability/aws/dashboard-provider.yml"))
    dashboard_gzip             = base64gzip(local.dashboard_observabilidade)
    application_dashboard_gzip = base64gzip(file("${path.module}/observability/grafana/provisioning/dashboards/json/view-show-overview.json"))
    // O dashboard RED (latência p95, throughput, erros/s e CPU) ficava de fora
    // do provisionamento na AWS: só a pilha local o recebia. São exatamente os
    // quatro indicadores que o artefato de testes de carga precisa mostrar, e
    // sem esta linha eles não existem no Grafana da nuvem.
    api_dashboard_gzip = base64gzip(file("${path.module}/observability/grafana/provisioning/dashboards/json/view-show-api.json"))
  })

  // Preserve historical volumes; deploy.mjs updates the dashboard through SSM.
  user_data_replace_on_change = false
  lifecycle {
    ignore_changes = [user_data]
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 // permite ao Grafana em Docker usar a role EC2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.disco_observabilidade_gib
    encrypted             = true
    delete_on_termination = true

    tags = {
      Projeto = "view-show"
      Camada  = "observabilidade"
    }
  }

  tags = {
    Name    = local.nome_observabilidade
    Projeto = "view-show"
    Camada  = "observabilidade"
  }
}
