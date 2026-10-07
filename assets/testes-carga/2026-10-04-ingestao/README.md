# Evidências brutas — CG-05 (volume progressivo) em AWS, 04/10/2026

&emsp; Execuções do CG-05 com 150.000 (massa M-08) e 300.000 eventos (M-09) num
Learner Lab novo, com a stack `view-show` criada do zero. A especificação, os resultados, a análise e os
dois desvios em relação ao plano (pré-condição do CG-02 não atendida e massa
concentrada em janelas de 15 min) estão em
[`artefatos/sprint5/testes-carga-ingestao.md`](../../../artefatos/sprint5/testes-carga-ingestao.md),
Tabelas 13, 14, 14a e 14b. Esta pasta guarda só o bruto que sustenta aqueles números.
A execução de 750.000 (M-10) foi iniciada às 22:21:11 UTC e interrompida aos 49 min,
quando o Docker Desktop parou e o k6 perdeu o contêiner; não há resultado dela, e o
estado do job na AWS não foi observado.

&emsp; As massas M-08 a M-10 foram geradas com
[`build_benchmark_snapshot.py`](../../../apps/backend/ingestion-data/scripts/build_benchmark_snapshot.py)
e a opção `--rows-per-window 150000` (`--variant cg05`, `--snapshot-extracted-on 2026-10-04`).

## Ambiente

| Item | Valor |
| --- | --- |
| Região / conta | `us-east-1` / `145497513075` (AWS Academy Learner Lab), namespace `view-show` |
| Implantação | `node apps/scripts/aws-learner-lab.mjs setup` em 2026-10-04, stack nova |
| Commit | `d7f56de` mais a opção `--rows-per-window` do gerador |
| Imagem da ingestão | `view-show-ingestion@sha256:90dcf1de…6a18a35` (`view-show-ingestion-import:1`) |
| Task `import-dump` | 2 vCPU / 8 GiB / 200 GiB de storage efêmero |
| Entrada | API Gateway `https://hk4ooeetbi.execute-api.us-east-1.amazonaws.com` → ALB → ECS |
| Autenticação | Cognito, usuário técnico `k6-ingestao@viewshow.test` |
| Gerador | k6 (imagem `grafana/k6` via Docker), **fora da AWS**, Windows 11 |

## Linha do tempo (UTC)

| Horário | Evento |
| --- | --- |
| 19:46:30 | k6 inicia o CG-05 com M-08 (`MODE=drenagem`) |
| 19:47:49 | Task `import-dump` inicia |
| 19:47:54 → 19:55 | INGESTING (447,5 s) |
| 19:55 → 20:11 | PROJECTING (958,1 s) |
| 20:11 → 20:24:18 | ARCHIVING (778,2 s); Athena de 20:11:22 a 20:12:18 e de 20:22:59 a 20:24:18 |
| 20:24:19 | Worker `SUCCEEDED`: 150.000 lidos, 150.000 escritos, 0 rejeitados |
| 20:24:31 | k6 encerra: `READY`, checks 7/7; thresholds de vazão e de duração reprovados (exploratório) |
| 20:45:37 | k6 inicia o CG-05 com M-09 |
| 20:46:50 | Worker inicia (`ingestion.run.started`) |
| 20:46:50 → 21:57:53 | INGESTING 868,5 s, PROJECTING 1.914,7 s, ARCHIVING 1.473,5 s |
| 21:57:53 | Worker `SUCCEEDED`: 300.000 lidos, 300.000 escritos, 0 rejeitados |
| 21:57:57 | k6 encerra: `READY`, checks 7/7; os mesmos thresholds reprovados |
| 22:21:11 | k6 inicia o CG-05 com M-10 (750.000) |
| 23:10:23 | k6 interrompido: `error waiting for container: unexpected EOF` (Docker Desktop parou) |

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| `ambiente.txt` | Conta, commit, task definition, Container Insights, modo do DynamoDB e agendamentos |
| `execucoes.txt` | Início e fim de cada execução do k6 |
| `k6-cg05-<volume>.log` | Log completo do k6 (150000, 300000 e o de 750000, interrompido) |
| `resumo-ingestao-cg05-<volume>.json` | Saída de `handleSummary()` |
| `etapas-cg05-<volume>.json` | `StageDurationMs` por etapa (CloudWatch, `view-show/Ingestion`) |
| `cloudwatch-recursos-cg05-<volume>.json` | CPU, memória e storage efêmero da task (`ECS/ContainerInsights`), por minuto |
| `cloudwatch-dynamodb-cg05-<volume>.json` | WCU/RCU consumidos, throttling e latência p99 da tabela `view-show-iac-operacional` |
| `athena-cg05-<volume>.json` | As 23 consultas `COUNT(*)` do ARCHIVING, com duração de cada uma |
| `logs-import-cg05-<volume>.json` | Log do worker (`/ecs/view-show-ingestion-backfill`) |

&emsp; `<volume>` é `150000` ou `300000`.
