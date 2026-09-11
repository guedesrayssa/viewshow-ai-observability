# Camada de dados

Todas as telas falam apenas com o gateway configurado por
`NEXT_PUBLIC_API_BASE_URL`:

```text
view -> useResource -> *-resource -> client -> gateway /api/v1
                                      |
                                      +-> { data, meta } ou { error }
```

`client.ts` usa timeout de oito segundos, `cache: no-store` e
`credentials: include`. O envelope público fornece `requestId`, versão,
partialidade, freshness, warnings, janela resolvida e `refreshAfterSeconds`.
Esses campos acompanham o `Resource<T>`; valores ausentes não viram zero.

`availability` pode ser `measured`, `partial` ou `unavailable`. Erros HTTP
preservam status, code e requestId. Quando não há configuração ou uma leitura
falha, o resource devolve indisponibilidade, não dado plausível.

Fixtures dos arquivos `*-data.ts` só entram quando
`NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true` em desenvolvimento/teste. O modo é
forçado para `false` em produção.

## Endpoints consumidos

| Tela | Endpoint |
| --- | --- |
| Visão Geral | `GET /api/v1/dashboard/overview` |
| Incidentes | `GET /api/v1/incidents` |
| Evidências | `GET /api/v1/incidents/{id}/diagnosis` |
| Revisão | `PATCH /api/v1/incidents/{id}/hypotheses/{hypothesisId}/review` |
| Eventos | `GET /api/v1/incidents/{id}/events` |
| Monitoramento | `GET /api/v1/monitoring/overview` |

Eventos não elegem incidente silenciosamente. Sem `incidentId`, o resource
declara `INCIDENT_REQUIRED`. Evento agregado não é convertido em item
individual. A revisão utiliza a versão recebida no diagnóstico e trata 409.

Os mapeadores copiam somente campos públicos; chaves DynamoDB não fazem parte
dos tipos de resposta. Testes em `tests/` cobrem measured/partial/unavailable,
erros com requestId, mapeadores, revisão otimista, flag de fixtures e busca
estática por referências retiradas.
