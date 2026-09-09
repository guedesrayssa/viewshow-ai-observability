# Documentação de Observabilidade

## Documentos

| Documento | Sinal | Destino | Cobre |
|---|---|---|---|
| [Mapeamento de Métricas](./mapeamento-metricas-observabilidade.md) | Métricas | Prometheus (`:9090`) | QoE do Globoplay por tela do painel, padrão RED da API, runtime do Node.js, camada agêntica e Bedrock, cliente DynamoDB, pipeline batch de ingestão e mensageria SQS/DLQ. |
| [Mapeamento de Logs](./mapeamento-logs-observabilidade.md) | Logs | Loki (`:3100`) | Contrato canônico da linha JSON, rótulos versus metadados estruturados, sanitização e PII, catálogo de eventos por rota e serviço, ciclo de run da ingestão e consultas LogQL. |
| [Mapeamento de Traces](./mapeamento-traces-observabilidade.md) | Traces | Tempo (`:4317` gRPC, `:4318` HTTP) | Convenções de span e atributos de recurso, propagação W3C e CORS, amostragem, árvores de span da API e do batch, correlação entre os três sinais e consultas TraceQL. |

Os três compartilham a mesma matriz de requisitos (RNF01 a RNF15) e as mesmas
decisões de arquitetura (ADR-002, ADR-004 e ADR-005), cada um pelo ângulo do seu
sinal.

## Ordem de leitura sugerida

1. **Métricas**, para o vocabulário de indicadores e a matriz de requisitos.
2. **Logs**, para o contrato da linha e a regra de correlação por `trace_id`.
3. **Traces**, que amarra os dois anteriores e depende de convenções definidos
   neles (`service_name` e o nome reservado `trace_id`).

## Ordem de implementação sugerida

Diferente da ordem de leitura. O rastreamento vem primeiro porque o
`metrics_generator` do Tempo já está configurado com os processadores
`span-metrics` e `service-graphs`: o primeiro span que chegar produz parte das
métricas RED e o mapa de serviços sem nenhum código adicional.

1. **Traces**, Passos 1 a 4 do roteiro do documento de traces.
2. **Logs**, com o `trace_id` do OpenTelemetry já disponível para injeção.
3. **Métricas**, com o `prom-client` cobrindo o que o span não alcança
   (event loop, heap, GC e razão de itens varridos por devolvidos no DynamoDB).

## Três achados que atravessam os documentos

Registrados aqui porque afetam decisões de implementação em mais de um sinal:

- **O nome `trace_id` está sobrecarregado.** A tabela `monitoracao-operacional`
  tem um GSI `trace-index` sobre um atributo chamado `trace_id` cujo valor é o
  `incidentId`, não um trace ID W3C. Os campos derivados do Loki provisionados
  em `datasources.yml` transformam qualquer `trace_id` em link para o Tempo, o
  que produziria links quebrados. Em log e em span o nome é reservado ao
  OpenTelemetry, e o agrupador de domínio se chama `incidentId`.
- **A pilha não tem coletor de logs.** O `apps/fullstack/docker-compose.observability.yml` sobe
  Grafana, Prometheus, Loki e Tempo, mas nenhum Promtail, Alloy ou driver de log
  do Docker. Hoje nada leva uma linha até a porta 3100.
- **O painel é exportação estática.** `output: "export"` em `next.config.ts`
  significa que não há servidor Next em produção. Log e trace do frontend nascem
  no navegador e precisam de um endpoint de recepção na API, porque nem o Loki
  (`auth_enabled: false`) nem o Tempo podem ser expostos ao navegador fora do
  ambiente local.

## Relação com o restante do repositório

| Caminho | Papel |
|---|---|
| [`apps/fullstack/observability/README.md`](../README.md) | Como subir a pilha, portas, data sources provisionados e limites do ambiente local. |
| [`apps/fullstack/docker-compose.observability.yml`](../../docker-compose.observability.yml) | Definição dos quatro serviços da pilha. |
| [`apps/fullstack/observability/prometheus/prometheus.yml`](../prometheus/prometheus.yml) | Alvos de coleta; a API já expõe `GET /metrics`, e o bloco `view-show-api` fica comentado porque a composição não inicia a API. |
| [`apps/fullstack/observability/loki/loki-config.yml`](../loki/loki-config.yml) | Retenção de 168h e `allow_structured_metadata`. |
| [`apps/fullstack/observability/tempo/tempo.yml`](../tempo/tempo.yml) | Receptores OTLP e `metrics_generator`. |
| [`apps/fullstack/observability/grafana/provisioning/datasources/datasources.yml`](../grafana/provisioning/datasources/datasources.yml) | As quatro correlações entre os sinais. |
| [`artefatos/arquitetura/ingestao-e-dados.md`](../../../../artefatos/arquitetura/ingestao-e-dados.md) | Fluxo de ingestão, estados de run, datasets, envelope canônico, persistência e sanitização de erros. |
| [`artefatos/arquitetura/api-dashboard.md`](../../../../artefatos/arquitetura/api-dashboard.md) | Catálogo de endpoints, envelopes públicos e `requestId`. |
