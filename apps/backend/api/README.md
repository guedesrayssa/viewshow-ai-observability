# API (monólito modular)

Única entrada pública do painel. Expõe `/health`, `/metrics`,
`GET /auth/session`, `GET /auth/login`, `GET /auth/callback`,
`POST /auth/logout` e `/api/v1/*`; valida a borda, aplica CORS/headers/rate
limit e propaga request e trace context.

Um único processo Express. A lógica de domínio vive em módulos internos sob
`src/modules/` (`auth`, `imports`, `incidents`, `dashboard`), cada um com suas camadas
`application` / `adapters` / `ports` / `domain`. Os módulos são chamados em
processo — não há servidores HTTP internos nem supervisor.

```bash
npm run build
AUTH_COOKIE_SECRET=... CURSOR_SECRET=... \
OPERATIONAL_TABLE_NAME=... AWS_REGION=us-east-1 npm start
```

`DYNAMODB_ENDPOINT` é opcional e direciona os adaptadores ao DynamoDB Local.
O teste vivo completo pode ser executado sem credenciais AWS reais:

```bash
npm run test:e2e-local
```

O comando inicia o container local, injeta credenciais dummy e executa build e
requisições HTTP reais. Em ambiente que já oferece o serviço, configure
`DYNAMODB_ENDPOINT` e execute `npm run test:e2e`.

O contrato de autenticação é federado e usa sessão assinada. Cognito/OIDC ainda
não tem adaptador operacional: login e callback falham fechado com
`503 FEATURE_UNAVAILABLE`; sessão ausente falha com `401 UNAUTHENTICATED` e
logout apenas expira o cookie. As rotas de importação estão registradas e
validadas, mas o adaptador S3/ingestão está indisponível. A reanálise também é
validada, porém a publicação na SQS está indisponível. Ambas respondem
`503 FEATURE_UNAVAILABLE` após autenticação válida, sem simulação ou fallback.

Contrato público: [`contracts/openapi/public.openapi.json`](contracts/openapi/public.openapi.json).

Testes de carga (k6): [`loadtest/README.md`](loadtest/README.md).
