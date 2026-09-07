# API do dashboard

- **Status:** em revisão
- **Versão:** 1.1
- **Última atualização:** 06/09/2026
- **Responsáveis:** equipes de backend e frontend
- **Base HTTP operacional:** `/api/v1`
- **Formato:** JSON
- **Idioma dos identificadores técnicos:** inglês
- **Idioma de apresentação:** responsabilidade do frontend

## 1. Objetivo

Este documento define o contrato HTTP entre o backend Node/Express e o frontend Next.js do dashboard operacional. Ele descreve somente a interface pública: autenticação, endpoints, parâmetros, respostas, enums, erros, paginação, parcialidade, frescor e regras de privacidade.

O contrato é independente da origem física dos dados. Na primeira versão, os dados operacionais vêm do Argus, são normalizados e materializados antes de serem consultados pelo backend. Uma troca futura da origem não deve exigir alterações nos componentes do frontend.

## 2. Escopo

Incluído:

- Visão Geral.
- Listagem e filtros de incidentes.
- Diagnóstico e evidências.
- Revisão humana de hipótese.
- Eventos correlacionados.
- Monitoramento operacional.
- Autenticação federada e sessão.
- Importação assíncrona de dump.
- Solicitação de reanálise.
- Estados de carregamento parcial, atraso e indisponibilidade.

Fora do escopo desta versão:

- Recuperação de senha, administrada pelo provedor corporativo.
- Administração de perfis e grupos de usuários.
- Configurações do dashboard.
- Endpoints internos de ML, orquestração e golden set.
- O backend Flask inicial e sua tabela telemetry.
- BigQuery.

A identidade do revisor é obtida exclusivamente da sessão autenticada no servidor. Qualquer pessoa autenticada pode iniciar uma importação; a revisão de hipótese também exige sessão válida e registra a identidade corporativa.

### 2.1 Perfil de disponibilidade

As fases abaixo descrevem disponibilidade de dados, não versões diferentes da API. O formato público permanece estável; capabilities, partial, freshness e warnings informam o que pode ser preenchido em cada momento.

| Capacidade | Fase Argus inicial | Fase com ingestão/instrumentação completa |
|---|---|---|
| Visão Geral, incidentes e diagnóstico | Prevista | Prevista |
| Eventos agregados e técnicos | Disponíveis quando representados no Argus | Disponíveis |
| Seis categorias de eventos individuais | unavailable | Disponíveis quando houver fonte individual |
| Payload individual sanitizado | unavailable | Disponível quando houver fonte individual |
| Qualidade, cobertura, QoE e geografia | Disponíveis ou parciais conforme o agregado | Disponíveis |
| Taxa e latência interna do pipeline batch | Parciais, quando registradas pela execução | Disponíveis |
| Fila e DLQ | `unavailable` até o provisionamento | Disponíveis com o Worker de Análise |

Na fase inicial, ausência de uma capability não impede a adoção dos endpoints de Visão Geral, Incidentes e Diagnóstico. A API não fabrica eventos ou métricas para completar uma tela.

## 3. Catálogo de endpoints

| Método | Caminho | Responsabilidade | Disponibilidade inicial |
|---|---|---|---|
| GET | /auth/session | Consultar a sessão corporativa | Com Cognito e SSO configurados |
| GET | /auth/login | Iniciar autenticação federada | Com Cognito e SSO configurados |
| GET | /auth/callback | Validar retorno do provedor e criar sessão | Com Cognito e SSO configurados |
| POST | /auth/logout | Encerrar a sessão | Com Cognito configurado |
| POST | /api/v1/imports | Iniciar upload multipart de um dump | Fase de importação |
| POST | /api/v1/imports/{importId}/complete | Concluir o upload e iniciar processamento | Fase de importação |
| GET | /api/v1/imports/{importId} | Consultar progresso e resultado da importação | Fase de importação |
| GET | /api/v1/dashboard/overview | Visão Geral completa | Fase Argus |
| GET | /api/v1/incidents | Lista, gráfico, filtros e facetas de incidentes | Fase Argus |
| GET | /api/v1/incidents/{incidentId}/diagnosis | Incidente, diagnóstico, evidências, séries e timeline | Fase Argus |
| PATCH | /api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review | Revisão humana de uma hipótese | Condicionada à autenticação |
| GET | /api/v1/incidents/{incidentId}/events | Agregados e eventos correlacionados | Parcial na fase Argus |
| GET | /api/v1/incidents/{incidentId}/events/{eventId} | Evento normalizado e origem sanitizada | Condicionada à existência do evento individual |
| GET | /api/v1/monitoring/overview | Saúde das fontes e do pipeline | Parcial até instrumentação do runtime |
| POST | /api/v1/incidents/{incidentId}/reanalyze | Solicitar uma nova análise | Com SQS de análise configurada |

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
- changeRatio é uma variação decimal com sinal e pode ultrapassar 1 em aumentos superiores a 100%.
- Quantidades medidas sem ocorrências usam 0.
- Quantidades não medidas ou indisponíveis usam null.
- O frontend é responsável por localização, casas decimais e abreviações.

Toda métrica quantitativa ou valor de impacto exposto pela API possui measurement:

~~~json
{
  "status": "measured",
  "source": "argus",
  "coverageRatio": 0.97,
  "observedThrough": "2026-08-26T18:00:00.000Z",
  "scope": {
    "kind": "filtered",
    "dimensions": {
      "deviceType": "smart-tv"
    },
    "observedCount": 59200
  }
}
~~~

- measurement.status é measured, estimated ou unknown.
- source identifica a origem lógica da medição, sem expor tabela física.
- coverageRatio e observedThrough podem ser null quando desconhecidos.
- scope é opcional e explicita população, recorte e quantidade observada.
- scope.kind é global, filtered ou segment.
- Quando measurement está no objeto de uma série ou grupo, ela se aplica aos valores quantitativos filhos, salvo quando um filho possui measurement próprio.
- Quando measurement.status for unknown, o campo da grandeza é obrigatoriamente null: value ou, em objetos agregados, campos equivalentes como count e ratePerMinute. Isso não impede informar cobertura conhecida.
- Zero significa que a grandeza foi medida e nenhuma ocorrência foi observada.
- Percentis só podem ser calculados sobre a população indicada em scope.
- Um percentil global nunca é produzido pela média de percentis segmentados. Sem distribuição ou agregado global confiável, value é null e status é unknown.

### 4.3 Identificadores

- IDs são opacos e estáveis.
- id é o identificador canônico obrigatório do incidente.
- number é a referência humana externa, como INC-4821, e pode ser null quando o incidente ainda não possuir ticket no ServiceNow.
- Quando existir, number vem da origem de incidentes; o backend não gera um contador sequencial próprio.
- O frontend não interpreta a estrutura interna de um ID.
- Quando number for null, o frontend apresenta um rótulo neutro e nunca tenta derivá-lo de id.
- pk, sk, GSI, TTL e outros campos internos nunca aparecem na API pública.

### 4.4 Enums

- Enums usam valores técnicos estáveis em inglês.
- O frontend traduz os rótulos para português.
- A inclusão de um novo valor de enum exige atualização compatível do contrato e tratamento de fallback no frontend.

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
    "refreshAfterSeconds": 900,
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

meta.window pode ser null em respostas de mutação e detalhes sem janela temporal. refreshAfterSeconds pode ser null quando polling não é aplicável.

Estados de freshness:

| Estado | Significado |
|---|---|
| fresh | Fonte dentro do SLA |
| delayed | Dados válidos, mas atrasados |
| partial | Cobertura incompleta |
| unavailable | Nenhum dado válido disponível |

partial igual a true significa que a resposta ainda pode ser utilizada, mas o frontend deve exibir os avisos associados.

### 4.6 Granularidade e atualização

- bucketSeconds descreve a resolução real da série e nunca é inferido pelo frontend.
- Na fase Argus inicial, os agregados principais usam normalmente 900 segundos e as fontes horárias usam 3600 segundos.
- Uma resposta pode conter poucos pontos quando a janela solicitada for menor ou próxima da granularidade disponível.
- O frontend não preenche lacunas nem reamostra séries sem uma regra de apresentação explícita.
- refreshAfterSeconds é inicialmente 900 nas consultas operacionais. Um valor menor só pode ser devolvido quando a fonte efetivamente atualizar nessa frequência.

### 4.7 Avisos

~~~json
{
  "code": "INDIVIDUAL_EVENTS_UNAVAILABLE",
  "message": "Eventos individuais não possuem uma fonte configurada nesta fase."
}
~~~

O frontend usa code para comportamento e message como fallback. A API pode adicionar avisos sem transformar a resposta em erro.

### 4.8 Envelope de erro

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

fields é opcional. details pode ser usado para conflitos sem incluir dados sensíveis.

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
| 422 | UNSUPPORTED_FILTER_COMBINATION | A origem não sustenta a combinação de filtros |
| 429 | RATE_LIMITED | Limite de requisições |
| 500 | INTERNAL_ERROR | Falha inesperada |
| 503 | DATA_UNAVAILABLE | Nenhuma versão válida do dado |

Uma fonte parcial não causa 503 quando existe uma versão utilizável.

### 4.9 Capacidades de filtragem

Endpoints com filtros dimensionais retornam capabilities.filtering:

~~~json
{
  "filtering": {
    "status": "partial",
    "supportedDimensions": [
      "deviceType",
      "region",
      "appVersion"
    ],
    "supportedFilterSets": [
      [],
      ["deviceType"],
      ["region"],
      ["appVersion"]
    ]
  }
}
~~~

Cada item de supportedFilterSets é um conjunto completo aceito; a ordem das dimensões não é significativa. O conjunto vazio representa a consulta sem filtro dimensional. supportedDimensions não implica que qualquer combinação entre seus valores seja válida. Filtros intrínsecos ao recurso, como status e priority de incidentes, não entram nessa lista; a capability governa as dimensões provenientes dos agregados operacionais.

Uma combinação não listada retorna HTTP 422:

~~~json
{
  "error": {
    "code": "UNSUPPORTED_FILTER_COMBINATION",
    "message": "A origem atual não permite combinar estes filtros.",
    "requestId": "req_01K2F8BAYX"
  }
}
~~~

Facetas e contagens são retornadas somente para dimensões e combinações suportadas pela origem atual. Combinações indisponíveis são declaradas em capabilities.filtering e nunca são simuladas por joins entre agregados incompatíveis. Quando um item de faceta possuir count, ele também possui measurement.

### 4.10 Paginação

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
GET /api/v1/dashboard/overview?window=30m&incidentLimit=5
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
    "capabilities": {
      "filtering": {
        "status": "partial",
        "supportedDimensions": [
          "deviceType",
          "region",
          "appVersion"
        ],
        "supportedFilterSets": [
          [],
          ["deviceType"],
          ["region"],
          ["appVersion"]
        ]
      }
    },
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
        },
        "measurement": {
          "status": "measured",
          "source": "argus",
          "coverageRatio": 0.97,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      },
      {
        "key": "latency_p95",
        "value": null,
        "unit": "milliseconds",
        "status": "unknown",
        "comparison": null,
        "measurement": {
          "status": "unknown",
          "source": "argus",
          "coverageRatio": 0.97,
          "observedThrough": "2026-08-26T18:00:00.000Z",
          "scope": {
            "kind": "global",
            "dimensions": {},
            "observedCount": null
          }
        }
      },
      {
        "key": "affected_sessions",
        "value": 10920,
        "unit": "sessions",
        "status": "critical",
        "shareOfObservedSessions": 0.184,
        "measurement": {
          "status": "measured",
          "source": "argus",
          "coverageRatio": 0.97,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      }
    ],
    "experienceHealth": {
      "metric": "errors_per_minute",
      "unit": "errors_per_minute",
      "bucketSeconds": 900,
      "baselineValue": 74,
      "measurement": {
        "status": "measured",
        "source": "argus",
        "coverageRatio": 0.97,
        "observedThrough": "2026-08-26T18:00:00.000Z"
      },
      "points": [
        {
          "timestamp": "2026-08-26T17:45:00.000Z",
          "value": 310
        },
        {
          "timestamp": "2026-08-26T18:00:00.000Z",
          "value": 342
        }
      ],
      "anomalyWindows": [
        {
          "from": "2026-08-26T17:45:00.000Z",
          "to": "2026-08-26T18:00:00.000Z",
          "peakTimestamp": "2026-08-26T18:00:00.000Z",
          "peakValue": 342
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
        "affectedSessions": {
          "value": 10920,
          "unit": "sessions",
          "measurement": {
            "status": "measured",
            "source": "argus",
            "coverageRatio": 0.97,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
        },
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
          "count": 12,
          "measurement": {
            "status": "measured",
            "source": "argus",
            "coverageRatio": 0.97,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
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
    "refreshAfterSeconds": 900,
    "freshness": [],
    "warnings": []
  }
}
~~~

KPI status: healthy, warning, critical ou unknown. direction: up, down ou stable.

experienceHealth é o nome estável da área visual, não um score composto. Na fase inicial, ela usa errors_per_minute medido pelo Argus. Um futuro experience_health_score só pode ser adicionado após aprovação e documentação de fórmula, entradas, pesos e tratamento de dados ausentes.

## 6. Incidentes

### 6.1 Request

~~~http
GET /api/v1/incidents?window=1h&deviceType=smart-tv&sort=impact&chartMetric=affected_devices&limit=20
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
    "capabilities": {
      "filtering": {
        "status": "partial",
        "supportedDimensions": [
          "deviceType",
          "region",
          "appVersion"
        ],
        "supportedFilterSets": [
          [],
          ["deviceType"],
          ["region"],
          ["appVersion"]
        ]
      }
    },
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
          "affectedDevices": {
            "value": 12480,
            "unit": "devices",
            "measurement": {
              "status": "estimated",
              "source": "argus",
              "coverageRatio": 0.91,
              "observedThrough": "2026-08-26T18:00:00.000Z"
            }
          },
          "affectedSessions": {
            "value": 10920,
            "unit": "sessions",
            "measurement": {
              "status": "measured",
              "source": "argus",
              "coverageRatio": 0.97,
              "observedThrough": "2026-08-26T18:00:00.000Z"
            }
          },
          "shareOfObservedSessions": {
            "value": 0.184,
            "unit": "ratio",
            "measurement": {
              "status": "measured",
              "source": "argus",
              "coverageRatio": 0.97,
              "observedThrough": "2026-08-26T18:00:00.000Z"
            }
          }
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
      "bucketSeconds": 900,
      "measurement": {
        "status": "estimated",
        "source": "argus",
        "coverageRatio": 0.91,
        "observedThrough": "2026-08-26T18:00:00.000Z"
      },
      "points": [
        {
          "timestamp": "2026-08-26T17:45:00.000Z",
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
      "appVersions": [],
      "regions": []
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
    "refreshAfterSeconds": 900,
    "freshness": [],
    "warnings": []
  }
}
~~~

Cada valor dentro de impact possui measurement próprio. Quando sua qualidade for unknown, somente o value correspondente é null; os demais impactos podem continuar medidos ou estimados.

diagnosis.status: not_started, processing, ready, inconclusive ou failed.

As contagens de uma faceta respeitam os filtros ativos somente quando esse conjunto estiver declarado em capabilities.filtering.supportedFilterSets. A API não cruza agregados incompatíveis para preencher facetas.

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
        "affectedDevices": {
          "value": 12480,
          "unit": "devices",
          "measurement": {
            "status": "estimated",
            "source": "argus",
            "coverageRatio": 0.91,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
        },
        "affectedSessions": {
          "value": 10920,
          "unit": "sessions",
          "measurement": {
            "status": "measured",
            "source": "argus",
            "coverageRatio": 0.97,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
        },
        "shareOfObservedSessions": {
          "value": 0.184,
          "unit": "ratio",
          "measurement": {
            "status": "measured",
            "source": "argus",
            "coverageRatio": 0.97,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
        }
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
          "unit": "ratio",
          "measurement": {
            "status": "measured",
            "source": "argus",
            "coverageRatio": 0.97,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
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
        "bucketSeconds": 900,
        "measurement": {
          "status": "measured",
          "source": "argus",
          "coverageRatio": 0.97,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        },
        "points": [
          {
            "timestamp": "2026-08-26T17:45:00.000Z",
            "value": 0.084,
            "baselineValue": 0.021
          }
        ],
        "anomalyWindows": [
          {
            "from": "2026-08-26T17:45:00.000Z",
            "to": "2026-08-26T18:00:00.000Z",
            "peakTimestamp": "2026-08-26T17:45:00.000Z",
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
              "affectedSessions": {
                "value": 8230,
                "unit": "sessions",
                "measurement": {
                  "status": "measured",
                  "source": "argus",
                  "coverageRatio": 0.97,
                  "observedThrough": "2026-08-26T18:00:00.000Z"
                }
              },
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
    "refreshAfterSeconds": 900,
    "freshness": [],
    "warnings": []
  }
}
~~~

Enums:

- review.status: pending, confirmed, refuted, inconclusive.
- evidence.type: metric_deviation, segment_concentration, deployment_correlation, error_correlation, geographic_concentration, temporal_correlation.
- evidence.relation: supports, contradicts, context.
- evidence.strength: strong, moderate, weak.
- quality.status: verified, partial, delayed, unavailable.
- timeline.type: deployment, configuration_change, telemetry_anomaly, incident_detection, external_event.
- timeline.correlation: direct, possible, unrelated, unknown.
- dataQuality.status: sufficient, limited, insufficient.

Um incidente existente ainda sem diagnóstico retorna 200 com status not_started ou processing. Isso não é RESOURCE_NOT_FOUND.

rationale é uma justificativa curta e auditável. A API não expõe raciocínio interno de modelos.

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

Uma repetição idêntica devolve 200 sem duplicar auditoria. Uma alteração concorrente com expectedVersion antiga devolve REVIEW_VERSION_CONFLICT.

A promoção ou invalidação no golden set é um efeito interno e não bloqueia a resposta HTTP.

## 9. Eventos correlacionados

### 9.1 Listagem

~~~http
GET /api/v1/incidents/{incidentId}/events?window=30m&deviceType=smart-tv&sort=recent&limit=50
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
      "filtering": {
        "status": "partial",
        "supportedDimensions": [
          "category",
          "deviceType",
          "region",
          "appVersion"
        ],
        "supportedFilterSets": [
          [],
          ["category"],
          ["deviceType"],
          ["region"],
          ["appVersion"]
        ]
      },
      "individualEvents": {
        "status": "unavailable",
        "availableCategories": [],
        "unavailableCategories": [
          "request",
          "vitals",
          "screen_view",
          "video_view",
          "session",
          "error"
        ],
        "reason": "INDIVIDUAL_EVENT_FEED_NOT_CONFIGURED"
      },
      "rawPayload": {
        "status": "unavailable",
        "reason": "INDIVIDUAL_EVENT_FEED_NOT_CONFIGURED"
      }
    },
    "categoryStats": [
      {
        "category": "error",
        "count": 10260,
        "ratePerMinute": 342,
        "status": "measured",
        "measurement": {
          "status": "measured",
          "source": "argus",
          "coverageRatio": 0.97,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      },
      {
        "category": "request",
        "count": null,
        "ratePerMinute": null,
        "status": "unavailable",
        "measurement": {
          "status": "unknown",
          "source": "argus",
          "coverageRatio": null,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      }
    ],
    "volumeSeries": {
      "metric": "errors_per_minute",
      "unit": "errors_per_minute",
      "bucketSeconds": 900,
      "measurement": {
        "status": "measured",
        "source": "argus",
        "coverageRatio": 0.97,
        "observedThrough": "2026-08-26T18:00:00.000Z"
      },
      "points": [
        {
          "timestamp": "2026-08-26T17:45:00.000Z",
          "value": 310
        },
        {
          "timestamp": "2026-08-26T18:00:00.000Z",
          "value": 374
        }
      ],
      "anomalyWindows": []
    },
    "items": [],
    "facets": {
      "categories": [],
      "deviceTypes": [],
      "appVersions": [],
      "regions": []
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
    "refreshAfterSeconds": 900,
    "freshness": [],
    "warnings": [
      {
        "code": "INDIVIDUAL_EVENTS_UNAVAILABLE",
        "message": "Eventos individuais não possuem uma fonte configurada nesta fase."
      }
    ]
  }
}
~~~

Categorias: request, vitals, screen_view, video_view, session e error.

Status de categoryStats: measured, estimated, partial ou unavailable.

Status das capabilities: available, partial ou unavailable.

Na fase Argus inicial, categoryStats e volumeSeries são preenchidos somente com agregados reais. signal_point e signal_bucket são observações de métricas, não eventos individuais; por isso items permanece vazio e a API não cria IDs de evento, sessão ou playback. Apenas eventos efetivamente listados por uma futura fonte individual podem ser consultados no endpoint de detalhe.

Status de quality: linked, normalized, delayed, possible_duplicate ou partial.

### 9.3 Detalhe do evento

Disponibilidade inicial: future. Enquanto individualEvents estiver unavailable, nenhum eventId é emitido pela listagem e este endpoint não é chamado pelo frontend.

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

IDs de usuário, dispositivo e sessão devem ser pseudonimizados. Authorization, cookies, tokens e identificadores pessoais nunca são retornados. Payload bruto é sanitizado por allowlist.

## 10. Monitoramento

### 10.1 Request

~~~http
GET /api/v1/monitoring/overview?window=15m&source=argus&worker=argus-ingestion
~~~

| Parâmetro | Regra |
|---|---|
| window | 15m, 30m, 1h ou 6h; padrão 15m |
| source | Uma ou mais fontes disponíveis |
| worker | Um ou mais workers disponíveis |
| flowMetric | `ingestion_rate`, `processing_latency` ou `queue_depth`; o último só é aceito quando a capability estiver disponível |

### 10.2 Response

~~~json
{
  "data": {
    "capabilities": {
      "sourceQuality": {
        "status": "available"
      },
      "pipelineRuntime": {
        "status": "partial",
        "metrics": {
          "ingestionRate": "available",
          "processingLatencyP95": "available",
          "queueDepth": "unavailable",
          "deadLetterQueue": "unavailable"
        },
        "reason": "ANALYSIS_QUEUE_UNAVAILABLE"
      },
      "geographicMetrics": {
        "status": "partial",
        "granularity": "state"
      },
      "filtering": {
        "status": "partial",
        "supportedDimensions": [
          "source",
          "worker",
          "flowMetric"
        ],
        "supportedFilterSets": [
          [],
          ["source"],
          ["worker"],
          ["flowMetric"],
          ["source", "worker"]
        ]
      }
    },
    "kpis": {
      "ingestionRate": {
        "value": 1860,
        "unit": "records_per_minute",
        "status": "healthy",
        "comparison": {
          "previousValue": 1788,
          "changeRatio": 0.04,
          "direction": "up"
        },
        "measurement": {
          "status": "measured",
          "source": "argus-ingestion",
          "coverageRatio": 1,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      },
      "processingLatencyP95": {
        "value": 48,
        "unit": "seconds",
        "status": "healthy",
        "target": {
          "operator": "less_than_or_equal",
          "value": 120
        },
        "measurement": {
          "status": "measured",
          "source": "argus-ingestion",
          "coverageRatio": 1,
          "observedThrough": "2026-08-26T18:00:00.000Z",
          "scope": {
            "kind": "filtered",
            "dimensions": {
              "recordState": "written"
            },
            "observedCount": 27872
          }
        }
      },
      "queueDepth": {
        "value": null,
        "unit": "messages",
        "status": "unknown",
        "comparison": null,
        "measurement": {
          "status": "unknown",
          "source": "argus-ingestion",
          "coverageRatio": null,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      },
      "deadLetterQueue": {
        "value": null,
        "unit": "messages",
        "status": "unknown",
        "newInWindow": null,
        "measurement": {
          "status": "unknown",
          "source": "argus-ingestion",
          "coverageRatio": null,
          "observedThrough": "2026-08-26T18:00:00.000Z"
        }
      }
    },
    "flow": {
      "metric": "processing_latency",
      "unit": "seconds",
      "bucketSeconds": 900,
      "measurement": {
        "status": "measured",
        "source": "argus-ingestion",
        "coverageRatio": 1,
        "observedThrough": "2026-08-26T18:00:00.000Z"
      },
      "target": {
        "operator": "less_than_or_equal",
        "value": 120
      },
      "series": [
        {
          "stage": "read",
          "name": "Leitura",
          "points": [
            {
              "timestamp": "2026-08-26T18:00:00.000Z",
              "value": 12
            }
          ]
        },
        {
          "stage": "normalize",
          "name": "Normalização",
          "points": [
            {
              "timestamp": "2026-08-26T18:00:00.000Z",
              "value": 26
            }
          ]
        },
        {
          "stage": "write",
          "name": "Escrita",
          "points": [
            {
              "timestamp": "2026-08-26T18:00:00.000Z",
              "value": 10
            }
          ]
        }
      ],
      "peak": {
        "timestamp": "2026-08-26T18:00:00.000Z",
        "stage": "normalize",
        "value": 26
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
        "lastRunAt": "2026-08-26T18:00:48.000Z",
        "lastSuccessfulRunAt": "2026-08-26T18:00:48.000Z",
        "observedThrough": "2026-08-26T18:00:00.000Z",
        "lagSeconds": 900,
        "state": "stable",
        "records": {
          "read": 27900,
          "written": 27872,
          "rejected": 28,
          "measurement": {
            "status": "measured",
            "source": "argus-ingestion",
            "coverageRatio": 1,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
        },
        "coverage": {
          "value": 0.97,
          "unit": "ratio",
          "measurement": {
            "status": "measured",
            "source": "argus-ingestion",
            "coverageRatio": 1,
            "observedThrough": "2026-08-26T18:00:00.000Z"
          }
        }
      }
    ],
    "geography": {
      "granularity": "state",
      "metrics": [
        {
          "key": "instability_ratio",
          "unit": "ratio",
          "status": "available"
        },
        {
          "key": "latency_p95",
          "unit": "seconds",
          "status": "unavailable"
        },
        {
          "key": "event_loss_ratio",
          "unit": "ratio",
          "status": "unavailable"
        }
      ],
      "areas": [
        {
          "code": "PE",
          "name": "Pernambuco",
          "region": "nordeste",
          "observedSessions": {
            "value": 184200,
            "unit": "sessions",
            "measurement": {
              "status": "measured",
              "source": "argus",
              "coverageRatio": 0.96,
              "observedThrough": "2026-08-26T18:00:00.000Z",
              "scope": {
                "kind": "segment",
                "dimensions": {
                  "state": "PE"
                },
                "observedCount": 184200
              }
            }
          },
          "coverageRatio": {
            "value": 0.96,
            "unit": "ratio",
            "measurement": {
              "status": "measured",
              "source": "argus",
              "coverageRatio": 1,
              "observedThrough": "2026-08-26T18:00:00.000Z"
            }
          },
          "values": {
            "instabilityRatio": {
              "value": 0.068,
              "unit": "ratio",
              "measurement": {
                "status": "measured",
                "source": "argus",
                "coverageRatio": 0.96,
                "observedThrough": "2026-08-26T18:00:00.000Z"
              }
            },
            "latencyP95": {
              "value": null,
              "unit": "seconds",
              "measurement": {
                "status": "unknown",
                "source": "argus",
                "coverageRatio": null,
                "observedThrough": "2026-08-26T18:00:00.000Z",
                "scope": {
                  "kind": "segment",
                  "dimensions": {
                    "state": "PE"
                  },
                  "observedCount": null
                }
              }
            },
            "eventLossRatio": {
              "value": null,
              "unit": "ratio",
              "measurement": {
                "status": "unknown",
                "source": "argus",
                "coverageRatio": null,
                "observedThrough": "2026-08-26T18:00:00.000Z"
              }
            }
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
    "partial": true,
    "refreshAfterSeconds": 900,
    "freshness": [],
    "warnings": [
      {
        "code": "ANALYSIS_QUEUE_UNAVAILABLE",
        "message": "As métricas da fila de análise ainda não estão disponíveis."
      }
    ]
  }
}
~~~

Estados de fonte: stable, delayed, partial, unavailable. Estados de KPI: healthy, warning, critical, unknown.

A ingestão lê o ARGUS, normaliza os registros e escreve diretamente no DynamoDB. A SQS e a DLQ pertencem somente ao processamento de análise. Antes de seu provisionamento, os cartões `queueDepth` e `deadLetterQueue` permanecem no DTO com `value: null` e `status: unknown`, enquanto `capabilities.pipelineRuntime` informa `ANALYSIS_QUEUE_UNAVAILABLE`. Depois do provisionamento, os valores vêm das métricas reais da fila e nunca são simulados pelo Backend.

As áreas geográficas são UFs. A API não retorna SVG, paths ou coordenadas; o frontend é responsável pela representação do mapa.

sourceQuality e geographicMetrics podem permanecer available ou partial a partir de cobertura, QoE e geografia do Argus, independentemente da disponibilidade das métricas do runtime.

## 11. Autenticação federada e sessão

As rotas de autenticação ficam fora de `/api/v1` porque controlam a sessão do navegador e realizam redirecionamentos. O Backend segue o padrão *Backend for Frontend*: valida `state`, `nonce`, PKCE, assinatura, emissor, audiência e expiração antes de criar a sessão.

### 11.1 Consultar sessão

~~~http
GET /auth/session
~~~

Quando existe uma sessão válida:

~~~json
{
  "data": {
    "authenticated": true,
    "user": {
      "id": "usr_01K2F8BAYX",
      "name": "Pessoa autenticada",
      "email": "pessoa@corp.globo.com"
    }
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-09-06T15:00:00.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": null,
    "freshness": [],
    "warnings": []
  }
}
~~~

Sessão ausente ou expirada retorna HTTP 401 com `UNAUTHENTICATED`. Tokens do provedor nunca são devolvidos ao JavaScript.

### 11.2 Iniciar e concluir login

~~~http
GET /auth/login
GET /auth/callback?code=<authorization-code>&state=<state>
~~~

`/auth/login` gera `state`, `nonce` e o par PKCE e responde com redirecionamento para o Cognito. O callback troca o código por tokens, executa todas as validações e grava um cookie `HttpOnly`, `Secure` e `SameSite`. Após o sucesso, o usuário é redirecionado para o dashboard; uma falha retorna acesso negado sem registrar códigos, tokens ou credenciais nos logs.

### 11.3 Logout

~~~http
POST /auth/logout
~~~

O Backend invalida a sessão local, remove o cookie e direciona o navegador para o encerramento de sessão do Cognito. A operação é idempotente.

## 12. Importação assíncrona de dump

Qualquer pessoa autenticada pode iniciar uma importação. O arquivo não atravessa o Backend: ele é enviado diretamente ao S3 por upload multipart com URLs pré-assinadas. O Backend controla somente metadados, autorização e estado do processamento.

### 12.1 Iniciar upload

~~~http
POST /api/v1/imports
Content-Type: application/json

{
  "fileName": "argus-2026-09-06.sql.gz",
  "sizeBytes": 11811160064,
  "sha256": "2b5f...9a10",
  "partCount": 112
}
~~~

Resposta HTTP 201:

~~~json
{
  "data": {
    "importId": "imp_01K2F8BAYX",
    "status": "UPLOADING",
    "upload": {
      "uploadId": "s3-multipart-id",
      "partSizeBytes": 104857600,
      "parts": [
        {
          "partNumber": 1,
          "url": "https://s3.amazonaws.com/..."
        }
      ],
      "expiresAt": "2026-09-06T16:00:00.000Z"
    }
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-09-06T15:00:00.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": null,
    "freshness": [],
    "warnings": []
  }
}
~~~

Quando houver muitas partes, o Backend pode devolver as URLs em páginas. As URLs aceitam somente a parte, o tamanho e o tipo de operação autorizados e têm expiração curta.

### 12.2 Concluir upload

~~~http
POST /api/v1/imports/imp_01K2F8BAYX/complete
Content-Type: application/json

{
  "parts": [
    { "partNumber": 1, "etag": "etag-da-parte" }
  ]
}
~~~

O Backend confirma o upload no S3, verifica tamanho e checksum, altera o `ImportJob` para `PROCESSING` e inicia uma tarefa Fargate. A resposta HTTP 202 informa que o processamento continuará em segundo plano:

~~~json
{
  "data": {
    "importId": "imp_01K2F8BAYX",
    "status": "PROCESSING",
    "stage": "VALIDATING",
    "progressPercent": 0
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-09-06T15:10:00.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": 5,
    "freshness": [],
    "warnings": []
  }
}
~~~

### 12.3 Consultar progresso

~~~http
GET /api/v1/imports/imp_01K2F8BAYX
~~~

~~~json
{
  "data": {
    "importId": "imp_01K2F8BAYX",
    "status": "PROCESSING",
    "stage": "INGESTING",
    "progressPercent": 72,
    "createdAt": "2026-09-06T15:00:00.000Z",
    "completedAt": null,
    "error": null
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-09-06T15:20:00.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": 5,
    "freshness": [],
    "warnings": []
  }
}
~~~

Estados de `status`: `UPLOADING`, `PROCESSING`, `COMPLETED` e `FAILED`. Etapas de processamento: `VALIDATING`, `RESTORING`, `INGESTING` e `PUBLISHING`. O frontend respeita `refreshAfterSeconds` até alcançar um estado terminal. Em caso de falha, `error` contém código público e mensagem segura, sem detalhes da infraestrutura ou do dump.

## 13. Solicitação de reanálise

~~~http
POST /api/v1/incidents/{incidentId}/reanalyze
Idempotency-Key: rea_01K2F8BAYX
~~~

O Backend valida a sessão e a existência do incidente, cria uma solicitação `REANALYSIS_REQUESTED` na SQS e retorna HTTP 202:

~~~json
{
  "data": {
    "incidentId": "inc_01K2F8BAYX",
    "analysisRequestId": "arq_01K2F8BAYX",
    "status": "ACCEPTED"
  },
  "meta": {
    "requestId": "req_01K2F8BAYX",
    "schemaVersion": "1.0",
    "generatedAt": "2026-09-06T15:30:00.000Z",
    "window": null,
    "partial": false,
    "refreshAfterSeconds": null,
    "freshness": [],
    "warnings": []
  }
}
~~~

Repetir a mesma chave com o mesmo conteúdo devolve a resposta original. Reutilizar a chave com conteúdo diferente retorna HTTP 409 com `IDEMPOTENCY_KEY_REUSED`.

## 14. Responsabilidades do frontend

- Redirecionar para o login federado quando a sessão estiver ausente ou expirada.
- Enviar partes do dump diretamente ao S3 e acompanhar o `ImportJob` de acordo com `refreshAfterSeconds`.
- Formatar números, datas relativas, percentuais e unidades.
- Traduzir enums.
- Respeitar refreshAfterSeconds.
- Exibir partial, warnings e freshness ao usuário, inclusive atrasos e cobertura limitada.
- Distinguir null de zero.
- Desabilitar filtros e combinações ausentes em capabilities.filtering.supportedFilterSets.
- Não enviar combinações de filtros não suportadas e explicar brevemente a indisponibilidade quando ela afetar a interação.
- Reiniciar paginação quando filtros ou ordenação mudarem.
- Não interpretar cursores e IDs.
- Não selecionar silenciosamente um incidente padrão na tela de Eventos.
- Abrir Eventos com incidentId explícito.
- Exibir estados vazios para capabilities indisponíveis.
- Tratar enums desconhecidos com rótulo neutro.
- Usar mocks somente em desenvolvimento, Storybook ou demonstração. Em produção, indisponibilidade produz estado vazio, partial, delayed ou unavailable; nunca fallback para dados de exemplo.

## 15. Responsabilidades do backend

- Concluir o fluxo federado, proteger tokens e emitir somente o cookie de sessão para o navegador.
- Criar URLs pré-assinadas, validar a conclusão do upload e iniciar a tarefa de importação sem transportar o dump.
- Publicar reanálises na SQS com idempotência.
- Validar path, query e body.
- Resolver a janela temporal efetiva.
- Retornar requestId em sucesso e erro.
- Entregar números e timestamps sem formatação visual.
- Não expor campos físicos de persistência.
- Não transformar indisponibilidade em zero.
- Sanitizar detalhes de eventos.
- Obter a identidade do revisor da sessão.
- Manter cursores opacos e vinculados aos filtros.
- Fornecer facetas somente para dimensões e combinações declaradas em capabilities.filtering, sem joins entre agregados incompatíveis.
- Incluir measurement em toda métrica e impacto e preservar a distinção entre measured, estimated e unknown.
- Retornar respostas parciais utilizáveis sempre que houver uma versão válida.

## 16. Evolução compatível

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

## 17. Critérios de aceite do contrato

- Todos os exemplos são representáveis em OpenAPI 3.1.
- Request e response usam schemas fechados para campos conhecidos.
- Eventos usam união discriminada por category e normalized.schema.
- O frontend consegue renderizar todas as telas com dados reais disponíveis ou estados explícitos de parcialidade, atraso, vazio e indisponibilidade, sem utilizar mocks em produção.
- Dados ausentes, atrasados e parciais têm representação explícita.
- Nenhum campo exige conhecimento de DynamoDB ou Argus pelo frontend.
- O contrato não depende do backend Flask ou de BigQuery.
- A troca futura de origem preserva os DTOs públicos.

## 18. Documentos relacionados

- [Visão geral da arquitetura](visao-geral.md)
- [Fluxos integrados](fluxos.md)
- [Ingestão e dados](ingestao-e-dados.md)
- [Análise de dados e diagnóstico por IA](analise-e-ia.md)
- [Status de implementação](status-implementacao.md)
