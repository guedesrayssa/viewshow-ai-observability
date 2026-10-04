# Evidência de provisionamento — Grafana da ingestão

> Registro histórico, não suficiente como aceite do MR 90: a captura citada não
> foi versionada e as consultas de throughput/erros não foram validadas nessa
> rodada. A validação substituta de 04/10/2026 está registrada em
> [JSON sanitizado](../2026-10-04-ingestao/grafana-dashboard-validation.json) e
> [captura versionada](../2026-10-04-ingestao/grafana-ingestion.png).

- Data da validação: 30/09/2026
- Região: `us-east-1`
- Instância: `i-01002144eb3927c0d`
- Dashboard: `View Show — Ingestão`
- UID: `view-show-ingestion`
- Data source: `cloudwatch`

## Resultado relatado na rodada histórica

Este registro relata que o bootstrap terminou com o marcador `PROVISIONED`; os
containers Grafana, Prometheus, Loki, Tempo e Alloy foram iniciados e o arquivo
`view-show-ingestion.json` estava presente no diretório de provisioning.

A resposta da API local do Grafana registrada na ocasião foi:

```text
database: ok
version: 13.2.1
dashboard uid: view-show-ingestion
CloudWatch metrics API: successfully queried
CloudWatch logs API: successfully queried
```

A consulta foi executada internamente por AWS Systems Manager, sem expor o
Grafana à internet. Nenhuma credencial ou senha foi preservada nesta evidência.
Essa observação de saúde não valida todas as consultas dos painéis nem a versão
corrigida do MR 90. O aceite posterior está separado abaixo.

## Observação visual histórica do benchmark

O dashboard foi aberto pelo túnel SSM com a janela UTC
`2026-09-29T23:45:00Z–2026-09-30T03:00:00Z`, comando `backfill` e task
`view-show-ingestion-backfill`. A captura foi coletada em 30/09/2026 e mantida
aberta na tarefa para revisão, mas não foi versionada. O comando e a task acima
descrevem a seleção histórica; a versão corrigida usa um único seletor `Operação`
(`operation`) para correlacioná-los.

Segundo a observação registrada, o painel **Duração máxima por etapa** apresentou
as cinco séries emitidas pelo CloudWatch: `STARTING`, `RESTORING`, `VALIDATING`,
`INGESTING` e `PROJECTING`. Os pontos observados indicavam aproximadamente
10,36 min para ingestão e 18,14 min para projeção, coerentes com os valores brutos
de 621.536 ms e 1.088.407 ms.

Durante a coleta foi corrigido o formato das consultas do Grafana 13: dimensões
CloudWatch são arrays e consultas de métricas declaram `metricEditorMode=0` e
`metricQueryType=0`. A consulta foi também validada diretamente pela API do
data source, que retornou HTTP 200 e os cinco datapoints, conforme relatado
nessa rodada. Essa validação se limita à duração por etapa e não cobre as
expressões de throughput e erros/s reparadas no MR 90.

Os painéis baseados em `RunDurationMs`, `RecordsRead`, `RecordsWritten` e
`Runs` foram relatados sem amostra nessa janela porque a task terminou
externamente com código 137 antes de emitir métricas terminais. Isso é evidência
da lacuna de observabilidade já registrada; ausência de amostra não comprova a validade das
consultas de throughput/erros nem substitui seu aceite pelo CloudWatch.

## Verificações relatadas na rodada histórica

- configuração Terraform válida;
- template renderizado como JSON válido;
- 8 painéis, com IDs de painel e `refId` únicos;
- todos os painéis usam o data source `cloudwatch`;
- provisionamento AWS isolado em 1 criação da EC2, sem alteração da API ou das
  tasks de ingestão.

Essas verificações se referem à versão anterior e não substituem o aceite posterior.

## Validação substituta — 04/10/2026

A versão reparada do commit `5f993a5` foi validada na instância Terraform
`i-02d8393487d67a0bf`, conta `992648496097`, região `us-east-1`. Cloud-init
terminou, os cinco containers estavam em execução, o banco do Grafana 13.2.1
retornou `ok`, o arquivo do dashboard era JSON válido com UID
`view-show-ingestion` e o data source `cloudwatch` estava saudável.

As 32 chamadas diretas ao Grafana foram aceitas com HTTP 200 e sem erros. No
navegador, as quatro opções de `Operação` enviaram o comando e a família ECS
corretos, e as cinco expressões visíveis de throughput, erros e CPU tiveram
resultados HTTP 200. O JSON registra os alvos enviados, referências e contagens
de frames; HTTP 200 vazio não foi tratado como execução das expressões.

A captura das duas primeiras linhas de métricas usa a janela histórica UTC
`2026-09-29T23:45:00Z–2026-09-30T03:00:00Z`, com `backfill` selecionado. As
métricas de ingestão não apresentaram amostras nessa nova consulta; SQS teve
pontos esparsos. Isso não confirma desempenho nem altera o resultado reprovado
do benchmark. Os logs foram testados separadamente na janela
`2026-10-04T20:51:39.471Z–2026-10-04T21:06:39.471Z`, posterior à criação dos
novos grupos, com aceite pela API e pelo navegador.

Acesso por túnel privado SSM; nenhuma credencial, saída bruta do SSM ou state
Terraform foi incluído nas evidências públicas. A captura e os resultados da
API estão nos links do início deste registro.
