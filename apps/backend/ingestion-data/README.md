# Ingestion Data — runtime not implemented, observability ready

Ownership: time de ingestão de dados.

Este diretório reserva a fronteira do futuro processo batch que lerá as novas
fontes e publicará read models versionados (`VIEW#...`, incidentes, checkpoints
e runs) segundo os contratos em `artefatos/contratos`. Esta entrega não contém
worker, endpoint, scheduler, seed, leitor MySQL, normalizador ou projeção.

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
