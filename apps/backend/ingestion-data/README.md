# Ingestion Data — contratos de fatos e observabilidade prontos

Ownership: time de ingestão de dados.

Este diretório reserva a fronteira do processo batch que lerá as novas
fontes e publicará read models versionados (`VIEW#...`, incidentes, checkpoints
e runs) segundo os contratos em `artefatos/contratos`. Esta entrega ainda não contém
worker, endpoint, scheduler, leitor MySQL ou projeção completa.

O módulo `view_show_ingestion.facts` implementa a fronteira já consumida pelo
worker de análise: identidade canônica da série e construção do item DynamoDB.
O mesmo exemplo de canal produz o mesmo SHA-256 no runtime Python e no runtime
TypeScript. O produtor deve usar `build_fact`; recriar chaves manualmente pode
tornar uma série invisível ao worker.

```python
from view_show_ingestion import SeriesIdentity, build_fact

item = build_fact(
    dataset_version="argus-2026-09-01",
    identity=SeriesIdentity("live_active_15min", "argus", "globo-rj",
                            "active_sessions", {"channel": "globo-rj"}),
    observed_at="2026-08-02T00:00:00Z", grain_seconds=900,
    unit="count", value=120,
)
```

O backend operacional é somente consumidor. A PR futura deve respeitar
proveniência, measurement, cobertura, freshness e a inexistência de fila no
pipeline batch atual.

## Contrato de observabilidade

O pacote Python `view_show_ingestion` já fornece os hooks que o futuro processo
batch deve usar. Ele cobre métricas de volume, duração, qualidade/freshness,
rejeições, schema drift e lease; cria o trace raiz `ingestion.run` e spans por
etapa (nunca por registro); e escreve logs JSON com `trace_id`/`span_id` e
redação de segredos. O encerramento de cada run força o flush, necessário em
tasks curtas.

```python
from view_show_ingestion import IngestionTelemetry

telemetry = IngestionTelemetry()
with telemetry.run("sync", run_id) as run:
    with telemetry.stage("read", "orders"):
        telemetry.record_source("orders", read=read, written=written)
```

Configuração para a stack local:

```bash
export OTEL_SERVICE_NAME=view-show-ingestion
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4320
export DEPLOYMENT_ENVIRONMENT=development
```

Os logs são escritos em JSON no `stdout`, sem chamadas síncronas ao Loki; o
Alloy coleta a saída dos containers locais e o runtime da AWS pode encaminhá-la
ao destino de logs da plataforma.

O runtime de referência é Python 3.13, declarado em `.python-version`. Instale e
teste com `python3.13 -m pip install -e .` e
`python3.13 -m unittest discover -s tests`. Ainda não há entrypoint de negócio:
portanto, métricas e traces começam a aparecer apenas quando o futuro worker
importar e invocar estes hooks.
