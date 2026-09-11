// O Application Load Balancer, o target group e o listener.
//
// Na conta compartilhada o ALB já existia (era do job de ingestão) e a API foi
// pendurada nele como uma regra de listener de prioridade 10, preservando a
// ação padrão que servia o job. Aqui não há job de ingestão — o código dele não
// está neste repositório —, então o ALB é criado do zero e a ação padrão do
// listener já aponta para a API. A forma do target group e do health check é a
// mesma da Tabela 7 de backend-sprint-2.md.

resource "aws_lb" "principal" {
  name               = local.nome_alb
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = values(aws_subnet.publica)[*].id

  // Num laboratório o destroy precisa passar sem intervenção manual.
  enable_deletion_protection = false

  tags = {
    Projeto = "view-show"
  }
}

resource "aws_lb_target_group" "api" {
  name     = local.nome_target_group
  port     = 3000
  protocol = "HTTP"
  vpc_id   = aws_vpc.principal.id

  // "ip" e não "instance": Fargate com awsvpc registra ENIs, não instâncias.
  target_type = "ip"

  health_check {
    enabled = true
    path    = "/health"
    matcher = "200"

    // GET /health responde sem tocar em DynamoDB nem em Bedrock
    // (apps/backend/api/src/app.ts), então pode ser agressivo sem custo.
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  // Dá tempo de a task antiga terminar as respostas em curso durante um deploy;
  // o padrão de 300s deixaria o destroy travado à toa.
  deregistration_delay = 15

  tags = {
    Projeto = "view-show"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
