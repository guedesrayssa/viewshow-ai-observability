# API Gateway/BFF

Única entrada pública do painel. Expõe `/health`, `/metrics`, `/auth/*` e
`/api/v1/*`; valida a borda, aplica CORS/headers/rate limit, propaga request e
trace context e chama serviços internos via HTTP com timeout, abort, retry
limitado para GET e circuit breaker simples.

O gateway não importa implementações internas e não possui adapter DynamoDB.

```bash
npm run build
INTERNAL_AUTH_TOKEN=... INCIDENTS_SERVICE_URL=http://127.0.0.1:3001 \
DASHBOARD_QUERY_SERVICE_URL=http://127.0.0.1:3002 \
IDENTITY_SERVICE_URL=http://127.0.0.1:3003 npm start
```

Contratos: [`contracts/openapi/public.openapi.json`](contracts/openapi/public.openapi.json)
e [`contracts/openapi/internal.openapi.json`](contracts/openapi/internal.openapi.json).
