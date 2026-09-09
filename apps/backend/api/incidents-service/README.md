# Incident Service

Dono das famílias físicas de incidente, hipótese, evidência e revisão. Lista
com filtros/cursor, lê diagnóstico já persistido, declara resultados
agênticos/eventos ausentes e grava revisão com `ConditionExpression`.

Não executa Bedrock, ML ou agente. `ReviewFeedbackPort` e
`AgenticDiagnosisPort` são fronteiras reservadas; a revisão persistida não
depende delas.

```bash
npm run build
INTERNAL_AUTH_TOKEN=... CURSOR_SECRET=... OPERATIONAL_TABLE_NAME=... \
npm run start:incidents
```

Health isolado: `GET http://127.0.0.1:3001/health`.
