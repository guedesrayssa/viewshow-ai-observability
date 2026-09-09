# API (monólito modular)

Única entrada pública do painel. Expõe `/health`, `/metrics`, `/auth/*` e
`/api/v1/*`; valida a borda, aplica CORS/headers/rate limit e propaga request e
trace context.

Um único processo Express. A lógica de domínio vive em módulos internos sob
`src/modules/` (`auth`, `incidents`, `dashboard`), cada um com suas camadas
`application` / `adapters` / `ports` / `domain`. Os módulos são chamados em
processo — não há servidores HTTP internos nem supervisor.

```bash
npm run build
AUTH_COOKIE_SECRET=... CURSOR_SECRET=... \
OPERATIONAL_TABLE_NAME=... AWS_REGION=us-east-1 npm start
```

Contratos: [`contracts/openapi/public.openapi.json`](contracts/openapi/public.openapi.json)
e [`contracts/openapi/internal.openapi.json`](contracts/openapi/internal.openapi.json).
