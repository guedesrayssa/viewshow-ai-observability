# Evidências brutas — testes de carga e resiliência da ingestão em AWS, 30/09/2026

&emsp; Primeira rodada dos testes de carga (CG-01 a CG-05) e de falha (RS-01 a
RS-06) da API de ingestão na stack `view-show` do Learner Lab. A especificação
de cada teste, os resultados e a análise estão em
[`artefatos/sprint5/testes-carga-ingestao.md`](../../../artefatos/sprint5/testes-carga-ingestao.md);
esta pasta guarda só o bruto que sustenta aqueles números. Os cenários
incrementais que faltaram (RS-03a, RS-04) e a repetição do RS-05 foram
executados no dia seguinte, em [`2026-10-01-ingestao/`](../2026-10-01-ingestao/).

&emsp; Os `resumo-ingestao-*.json` são a saída de `handleSummary()` de cada
`k6 run` de
[`loadtest/k6/ingestao-batch.js`](../../../apps/backend/api/loadtest/k6/ingestao-batch.js);
os `k6-*.log` são o log completo da execução. As injeções e reversões de falha
foram feitas com
[`loadtest/k6/ingestao-falhas.sh`](../../../apps/backend/api/loadtest/k6/ingestao-falhas.sh).

## Ambiente

| Item | Valor |
| --- | --- |
| Região / conta | `us-east-1` / `114388221188` (AWS Academy Learner Lab), namespace `view-show` |
| Commit | `4c9b236` até 19:45 UTC; `0eded5d` depois (correção de `pk`/`sk` e log de causa) |
| Imagem da ingestão | `view-show-ingestion@sha256:1fa9cb2d…` até 19:45 UTC; `sha256:2d409c86…` (revisão 6) depois (`rs01-digest-task.txt`) |
| Imagem da API | `view-show-iac-api:96ef64f46bff`, 0,25 vCPU / 512 MB, `RATE_LIMIT_PER_MINUTE=180` |
| Task `import-dump` | 2 vCPU / 8 GiB / 200 GiB de storage efêmero |
| Entrada | API Gateway `https://ygnmcngd28.execute-api.us-east-1.amazonaws.com` → ALB → ECS |
| Autenticação | Cognito `us-east-1_Yr4YHWZ4a`, usuário técnico `carga-sprint5@viewshow.test` |
| Gerador | k6 v2.3.0 (imagem `grafana/k6` via Docker), **fora da AWS**, Windows 11 |

&emsp; A configuração completa está em `ambiente.txt`. A troca de imagem às
19:45 UTC foi um `terraform apply -target` no meio da rodada; os testes
anteriores rodaram com o defeito de `pk`/`sk` do caminho incremental.

## Linha do tempo (UTC)

| Horário | Evento |
| --- | --- |
| 10:10 → 10:13 | CG-01 |
| 10:16 → 11:16 | CG-02 R1 (interrompida pela injeção do RS-02b às 11:14) |
| 11:01 → 11:05 | RS-06 |
| 11:01 → 12:35 | RS-01 da manhã e RS-05 com os mesmos lotes (reentregas até a DLQ) |
| 12:10 → 12:18 | RS-02(a): 1ª tentativa falhou no script; 2ª injeção às 12:14 |
| 12:18 → 12:19 | RS-03(b) com o dump corrompido M-07 |
| 12:19 → 12:24 | CG-04 |
| 12:27 → 12:29 | RS-02(c) |
| 12:29 → 16:21 | CG-02 R2 (coleta às 19:02) |
| 16:03 | DLQ incremental esvaziada (2 mensagens do RS-01/RS-05 da manhã) |
| 19:45 | Implantação da correção de `pk`/`sk` (revisão 6) |
| 19:51 → 19:54 | RS-02(a) repetido com a revisão 6 |
| 20:16 → 20:57 | RS-01 da tarde, interrompido no limite de 1.800 s |

&emsp; As credenciais do Learner Lab foram revogadas entre ~09:50 e 10:10 UTC
(renovadas às 10:32) e de novo por volta de 14:25 UTC, durante o ARCHIVING do
CG-02 R2. O registro bruto de horários é `execucoes.txt`.

## Arquivos

| Teste | Arquivos | Conteúdo |
| --- | --- | --- |
| Ambiente | `ambiente.txt`, `execucoes.txt`, `alarmes-antes.json` | Configuração da stack; início, fim e `exit` de cada execução; estado dos alarmes antes da rodada |
| Testes automatizados | `pytest-resiliencia-linux.txt`, `pytest-resiliencia-windows.txt`, `vitest-uc-imp.txt` | Saída das suítes de resiliência e de importação |
| Publicador incremental | `dryrun-valid.json`, `dryrun-missing-column.json`, `dryrun-poison.json` | `publish_incremental_batch.py --dry-run` das três variantes de lote |
| CG-01 | `resumo-ingestao-cg01.json`, `k6-cg01.log`, `etapas-cg01.json`, `cloudwatch-recursos-cg01.json`, `imports-apos-cg01.json` | Resumo do k6, duração de cada etapa do worker, CPU/memória/storage da task e lista de importações |
| CG-02 | `resumo-ingestao-cg02-r*.json`, `k6-cg02-r*.log`, `etapas-cg02-r*.json`, `cloudwatch-recursos-cg02-r*.json`, `cloudwatch-dynamodb-cg02-r*.json`, `athena-cg02-r*.json`, `import-cg02-r1-antes-parada.json`, `import-cg02-r1-rs02b-final.json`, `import-cg02-r2-final.json`, `cg02-r2-acompanhamento.txt` | R1 e R2: resumo, etapas, recursos da task, WCU do DynamoDB, consultas do ARCHIVING no Athena e estado da importação |
| CG-04 | `resumo-ingestao-cg04.json`, `k6-cg04.log`, `cg04-status-post.txt`, `cloudwatch-recursos-api-cg04.json` | Resumo da rajada, contagem de status do `POST` e CPU da API |
| RS-01 | `rs01-acumulo.txt`, `rs01-drenagem.txt`, `rs01-causa-raiz.txt`, `rs01-logs-ingest.txt`, `rs01-digest-task.txt`, `rs01-dlq-espiar.json`, `rs01-{manha,tarde}-lotes.json`, `rs01-{manha,tarde}-tasks.txt`, `sqs-rs01.json`, `sqs-rs01-rs05.json` | Manhã e tarde: lotes publicados, estado das filas e dos lotes, tasks, logs do consumidor, causa raiz do `pk`/`sk` e métricas SQS |
| RS-02 | `rs02a-*`, `resumo-ingestao-rs02a-recuperacao.json`, `k6-rs02a-recuperacao.log`, `rs02b-*`, `resumo-ingestao-rs02c.json`, `k6-rs02c.log` | (a) S3 negado, incluindo a 1ª tentativa que falhou no script; (b) parada do worker; (c) timeout |
| RS-03(b) | `resumo-ingestao-rs03-m07.json`, `k6-rs03-m07.log`, `import-rs03-m07.json` | Importação do dump corrompido M-07 até `FAILED` |
| RS-05 | `rs05-ciclos.txt`, `rs05-dlq-espiar.json`, `sqs-rs01-rs05.json` | Ciclos de reentrega dos lotes do RS-01 da manhã até a DLQ |
| RS-06 | `resumo-ingestao-rs06.json`, `k6-rs06.log`, `rs06-diagnostico-rate-limit.txt`, `cloudwatch-recursos-api-rs06.json` | Rajada contra o rate limit, diagnóstico API Gateway × ALB e CPU da API |
