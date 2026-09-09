// Stack LGTM do View Show na AWS.
//
// Uma única EC2 é deliberada para o Learner Lab: preserva a stack Grafana já
// usada localmente, custa menos do que quatro serviços Fargate e é parada pelo
// próprio laboratório ao fim da sessão. O desenho é adequado para demonstração
// e homologação; não oferece alta disponibilidade nem armazenamento distribuído.

data "aws_ssm_parameter" "amazon_linux_2023" {
  count = var.observabilidade_habilitada ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "random_password" "grafana" {
  count   = var.observabilidade_habilitada ? 1 : 0
  length  = 24
  special = false
}

resource "aws_security_group" "observabilidade" {
  count       = var.observabilidade_habilitada ? 1 : 0
  name        = "${var.nome_observabilidade}-sg"
  description = "Grafana via SSM; OTLP somente a partir da API ECS"
  vpc_id      = data.aws_vpc.default.id

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
  description              = "OTLP gRPC e HTTP enviados pela API no ECS"
  from_port                = 4317
  to_port                  = 4318
  protocol                 = "tcp"
  security_group_id        = aws_security_group.observabilidade[0].id
  source_security_group_id = aws_security_group.servico.id
}

locals {
  dashboard_observabilidade = var.observabilidade_habilitada ? templatefile(
    "${path.module}/observability/aws/view-show-aws.json.tftpl",
    {
      account_id        = data.aws_caller_identity.atual.account_id
      aws_region        = var.regiao
      cluster_name      = var.nome_cluster
      service_name      = var.nome_servico
      load_balancer     = aws_lb.principal.arn_suffix
      target_group      = aws_lb_target_group.api.arn_suffix
      operational_table = aws_dynamodb_table.operacional.name
      log_group         = aws_cloudwatch_log_group.api.name
    }
  ) : ""
}

resource "aws_instance" "observabilidade" {
  count                       = var.observabilidade_habilitada ? 1 : 0
  ami                         = data.aws_ssm_parameter.amazon_linux_2023[0].value
  instance_type               = var.tipo_instancia_observabilidade
  subnet_id                   = sort(data.aws_subnets.default.ids)[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.observabilidade[0].id]
  iam_instance_profile        = data.aws_iam_instance_profile.lab[0].name

  user_data = templatefile("${path.module}/observability/aws/user-data.sh.tftpl", {
    aws_region                 = var.regiao
    grafana_password_base64    = base64encode(random_password.grafana[0].result)
    compose_gzip               = base64gzip(file("${path.module}/observability/aws/docker-compose.yml"))
    prometheus_gzip            = base64gzip(file("${path.module}/observability/aws/prometheus.yml"))
    loki_gzip                  = base64gzip(file("${path.module}/observability/loki/loki-config.yml"))
    tempo_gzip                 = base64gzip(file("${path.module}/observability/tempo/tempo.yml"))
    datasources_gzip           = base64gzip(file("${path.module}/observability/grafana/provisioning/datasources/datasources.yml"))
    cloudwatch_datasource_gzip = base64gzip(file("${path.module}/observability/aws/cloudwatch-datasource.yml"))
    dashboard_provider_gzip    = base64gzip(file("${path.module}/observability/aws/dashboard-provider.yml"))
    dashboard_gzip             = base64gzip(local.dashboard_observabilidade)
  })

  // Uma mudança nas configurações recria a instância para que o cloud-init
  // seja realmente reaplicado. Os volumes Docker são descartáveis neste lab.
  user_data_replace_on_change = true

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
    Name    = var.nome_observabilidade
    Projeto = "view-show"
    Camada  = "observabilidade"
  }
}
