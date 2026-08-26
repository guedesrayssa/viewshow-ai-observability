# Contrato da API operacional do dashboard

Status: proposta para revisão  
Versão do contrato: 1.0  
Base HTTP: /api/v1  
Formato: JSON  
Idioma dos identificadores técnicos: inglês  
Idioma de apresentação: responsabilidade do frontend

## 1. Objetivo

Este documento define o contrato HTTP entre o backend Node/Express e o
frontend Next.js do dashboard operacional. Ele descreve somente a interface
pública: endpoints, parâmetros, respostas, enums, erros, paginação,
parcialidade, frescor e regras de privacidade.

O contrato é independente da origem física dos dados. Na primeira versão, os
dados operacionais vêm do Argus, são normalizados e materializados antes de
serem consultados pelo backend. Uma troca futura da origem não deve exigir
alterações nos componentes do frontend.

## 2. Escopo

Incluído:

- Visão Geral.
- Listagem e filtros de incidentes.
- Diagnóstico e evidências.
- Revisão humana de hipótese.
- Eventos correlacionados.
- Monitoramento operacional.
- Estados de carregamento parcial, atraso e indisponibilidade.

Fora do escopo desta versão:

- Login, logout, recuperação de senha e SSO.
- Perfis e autorização de usuários.
- Configurações do dashboard.
- Endpoints internos de ML, orquestração e golden set.
- O backend Flask inicial e sua tabela telemetry.
- BigQuery.

A mutação de revisão de hipótese está especificada, mas só pode ser habilitada
em ambiente real quando a identidade do revisor for obtida de uma sessão
autenticada no servidor.

## 3. Catálogo de endpoints

| Método | Caminho | Responsabilidade |
|---|---|---|
| GET | /api/v1/dashboard/overview | Visão Geral completa |
| GET | /api/v1/incidents | Lista, gráfico, filtros e facetas de incidentes |
| GET | /api/v1/incidents/{incidentId}/diagnosis | Incidente, diagnóstico, evidências, séries e timeline |
| PATCH | /api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review | Revisão humana de uma hipótese |
| GET | /api/v1/incidents/{incidentId}/events | Agregados e eventos correlacionados |
| GET | /api/v1/incidents/{incidentId}/events/{eventId} | Evento normalizado e origem sanitizada |
| GET | /api/v1/monitoring/overview | Saúde das fontes e do pipeline |

## 4. Convenções comuns

### 4.1 Datas e janelas

- Todo timestamp usa ISO 8601 em UTC.
- Datas incluem o sufixo Z.
- Quando from e to forem aceitos, devem ser enviados juntos.
- from/to não podem ser combinados com window.
- O backend resolve a janela efetiva e a devolve em meta.window.

### 4.2 Números e unidades

- Números são retornados como JSON number.
- A API não devolve valores formatados como “12,4 mil” ou “há 18 min”.
- confidence, probability, share e coverageRatio variam de 0 a 1.
- changeRatio é uma variação decimal com sinal e pode ultrapassar 1 em
  aumentos superiores a 100%.
- Quantidades medidas sem ocorrências usam 0.
- Quantidades não medidas ou indisponíveis usam null.
- O frontend é responsável por localização, casas decimais e abreviações.

### 4.3 Identificadores

- IDs são opacos e estáveis.
- number é o identificador humano de um incidente, como INC-4821.
- O frontend não interpreta a estrutura interna de um ID.
- pk, sk, GSI, TTL e outros campos internos nunca aparecem na API pública.

### 4.4 Enums

- Enums usam valores técnicos estáveis em inglês.
- O frontend traduz os rótulos para português.
- A inclusão de um novo valor de enum exige atualização compatível do
  contrato e tratamento de fallback no frontend.

### 4.5 Envelope de sucesso

~~~json
{
  "data": {},
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:11:30.000Z",
    "window": {
      "preset": "30m",
      "from": "2026-08-26T17:41:30.000Z",
      "to": "2026-08-26T18:11:30.000Z"
    },
    "partial": false,
    "refreshAfterSeconds": 30,
    "freshness": [
      {
        "source": "argus",
        "observedThrough": "2026-08-26T18:11:00.000Z",
        "lagSeconds": 30,
        "state": "fresh"
      }
    ],
    "warnings": []
  }
}
~~~

meta.window pode ser null em respostas de mutação e detalhes sem janela
temporal. refreshAfterSeconds pode ser null quando polling não é aplicável.

Estados de freshness:

| Estado | Significado |
|---|---|
| fresh | Fonte dentro do SLA |
| delayed | Dados válidos, mas atrasados |
| partial | Cobertura incompleta |
| unavailable | Nenhum dado válido disponível |

partial igual a true significa que a resposta ainda pode ser utilizada, mas
o frontend deve exibir os avisos associados.

### 4.6 Avisos

~~~json
{
  "code": "INDIVIDUAL_EVENTS_PARTIALLY_UNAVAILABLE",
  "message": "Nem todas as categorias possuem uma fonte de eventos individuais configurada."
}
~~~

O frontend usa code para comportamento e message como fallback. A API pode
adicionar avisos sem transformar a resposta em erro.

### 4.7 Envelope de erro

~~~json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Um ou mais parâmetros são inválidos.",
    "fields": [
      {
        "field": "window",
        "code": "INVALID_VALUE",
        "message": "window deve ser 15m, 30m, 1h, 6h ou 24h."
      }
    ],
    "requestId": "req_01K2F8BAYX"
  }
}
~~~

fields é opcional. details pode ser usado para conflitos sem incluir dados
sensíveis.

| HTTP | Código | Uso |
|---:|---|---|
| 400 | VALIDATION_ERROR | Query, path ou body inválido |
| 401 | UNAUTHENTICATED | Sessão ausente ou inválida |
| 403 | FORBIDDEN | Operação não autorizada |
| 404 | RESOURCE_NOT_FOUND | Recurso inexistente |
| 409 | CONFLICT | Estado incompatível com a operação |
| 409 | REVIEW_VERSION_CONFLICT | Revisão concorrente |
| 409 | DIAGNOSIS_NOT_READY | Diagnóstico ainda não revisável |
| 409 | HYPOTHESIS_SUPERSEDED | Hipótese substituída |
| 422 | VALIDATION_ERROR | Body semanticamente inválido |
| 429 | RATE_LIMITED | Limite de requisições |
| 500 | INTERNAL_ERROR | Falha inesperada |
| 503 | DATA_UNAVAILABLE | Nenhuma versão válida do dado |

Uma fonte parcial não causa 503 quando existe uma versão utilizável.

### 4.8 Paginação

- Incidentes e eventos usam cursor opaco.
- O cursor é vinculado aos filtros e à ordenação usados para produzi-lo.
- Um cursor reutilizado com filtros diferentes gera VALIDATION_ERROR.
- A resposta não exige total exato.

~~~json
{
  "page": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJwayI6IklOQyM..."
  }
}
~~~

## 5. Visão Geral

### 5.1 Request

~~~http
GET /api/v1/dashboard/overview?window=30m&deviceType=smart-tv&region=nordeste&appVersion=4.2.1&incidentLimit=5
~~~

| Parâmetro | Tipo | Obrigatório | Regra |
|---|---|---:|---|
| window | string | não | 15m, 30m, 1h, 6h ou 24h; padrão 30m |
| search | string | não | Até 100 caracteres |
| deviceType | string | não | Valor presente nas facetas |
| region | string | não | Valor presente nas facetas |
| appVersion | string | não | Valor presente nas facetas |
| incidentLimit | integer | não | 1 a 10; padrão 5 |

### 5.2 Response

~~~json
{
  "data": {
    "kpis": [
      {
        "key": "errors_per_minute",
        "value": 342,
        "unit": "errors_per_minute",
        "status": "critical",
        "comparison": {
          "baselineValue": 74,
          "absoluteChange": 268,
          "changeRatio": 3.6216,
          "direction": "up"
        }
      },
      {
        "key": "latency_p95",
        "value": 310,
        "unit": "milliseconds",
        "status": "warning",
        "comparison": {
          "baselineValue": 180,
          "absoluteChange": 130,
          "changeRatio": 0.7222,
          "direction": "up"
        }
      },
      {
        "key": "affected_sessions",
        "value": 10920,
        "unit": "sessions",
        "status": "critical",
        "shareOfObservedSessions": 0.184
      }
    ],
    "experienceHealth": {
      "metric": "experience_health_score",
      "unit": "score",
      "baselineValue": 92,
      "points": [
        {
          "timestamp": "2026-08-26T17:40:00.000Z",
          "value": 91
        },
        {
          "timestamp": "2026-08-26T17:45:00.000Z",
          "value": 68
        }
      ],
      "anomalyWindows": [
        {
          "from": "2026-08-26T17:42:00.000Z",
          "to": "2026-08-26T17:50:00.000Z",
          "peakTimestamp": "2026-08-26T17:45:00.000Z",
          "peakValue": 68
        }
      ]
    },
    "recentIncidents": [
      {
        "id": "inc_01K2F6YQ9G",
        "number": "INC-4821",
        "title": "Aumento de buffering em Smart TVs",
        "priority": "P1",
        "status": "investigating",
        "startedAt": "2026-08-26T17:41:00.000Z",
        "affectedSessions": 10920,
        "impactStatus": "measured",
        "primaryComponent": {
          "id": "video-player",
          "name": "Player de vídeo"
        }
      }
    ],
    "facets": {
      "deviceTypes": [
        {
          "value": "smart-tv",
          "name": "Smart TV",
          "count": 12
        }
      ],
      "regions": [],
      "appVersions": []
    }
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:11:30.000Z",
    "window": {
      "preset": "30m",
      "from": "2026-08-26T17:41:30.000Z",
      "to": "2026-08-26T18:11:30.000Z"
    },
    "partial": false,
    "refreshAfterSeconds": 30,
    "freshness": [],
    "warnings": []
  }
}
~~~

KPI status: healthy, warning, critical ou unknown.  
direction: up, down ou stable.

## 6. Incidentes

### 6.1 Request

~~~http
GET /api/v1/incidents?window=1h&search=buffering&priority=P1,P2&status=detected,investigating&deviceType=smart-tv&region=nordeste&sort=impact&chartMetric=affected_devices&limit=20
~~~

| Parâmetro | Regra |
|---|---|
| window | 15m, 30m, 1h, 6h ou 24h; padrão 1h |
| from/to | ISO 8601 UTC; usados juntos e incompatíveis com window |
| search | Número, título, componente e termos normalizados; máximo 100 |
| priority | Lista de P1, P2, P3 e P4 |
| status | detected, investigating, confirmed, resolved ou closed |
| deviceType | Valor disponível nas facetas |
| os | Sistema operacional |
| appVersion | Versão do aplicativo |
| region | Região |
| state | UF |
| isp | Provedor |
| cdn | CDN |
| content | Conteúdo ou canal normalizado |
| component | Componente técnico |
| eventType | Categoria de evento |
| sort | priority, impact ou recent; padrão recent |
| chartMetric | affected_devices ou affected_sessions |
| limit | 1 a 100; padrão 20 |
| cursor | Cursor opaco |

### 6.2 Response

~~~json
{
  "data": {
    "items": [
      {
        "id": "inc_01K2F6YQ9G",
        "number": "INC-4821",
        "title": "Aumento de buffering em Smart TVs",
        "priority": "P1",
        "status": "investigating",
        "startedAt": "2026-08-26T17:41:00.000Z",
        "detectedAt": "2026-08-26T17:43:30.000Z",
        "endedAt": null,
        "impact": {
          "status": "measured",
          "affectedDevices": 12480,
          "affectedSessions": 10920,
          "shareOfObservedSessions": 0.184
        },
        "primaryComponent": {
          "id": "video-player",
          "name": "Player de vídeo"
        },
        "scopeSummary": [
          {
            "dimension": "device_type",
            "value": "smart-tv",
            "name": "Smart TV"
          },
          {
            "dimension": "region",
            "value": "nordeste",
            "name": "Nordeste"
          }
        ],
        "diagnosis": {
          "status": "ready",
          "primaryHypothesisId": "hyp_01K2F7CMQ2",
          "confidence": 0.86,
          "reviewStatus": "pending"
        }
      }
    ],
    "impactSeries": {
      "metric": "affected_devices",
      "unit": "devices",
      "bucketSeconds": 300,
      "points": [
        {
          "timestamp": "2026-08-26T17:40:00.000Z",
          "total": 2180,
          "byPriority": {
            "P1": 1200,
            "P2": 700,
            "P3": 230,
            "P4": 50
          }
        }
      ]
    },
    "facets": {
      "priorities": [],
      "statuses": [],
      "deviceTypes": [],
      "operatingSystems": [],
      "appVersions": [],
      "regions": [],
      "states": [],
      "isps": [],
      "cdns": [],
      "contents": [],
      "components": [],
      "eventTypes": []
    },
    "page": {
      "limit": 20,
      "hasMore": true,
      "nextCursor": "eyJwayI6IklOQyM..."
    }
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:11:30.000Z",
    "window": {
      "preset": "1h",
      "from": "2026-08-26T17:11:30.000Z",
      "to": "2026-08-26T18:11:30.000Z"
    },
    "partial": false,
    "refreshAfterSeconds": 30,
    "freshness": [],
    "warnings": []
  }
}
~~~

impact.status: measured, estimated ou unknown. Quando unknown, os valores de
impacto são null.

diagnosis.status: not_started, processing, ready, inconclusive ou failed.

As contagens de uma faceta respeitam todos os filtros ativos, exceto o filtro
da própria dimensão.

## 7. Diagnóstico e evidências

### 7.1 Request

~~~http
GET /api/v1/incidents/{incidentId}/diagnosis
~~~

A janela analítica é determinada pelo incidente e informada em meta.window.

### 7.2 Response

~~~json
{
  "data": {
    "incident": {
      "id": "inc_01K2F6YQ9G",
      "number": "INC-4821",
      "title": "Aumento de buffering em Smart TVs",
      "priority": "P1",
      "status": "investigating",
      "startedAt": "2026-08-26T17:41:00.000Z",
      "detectedAt": "2026-08-26T17:43:30.000Z",
      "endedAt": null,
      "impact": {
        "status": "measured",
        "affectedDevices": 12480,
        "affectedSessions": 10920,
        "shareOfObservedSessions": 0.184
      }
    },
    "diagnosis": {
      "status": "ready",
      "generatedAt": "2026-08-26T17:47:10.000Z",
      "summary": "O aumento está concentrado em Smart TVs com a versão 4.2.1.",
      "primaryHypothesisId": "hyp_01K2F7CMQ2",
      "confidence": 0.86,
      "hypotheses": [
        {
          "id": "hyp_01K2F7CMQ2",
          "rank": 1,
          "statement": "Regressão no player elevou o tempo de carregamento.",
          "component": {
            "id": "video-player",
            "name": "Player de vídeo"
          },
          "probability": 0.86,
          "rationale": "A degradação começou após o deploy e está concentrada na nova versão.",
          "review": {
            "status": "pending",
            "note": null,
            "reviewedAt": null,
            "version": 0
          }
        }
      ]
    },
    "evidence": [
      {
        "id": "evi_01K2F7E0C4",
        "type": "metric_deviation",
        "title": "Buffering acima da linha de base",
        "statement": "A taxa atingiu 8,4%, contra uma linha de base de 2,1%.",
        "relation": "supports",
        "hypothesisIds": [
          "hyp_01K2F7CMQ2"
        ],
        "strength": "strong",
        "observedAt": "2026-08-26T17:44:00.000Z",
        "source": {
          "type": "operational_telemetry",
          "name": "Argus"
        },
        "observation": {
          "metric": "buffering_ratio",
          "value": 0.084,
          "baselineValue": 0.021,
          "unit": "ratio"
        },
        "quality": {
          "status": "verified",
          "coverageRatio": 0.97,
          "flags": []
        }
      }
    ],
    "charts": {
      "buffering": {
        "metric": "buffering_ratio",
        "unit": "ratio",
        "bucketSeconds": 60,
        "points": [
          {
            "timestamp": "2026-08-26T17:44:00.000Z",
            "value": 0.084,
            "baselineValue": 0.021
          }
        ],
        "anomalyWindows": [
          {
            "from": "2026-08-26T17:42:00.000Z",
            "to": "2026-08-26T17:48:00.000Z",
            "peakTimestamp": "2026-08-26T17:44:00.000Z",
            "peakValue": 0.084
          }
        ]
      },
      "concentrations": [
        {
          "dimension": "device_type",
          "name": "Tipo de dispositivo",
          "values": [
            {
              "value": "smart-tv",
              "name": "Smart TV",
              "affectedSessions": 8230,
              "share": 0.754,
              "baselineShare": 0.412
            }
          ]
        }
      ]
    },
    "timeline": [
      {
        "id": "evt_01K2F6SZYH",
        "timestamp": "2026-08-26T17:32:00.000Z",
        "type": "deployment",
        "title": "Deploy da versão 4.2.1",
        "description": "Nova versão liberada para Smart TVs.",
        "source": "Argus",
        "correlation": "possible"
      }
    ],
    "dataQuality": {
      "status": "sufficient",
      "coverageRatio": 0.97,
      "observedThrough": "2026-08-26T18:11:00.000Z",
      "gaps": []
    }
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:11:30.000Z",
    "window": {
      "preset": null,
      "from": "2026-08-26T17:11:00.000Z",
      "to": "2026-08-26T18:11:00.000Z"
    },
    "partial": false,
    "refreshAfterSeconds": 30,
    "freshness": [],
    "warnings": []
  }
}
~~~

Enums:

- review.status: pending, confirmed, refuted, inconclusive.
- evidence.type: metric_deviation, segment_concentration,
  deployment_correlation, error_correlation, geographic_concentration,
  temporal_correlation.
- evidence.relation: supports, contradicts, context.
- evidence.strength: strong, moderate, weak.
- quality.status: verified, partial, delayed, unavailable.
- timeline.type: deployment, configuration_change, telemetry_anomaly,
  incident_detection, external_event.
- timeline.correlation: direct, possible, unrelated, unknown.
- dataQuality.status: sufficient, limited, insufficient.

Um incidente existente ainda sem diagnóstico retorna 200 com status
not_started ou processing. Isso não é RESOURCE_NOT_FOUND.

rationale é uma justificativa curta e auditável. A API não expõe raciocínio
interno de modelos.

## 8. Revisão de hipótese

### 8.1 Request

~~~http
PATCH /api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review
Content-Type: application/json
~~~

~~~json
{
  "status": "confirmed",
  "note": "O início coincide com o deploy e com a concentração na versão 4.2.1.",
  "expectedVersion": 0
}
~~~

Regras:

- status é confirmed, refuted ou inconclusive.
- note é opcional e aceita até 1.000 caracteres.
- expectedVersion é obrigatório.
- reviewedBy, e-mail, nome e ID de usuário não são aceitos no body.
- A identidade do revisor vem exclusivamente da sessão no servidor.

### 8.2 Response

~~~json
{
  "data": {
    "incidentId": "inc_01K2F6YQ9G",
    "hypothesisId": "hyp_01K2F7CMQ2",
    "review": {
      "status": "confirmed",
      "note": "O início coincide com o deploy e com a concentração na versão 4.2.1.",
      "reviewedAt": "2026-08-26T18:20:14.000Z",
      "version": 1
    }
  },
  "meta": {
    "requestId": "req_01K2FAGVP0",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:20:14.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": null,
    "freshness": [],
    "warnings": []
  }
}
~~~

Uma repetição idêntica devolve 200 sem duplicar auditoria. Uma alteração
concorrente com expectedVersion antiga devolve REVIEW_VERSION_CONFLICT.

A promoção ou invalidação no golden set é um efeito interno e não bloqueia a
resposta HTTP.

## 9. Eventos correlacionados

### 9.1 Listagem

~~~http
GET /api/v1/incidents/{incidentId}/events?window=30m&category=error,video_view&deviceType=smart-tv&region=nordeste&appVersion=4.2.1&sort=recent&limit=50
~~~

Filtros:

- window: 15m, 30m, 1h, 6h ou 24h; padrão 30m.
- from/to: consulta histórica.
- search.
- category.
- deviceType, region, appVersion e source.
- os, state, pop, isp, cdn, content, component e environment.
- sort: recent ou oldest.
- limit: 1 a 100; padrão 50.
- cursor.

### 9.2 Response da listagem

~~~json
{
  "data": {
    "incident": {
      "id": "inc_01K2F6YQ9G",
      "number": "INC-4821",
      "title": "Aumento de buffering em Smart TVs"
    },
    "capabilities": {
      "aggregateMetrics": {
        "status": "available"
      },
      "individualEvents": {
        "status": "partial",
        "availableCategories": [
          "error"
        ],
        "unavailableCategories": [
          "request",
          "vitals",
          "screen_view",
          "video_view",
          "session"
        ],
        "reason": "INDIVIDUAL_EVENT_FEED_NOT_CONFIGURED"
      },
      "rawPayload": {
        "status": "partial"
      }
    },
    "categoryStats": [
      {
        "category": "all",
        "count": 10260,
        "ratePerMinute": 342,
        "status": "partial"
      },
      {
        "category": "request",
        "count": null,
        "ratePerMinute": null,
        "status": "unavailable"
      }
    ],
    "volumeSeries": {
      "metric": "events_per_minute",
      "unit": "events_per_minute",
      "bucketSeconds": 300,
      "points": [
        {
          "timestamp": "2026-08-26T17:30:00.000Z",
          "total": 410,
          "byCategory": {
            "request": null,
            "vitals": null,
            "screen_view": null,
            "video_view": null,
            "session": null,
            "error": 410
          }
        }
      ],
      "anomalyWindows": []
    },
    "items": [
      {
        "id": "evt_01K2F70F6J",
        "occurredAt": "2026-08-26T17:44:12.412Z",
        "ingestedAt": "2026-08-26T17:44:30.000Z",
        "category": "error",
        "eventName": "PLAYER_DECODER_FALLBACK",
        "summary": "Falha de fallback do decoder",
        "source": {
          "id": "argus-signal-point",
          "name": "Argus",
          "type": "operational_telemetry"
        },
        "entity": {
          "type": "playback_session",
          "id": "psn_7f4a2c91"
        },
        "dimensions": {
          "deviceType": "smart-tv",
          "operatingSystem": "webos",
          "appVersion": "4.2.1",
          "region": "nordeste",
          "state": "PE",
          "component": "player-decoder",
          "environment": "production"
        },
        "quality": {
          "status": "possible_duplicate",
          "lagSeconds": 18,
          "flags": [
            "AGGREGATED_SOURCE",
            "POSSIBLE_DUPLICATE"
          ]
        },
        "normalized": {
          "schema": "error.v1",
          "severity": "fatal",
          "errorName": "PLAYER_DECODER_FALLBACK",
          "message": "Falha ao selecionar decoder compatível",
          "stackFingerprint": "stk_d57c9e12"
        },
        "rawAvailable": false
      }
    ],
    "facets": {
      "categories": [],
      "deviceTypes": [],
      "operatingSystems": [],
      "appVersions": [],
      "regions": [],
      "states": [],
      "pops": [],
      "isps": [],
      "cdns": [],
      "contents": [],
      "components": [],
      "environments": [],
      "sources": []
    },
    "page": {
      "limit": 50,
      "hasMore": false,
      "nextCursor": null
    }
  },
  "meta": {
    "requestId": "req_01K2FBHQV8",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:22:00.000Z",
    "window": {
      "preset": "30m",
      "from": "2026-08-26T17:52:00.000Z",
      "to": "2026-08-26T18:22:00.000Z"
    },
    "partial": true,
    "refreshAfterSeconds": 30,
    "freshness": [],
    "warnings": [
      {
        "code": "INDIVIDUAL_EVENTS_PARTIALLY_UNAVAILABLE",
        "message": "Nem todas as categorias possuem uma fonte de eventos individuais configurada."
      }
    ]
  }
}
~~~

Categorias: request, vitals, screen_view, video_view, session e error.

Status de categoryStats: measured, estimated, partial ou unavailable.

Status das capabilities: available, partial ou unavailable.

Status de quality: linked, normalized, delayed, possible_duplicate ou
partial.

### 9.3 Detalhe do evento

~~~http
GET /api/v1/incidents/{incidentId}/events/{eventId}
~~~

~~~json
{
  "data": {
    "event": {
      "id": "evt_01K2FBM62H",
      "occurredAt": "2026-08-26T17:44:12.412Z",
      "ingestedAt": "2026-08-26T17:44:30.000Z",
      "category": "request",
      "eventName": "HTTP_REQUEST_COMPLETED",
      "source": {
        "id": "player-events",
        "name": "Player",
        "type": "client_telemetry"
      },
      "quality": {
        "status": "normalized",
        "lagSeconds": 18,
        "flags": []
      },
      "normalized": {
        "schema": "request.v1",
        "method": "GET",
        "route": "/operation/playback",
        "statusCode": 200,
        "durationMs": 310
      },
      "raw": {
        "available": true,
        "contentType": "application/json",
        "payload": {
          "method": "GET",
          "route": "/operation/playback",
          "status": 200,
          "duration_ms": 310
        },
        "redactedFields": [
          "headers.authorization",
          "headers.cookie",
          "user_id",
          "device_id",
          "session_id"
        ],
        "truncated": false
      }
    }
  },
  "meta": {
    "requestId": "req_01K2FBP4YT",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:22:04.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": null,
    "freshness": [],
    "warnings": []
  }
}
~~~

Schemas normalizados:

| Schema | Campos específicos |
|---|---|
| request.v1 | method, route, statusCode, durationMs |
| vitals.v1 | metricName, value, unit |
| screen_view.v1 | screenName, action |
| video_view.v1 | action, contentId, startupTimeMs, positionSeconds |
| session.v1 | action, durationSeconds, terminationReason |
| error.v1 | errorName, message, severity, stackFingerprint |

IDs de usuário, dispositivo e sessão devem ser pseudonimizados.
Authorization, cookies, tokens e identificadores pessoais nunca são
retornados. Payload bruto é sanitizado por allowlist.

## 10. Monitoramento

### 10.1 Request

~~~http
GET /api/v1/monitoring/overview?window=15m&source=argus&worker=argus-ingestion&flowMetric=processing_latency
~~~

| Parâmetro | Regra |
|---|---|
| window | 15m, 30m, 1h ou 6h; padrão 15m |
| source | Uma ou mais fontes disponíveis |
| worker | Um ou mais workers disponíveis |
| flowMetric | ingestion_rate, processing_latency ou queue_depth |

### 10.2 Response

~~~json
{
  "data": {
    "capabilities": {
      "sourceQuality": {
        "status": "available"
      },
      "pipelineRuntime": {
        "status": "available"
      },
      "geographicMetrics": {
        "status": "available",
        "granularity": "state"
      }
    },
    "kpis": {
      "ingestionRate": {
        "value": 2800000,
        "unit": "events_per_minute",
        "status": "healthy",
        "comparison": {
          "previousValue": 2692308,
          "changeRatio": 0.04,
          "direction": "up"
        }
      },
      "processingLatencyP95": {
        "value": 48,
        "unit": "seconds",
        "status": "healthy",
        "target": {
          "operator": "less_than_or_equal",
          "value": 120
        }
      },
      "queueDepth": {
        "value": 18400,
        "unit": "messages",
        "status": "warning",
        "comparison": {
          "previousValue": 15931,
          "changeRatio": 0.155,
          "direction": "up"
        }
      },
      "deadLetterQueue": {
        "value": 23,
        "unit": "messages",
        "status": "critical",
        "newInWindow": 7
      }
    },
    "flow": {
      "metric": "processing_latency",
      "unit": "seconds",
      "bucketSeconds": 120,
      "target": {
        "operator": "less_than_or_equal",
        "value": 120
      },
      "series": [
        {
          "stage": "ingestion",
          "name": "Ingestão",
          "points": [
            {
              "timestamp": "2026-08-26T18:00:00.000Z",
              "value": 12
            }
          ]
        },
        {
          "stage": "processing",
          "name": "Processamento",
          "points": [
            {
              "timestamp": "2026-08-26T18:00:00.000Z",
              "value": 44
            }
          ]
        }
      ],
      "peak": {
        "timestamp": "2026-08-26T18:02:00.000Z",
        "stage": "processing",
        "value": 61
      }
    },
    "sources": [
      {
        "id": "argus",
        "name": "Argus",
        "type": "operational_telemetry",
        "workers": [
          "argus-ingestion"
        ],
        "lastObservedAt": "2026-08-26T18:14:42.000Z",
        "lagSeconds": 18,
        "coverageRatio": 0.97,
        "state": "stable",
        "metrics": {
          "ingestionRate": 2800000,
          "processingLatencyP95": 48,
          "queueDepth": 18400,
          "deadLetterCount": 23
        }
      }
    ],
    "geography": {
      "granularity": "state",
      "metrics": [
        {
          "key": "instability_ratio",
          "unit": "ratio"
        },
        {
          "key": "latency_p95",
          "unit": "seconds"
        },
        {
          "key": "event_loss_ratio",
          "unit": "ratio"
        }
      ],
      "areas": [
        {
          "code": "PE",
          "name": "Pernambuco",
          "region": "nordeste",
          "observedSessions": 184200,
          "coverageRatio": 0.96,
          "values": {
            "instabilityRatio": 0.068,
            "latencyP95": 6.4,
            "eventLossRatio": 0.048
          }
        }
      ]
    },
    "facets": {
      "sources": [],
      "workers": [],
      "flowMetrics": [
        {
          "value": "ingestion_rate",
          "name": "Taxa de ingestão"
        },
        {
          "value": "processing_latency",
          "name": "Latência de processamento"
        },
        {
          "value": "queue_depth",
          "name": "Profundidade da fila"
        }
      ]
    }
  },
  "meta": {
    "requestId": "req_01K2FCXRTG",
    "schemaVersion": "1.0",
    "generatedAt": "2026-08-26T18:15:00.000Z",
    "window": {
      "preset": "15m",
      "from": "2026-08-26T18:00:00.000Z",
      "to": "2026-08-26T18:15:00.000Z"
    },
    "partial": false,
    "refreshAfterSeconds": 15,
    "freshness": [],
    "warnings": []
  }
}
~~~

Estados de fonte: stable, delayed, partial, unavailable.  
Estados de KPI: healthy, warning, critical, unknown.

Se métricas da infraestrutura não estiverem configuradas, seus valores são
null, o status é unknown e capabilities.pipelineRuntime informa unavailable.

As áreas geográficas são UFs. A API não retorna SVG, paths ou coordenadas; o
frontend é responsável pela representação do mapa.

## 11. Responsabilidades do frontend

- Formatar números, datas relativas, percentuais e unidades.
- Traduzir enums.
- Respeitar refreshAfterSeconds.
- Exibir avisos quando partial for true.
- Distinguir null de zero.
- Reiniciar paginação quando filtros ou ordenação mudarem.
- Não interpretar cursores e IDs.
- Não selecionar silenciosamente um incidente padrão na tela de Eventos.
- Abrir Eventos com incidentId explícito.
- Exibir estados vazios para capabilities indisponíveis.
- Tratar enums desconhecidos com rótulo neutro.

## 12. Responsabilidades do backend

- Validar path, query e body.
- Resolver a janela temporal efetiva.
- Retornar requestId em sucesso e erro.
- Entregar números e timestamps sem formatação visual.
- Não expor campos físicos de persistência.
- Não transformar indisponibilidade em zero.
- Sanitizar detalhes de eventos.
- Obter a identidade do revisor da sessão.
- Manter cursores opacos e vinculados aos filtros.
- Fornecer facetas baseadas nos dados disponíveis.
- Retornar respostas parciais utilizáveis sempre que houver uma versão válida.

## 13. Evolução compatível

Alterações compatíveis dentro de v1:

- Adicionar campo opcional.
- Adicionar novo warning.
- Adicionar item em facets.
- Adicionar nova fonte.
- Adicionar novo schema de evento documentado.

Alterações incompatíveis exigem nova versão:

- Remover ou renomear campo.
- Tornar obrigatório um campo antes opcional.
- Alterar unidade ou semântica.
- Alterar tipo JSON.
- Alterar significado de null e zero.
- Alterar a estrutura de cursor esperada pelo cliente.

## 14. Critérios de aceite do contrato

- Todos os exemplos são representáveis em OpenAPI 3.1.
- Request e response usam schemas fechados para campos conhecidos.
- Eventos usam união discriminada por category e normalized.schema.
- O frontend consegue renderizar todas as telas operacionais sem mocks.
- Dados ausentes, atrasados e parciais têm representação explícita.
- Nenhum campo exige conhecimento de DynamoDB ou Argus pelo frontend.
- O contrato não depende do backend Flask ou de BigQuery.
- A troca futura de origem preserva os DTOs públicos.
