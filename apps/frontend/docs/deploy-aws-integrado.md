# Deploy integrado do frontend

O painel continua sendo exportado estaticamente e publicado no Amplify. A
infraestrutura em [`apps/fullstack`](../../fullstack) é a fonte de verdade
operacional; o artefato de integração correspondente é a
[integração fullstack](../../../artefatos/sprint3/infraestrutura-integracao.md).

```text
navegador -> Amplify (mesma origem)
          -> API Gateway AWS -> ALB -> ECS :3000
                                      -> API TypeScript/Express
```

O build recebe somente:

```text
NEXT_PUBLIC_API_BASE_URL=/
```

O Amplify encaminha `/api/*`, `/auth/*` e `/health` ao ingresso atual. Cookies
`Secure`, `HttpOnly` e `SameSite=Lax` permanecem same-origin.

## Build e verificação

```bash
cd apps/frontend
npm ci
npm run lint
npm run typecheck
npm test
npm run build
test -f out/index.html
```

Depois da publicação:

```bash
curl -i "$PAINEL_URL/health"
curl -i "$PAINEL_URL/api/v1/incidents?window=24h"
```

Health deve ser exatamente `{"status":"ok"}`. A listagem devolve envelope
`data/meta`; sem read model, retorna vazio/parcial ou erro estável, nunca seed
inventado pelo backend.

## Autenticação nesta fase

O frontend usa somente a superfície federada: `GET /auth/session`,
`GET /auth/login`, `GET /auth/callback` e `POST /auth/logout`. Não existe fluxo
público de e-mail e senha. Até o adaptador Cognito/OIDC corporativo estar
disponível, login e callback falham fechado com `503 FEATURE_UNAVAILABLE`; uma
sessão ausente retorna `401 UNAUTHENTICATED`. Isso é uma pendência externa
explícita, sem autenticação simulada em produção.

As rotas de importação e reanálise já fazem validação de borda e autenticação,
mas seus adaptadores de S3/ingestão e publicação SQS estão definidos como
indisponíveis. Uma chamada autenticada recebe `503 FEATURE_UNAVAILABLE`, sem
fabricar job ou mensagem.

## Compatibilidade AWS

Foram preservados ECR, cluster, ECS Service, task family, nome do container,
porta 3000, ALB, API Gateway, Amplify, CloudWatch e tabelas DynamoDB. O runtime
inicia um único processo Express, organizado internamente em módulos.

O job `validate_backend` do GitLab CI usa DynamoDB Local como serviço, com
`DYNAMODB_ENDPOINT=http://dynamodb:8000` e credenciais dummy, e executa
`npm run test:e2e` depois da suíte regular. Localmente, a mesma superfície viva
é exercitada por `npm run test:e2e-local` em `apps/backend/api`. Os testes de
contrato cobrem a paridade entre manifesto, OpenAPI e rotas Express. O E2E vivo
cobre leituras e revisão no DynamoDB, autenticação federada e os limites
fail-closed de importação e publicação SQS sem acessar a AWS.

Para custos do Learner Lab, revise o plano antes de aplicar ou destruir. Esta
entrega não executa deploy, `terraform apply` ou `terraform destroy`.
