# Deploy integrado do frontend

O painel continua sendo exportado estaticamente e publicado no Amplify. A
infraestrutura em `apps/infra` é a fonte de verdade operacional e não foi
alterada nesta refatoração.

```text
navegador -> Amplify (mesma origem)
          -> API Gateway AWS -> ALB -> ECS :3000
                                      |
                                      +-> supervisor multiprocesso
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
npx tsc --noEmit
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

As variáveis históricas de e-mail/senha da task não são consumidas pelo novo
Identity Service. Login local é proibido em produção. Até um provider OIDC/SSO
corporativo ser configurado, `/auth/login`, cadastro, recuperação e SSO falham
fechado com `FEATURE_UNAVAILABLE`. Isso é uma pendência externa explícita.

## Compatibilidade AWS

Foram preservados ECR, cluster, ECS Service, task family, nome do container,
porta 3000, ALB, API Gateway, Amplify, CloudWatch e tabelas DynamoDB. O runtime
inicia quatro processos no mesmo container por limitação do laboratório; só o
gateway fica público.

O GitLab CI constrói o contexto `apps/backend/api` e executa smoke de health e
de `/auth/register`, cuja resposta 503 controlada comprova gateway → Identity
sem fabricar um provider.

Para custos do Learner Lab, revise o plano antes de aplicar ou destruir. Esta
entrega não executa deploy, `terraform apply` ou `terraform destroy`.
