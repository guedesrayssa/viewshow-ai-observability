# Pilha de observabilidade local

Ambiente de desenvolvimento com Grafana, Prometheus, Loki e Tempo, subido por
`apps/fullstack/docker-compose.observability.yml`. Serve para instrumentar
a API do View Show localmente antes de levar métricas, logs e traces para a AWS.

## Subir e derrubar

```bash
# a partir da raiz do repositório
docker compose -f apps/fullstack/docker-compose.observability.yml up -d
docker compose -f apps/fullstack/docker-compose.observability.yml ps
docker compose -f apps/fullstack/docker-compose.observability.yml logs -f grafana

docker compose -f apps/fullstack/docker-compose.observability.yml down      # preserva os volumes
docker compose -f apps/fullstack/docker-compose.observability.yml down -v   # apaga os dados
```

Grafana em <http://localhost:3002>, usuário `admin` e senha `admin` por padrão.
Para trocar, exporte `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD` antes de subir.

## Portas

| Porta | Serviço | Uso |
| --- | --- | --- |
| 3002 | Grafana | Interface web (3000 é a API e 3001 é o frontend) |
| 9090 | Prometheus | Interface web, API de consulta e recepção de remote write |
| 3100 | Loki | Ingestão e consulta de logs |
| 3200 | Tempo | API de consulta de traces, usada pelo Grafana |
| 4317 | Tempo | Recepção de traces via OTLP/gRPC |
| 4318 | Tempo | Recepção de traces via OTLP/HTTP |

Todas as portas podem ser sobrescritas por variáveis de ambiente
(`GRAFANA_PORT`, `PROMETHEUS_PORT`, `LOKI_PORT`, `TEMPO_HTTP_PORT`,
`TEMPO_OTLP_GRPC_PORT`, `TEMPO_OTLP_HTTP_PORT`).

## Arquivos

```
apps/fullstack/observability/
├── grafana/provisioning/datasources/datasources.yml   data sources automáticos
├── loki/loki-config.yml                               Loki monolítico, disco local
├── prometheus/prometheus.yml                          alvos e intervalo de coleta
└── tempo/tempo.yml                                    receptores OTLP e metrics_generator
```

## Data sources provisionados

O Grafana lê `grafana/provisioning/datasources/datasources.yml` a cada subida e
sincroniza os três data sources. Eles ficam marcados como somente leitura: para
alterar qualquer um, edite o YAML e reinicie o container, porque mudanças feitas
pela interface web são sobrescritas na próxima subida.

| Data source | UID | Endereço interno |
| --- | --- | --- |
| Prometheus (padrão) | `prometheus` | `http://prometheus:9090` |
| Loki | `loki` | `http://loki:3100` |
| Tempo | `tempo` | `http://tempo:3200` |

As correlações entre os três já vêm configuradas:

- **Trace para logs:** de um span no Tempo para as linhas do Loki com o mesmo `trace_id`.
- **Log para trace:** o campo derivado `TraceID` transforma o `trace_id` da linha de log em link para o Tempo.
- **Métrica para trace:** exemplares do Prometheus apontam para o trace correspondente.
- **Mapa de serviços:** alimentado pelas métricas `traces_service_graph_*` que o `metrics_generator` do Tempo grava no Prometheus por remote write.

## Verificação rápida

```bash
curl http://localhost:9090/-/healthy    # Prometheus
curl http://localhost:3100/ready        # Loki, responde 503 nos primeiros 15s
curl http://localhost:3200/ready        # Tempo, responde 503 nos primeiros 15s

# saúde dos três data sources vista pelo Grafana
for uid in prometheus loki tempo; do
  curl -s -u admin:admin "http://localhost:3002/api/datasources/uid/$uid/health"; echo
done
```

Os alvos de coleta ficam em <http://localhost:9090/targets>. Por padrão o
Prometheus coleta a cada 15 segundos e observa apenas a própria pilha
(Prometheus, Grafana, Loki e Tempo).

## Coletar as métricas da API

`apps/backend/api` já expõe `GET /metrics` no formato Prometheus quando
`METRICS_ENABLED=true` (o padrão). O `prometheus.yml` mantém o alvo
`view-show-api` comentado porque esta composição não inicia a API. Descomente o
bloco enquanto a API estiver rodando no host; sem ela, o alvo ficará `down`.
Para enviar traces da API rodando no host, aponte o exportador OTLP para
`http://localhost:4318` (HTTP) ou `localhost:4317` (gRPC).

## Limites deste ambiente

Esta configuração é de desenvolvimento e não deve ser usada como base para
produção: Loki e Tempo rodam em modo monolítico gravando em disco local, com
anel de consistência em memória e fator de replicação 1, e o Grafana usa a base
SQLite embutida. A retenção é de 7 dias para logs e traces e de 15 dias para
métricas.

O `tempo.yml` segue o schema da linha 3.x, que reorganizou a configuração: o
ingester virou `live_store` e a compactação passou para `backend_scheduler`. Um
arquivo escrito para o Tempo 2.x não é aceito por esta versão.
