# Evidência de provisionamento — Grafana da ingestão

- Data da validação: 30/09/2026
- Região: `us-east-1`
- Instância: `i-01002144eb3927c0d`
- Dashboard: `View Show — Ingestão`
- UID: `view-show-ingestion`
- Data source: `cloudwatch`

## Resultado

O bootstrap terminou com o marcador `PROVISIONED`; os containers Grafana,
Prometheus, Loki, Tempo e Alloy foram iniciados e o arquivo
`view-show-ingestion.json` estava presente no diretório de provisioning.

A API local do Grafana respondeu:

```text
database: ok
version: 13.2.1
dashboard uid: view-show-ingestion
CloudWatch metrics API: successfully queried
CloudWatch logs API: successfully queried
```

A consulta foi executada internamente por AWS Systems Manager, sem expor o
Grafana à internet. Nenhuma credencial ou senha foi preservada nesta evidência.

## Captura visual do benchmark

O dashboard foi aberto pelo túnel SSM com a janela UTC
`2026-09-29T23:45:00Z–2026-09-30T03:00:00Z`, comando `backfill` e task
`view-show-ingestion-backfill`. A captura foi coletada em 30/09/2026 e mantida
aberta na tarefa para revisão.

O painel **Duração máxima por etapa** apresentou as cinco séries emitidas pelo
CloudWatch: `STARTING`, `RESTORING`, `VALIDATING`, `INGESTING` e `PROJECTING`.
Os pontos principais confirmam aproximadamente 10,36 min para ingestão e
18,14 min para projeção, coerentes com os valores brutos de 621.536 ms e
1.088.407 ms.

Durante a coleta foi corrigido o formato das consultas do Grafana 13: dimensões
CloudWatch são arrays e consultas de métricas declaram `metricEditorMode=0` e
`metricQueryType=0`. A consulta foi também validada diretamente pela API do
data source, que retornou HTTP 200 e os cinco datapoints.

Os painéis baseados em `RunDurationMs`, `RecordsRead`, `RecordsWritten` e
`Runs` permanecem sem amostra nessa janela porque a task terminou externamente
com código 137 antes de emitir métricas terminais. Isso é evidência da lacuna de
observabilidade já registrada, não falha do data source.

## Validações locais associadas

- configuração Terraform válida;
- template renderizado como JSON válido;
- 8 painéis, com IDs de painel e `refId` únicos;
- todos os painéis usam o data source `cloudwatch`;
- provisionamento AWS isolado em 1 criação da EC2, sem alteração da API ou das
  tasks de ingestão.
