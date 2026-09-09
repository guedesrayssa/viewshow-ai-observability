// API Gateway HTTP API na frente do ALB, servindo só como terminação TLS.
//
// Por que ele existe: o Amplify recusa alvo HTTP numa regra de proxy
// ("HTTP URLs cannot be used in custom rules. Use HTTPS instead."), e o ALB não
// tem como falar HTTPS sem certificado — o que exigiria um domínio próprio, que
// o laboratório não fornece.
//
// O caminho natural seria CloudFront, mas ele é negado no AWS Academy:
// cloudfront:CreateDistribution devolve AccessDenied (testado nesta conta). O
// API Gateway é permitido, e entrega o que falta: um endereço HTTPS com
// certificado válido da própria AWS, em *.execute-api.amazonaws.com, sem
// domínio nenhum. Certificado autoassinado no ALB seria a outra saída, mas o
// proxy do Amplify provavelmente o rejeitaria na validação.
//
// Ele não substitui nada da arquitetura entregue: o painel continua no Amplify,
// a API continua em Fargate atrás do ALB. Isto é um degrau de TLS entre os
// dois, e é o que torna o login possível — sem ele, o navegador bloqueia por
// conteúdo misto uma página HTTPS chamando uma API em HTTP.

resource "aws_apigatewayv2_api" "tls" {
  name          = local.nome_api_gateway
  protocol_type = "HTTP"
  description   = "Terminacao TLS para o ALB da API operacional"

  tags = {
    Projeto = "view-show"
  }
}

// HTTP_PROXY repassa método, caminho, query string, cabeçalhos e corpo sem
// interpretar nada — inclusive o Cookie da requisição e o Set-Cookie da
// resposta, que é o que a sessão depende.
resource "aws_apigatewayv2_integration" "alb" {
  api_id                 = aws_apigatewayv2_api.tls.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "http://${aws_lb.principal.dns_name}/{proxy}"
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.tls.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

// $default deixa o estágio responder na raiz do domínio, sem prefixo de
// estágio na URL.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.tls.id
  name        = "$default"
  auto_deploy = true

  tags = {
    Projeto = "view-show"
  }
}
