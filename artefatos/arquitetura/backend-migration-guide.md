# Guia de migração do backend operacional

## Rotas e variáveis

O frontend usa apenas `NEXT_PUBLIC_API_BASE_URL`. Remova de ambientes correntes
`NEXT_PUBLIC_TELEMETRY_API_BASE_URL`; nenhuma rota `/v1/analytics/*` faz parte
do runtime vigente.

| Legado | Atual |
| --- | --- |
| múltiplas chamadas Flask de overview | `GET /api/v1/dashboard/overview` |
| incidente/evidence/hypothesis separados | `GET /api/v1/incidents/{id}/diagnosis` |
| série Flask de eventos | `GET /api/v1/incidents/{id}/events` |
| topologia Flask | `GET /api/v1/monitoring/overview` |
| `/hypothesis/review` com status apenas | `/hypotheses/{hypothesisId}/review` com `expectedVersion` |

As rotas públicas de golden set, ML, Bedrock e execução de diagnóstico não
existem mais. O JavaScript legado permanece apenas como material congelado fora
do build/runtime.

## Configuração

- Gateway: `INTERNAL_AUTH_TOKEN`, URLs internas, `FRONTEND_ORIGINS` (ou o
  singular legado `FRONTEND_ORIGIN`), timeout e flag de métricas.
- Incident: tabela operacional, região, internal token e cursor secret.
- Dashboard: tabela, região, fontes monitoradas e internal token.
- Identity: cookie secret, internal token e provider. O adapter de dev exige
  opt-in e é proibido em produção.

Não há fallback de credencial, usuário ou dado em produção.

## Documentos históricos preservados

Os arquivos abaixo ainda citam `apps/basica` como parte da história do MVP e
não devem ser interpretados como documentação de runtime vigente:

- `artefatos/mvp-inicial.md`
- `artefatos/backend.md`
- `artefatos/deploy-aws.md`
- documentos sob `artefatos/sprint1`, `artefatos/sprint2` e `artefatos/sprint3`
- slides e relatórios produzidos durante essas sprints

Documentação corrente: README raiz, `apps/backend/README.md`, OpenAPI e este
guia.
