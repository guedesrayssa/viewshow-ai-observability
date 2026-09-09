# Matriz de endpoints e ownership

| Endpoint público | Dono interno | Read model/port | Tela |
| --- | --- | --- | --- |
| `GET /api/v1/dashboard/overview` | Dashboard Query Service | `VIEW#OVERVIEW#GLOBAL#...` | Visão Geral |
| `GET /api/v1/incidents` | Incident Service | famílias de incidentes por hora/dia | Incidentes e gráfico |
| `GET /api/v1/incidents/{incidentId}/diagnosis` | Incident Service | incidente + hipótese/evidência persistidas | Evidências |
| `PATCH /api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review` | Incident Service + Identity | update condicional; sessão autenticada | Evidências |
| `GET /api/v1/incidents/{incidentId}/events` | Incident Service | agregado vinculado ao incidente, quando existir | Eventos |
| `GET /api/v1/incidents/{incidentId}/events/{eventId}` | Incident Service | `IndividualEventPort` futuro | detalhe de Eventos |
| `GET /api/v1/monitoring/overview` | Dashboard Query Service | `VIEW#MONITORING#...` | Monitoramento |
| `/auth/*` | Identity Service | provider configurável + sessão assinada | Autenticação |
| `GET /health` | Gateway | nenhum | ALB/smoke |
| `GET /metrics` | Gateway | registry em processo | observabilidade |

O gateway valida e envelopa; ele não acessa os read models diretamente.
Evento individual retorna 503 até uma fonte real existir. Diagnóstico nunca
dispara agente nesta entrega.
