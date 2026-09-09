# Dashboard Query Service

Consome projeções de visão geral e monitoramento já publicadas nas famílias
`VIEW#...`. Interpreta janela, filtros permitidos, coverage e freshness. Não
calcula projeções nem faz joins por Scan.

```bash
npm run build
INTERNAL_AUTH_TOKEN=... OPERATIONAL_TABLE_NAME=... \
npm run start:dashboard-query
```

Health isolado: `GET http://127.0.0.1:3002/health`.
