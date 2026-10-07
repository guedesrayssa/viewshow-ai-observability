# Evidências brutas — deploy da correção do achado 9 e RS-01, 05–06/10/2026

&emsp; Implantação da correção do achado 9 (renovação da visibilidade das
mensagens incrementais, commit `913acfc`) na stack `view-show` do Learner Lab,
e as rodadas do RS-01 feitas em seguida (05/10 e madrugada de 06/10, UTC). A
especificação dos testes, os resultados e a análise estão em
[`artefatos/sprint5/testes-carga-ingestao.md`](../../../artefatos/sprint5/testes-carga-ingestao.md);
esta pasta guarda só o bruto.

## Ambiente

| Item | Valor |
| --- | --- |
| Região / conta | `us-east-1` / `145497513075` (AWS Academy Learner Lab), namespace `view-show` |
| Commit | `1c0d9fa` (branch `feat/testes-ingestao`) |
| Imagem da ingestão | `view-show-ingestion:8be4568def6e` (`sha256:08474aaa…3615`); antes, `sha256:90dcf1de…6a18a35` |
| Task definitions | `view-show-ingestion-{import,incremental-ingest,incremental-export,sync,backfill}` de `:1` para `:2`; a `:1` de cada família ficou `INACTIVE` |
| Agendamentos | `sync`, `incremental-export` e `incremental-ingest` apontando para a `:2`, todos **DISABLED**; o `incremental-ingest` só foi ligado durante a drenagem de cada rodada do RS-01 |

## Como o deploy foi feito

&emsp; O caminho previsto, `node apps/scripts/aws-learner-lab.mjs update baseline`,
não roda no Windows: a validação do state compara o dono do arquivo com
`process.getuid()`, que não existe no Windows, e o plano é lido por
`/proc/self/fd/3`, que só existe no Linux. O `plan-update baseline` parou na
primeira checagem, sem gerar plano. Por isso o deploy repetiu o procedimento
de 30/09: `terraform apply -target` manual, com as mesmas variáveis do preset
`baseline` do script.

1. Backup do state em `apps/fullstack/.terraform-artifacts/state-backups/`
   (`terraform.tfstate.antes-deploy-achado9-20261005T142100Z`).
2. Imagem construída e publicada com `apps/fullstack/scripts/publicar-imagem.mjs`,
   com a tag que o Terraform calcula a partir do código (`8be4568def6e`).
3. Plano só com as 5 task definitions e a imagem (`deploy-plan-taskdefs.txt`,
   não aplicado). Os agendamentos apontam para a revisão pelo número
   (`…:1`), e `ingestao-falhas.sh agenda ingest ligar` só troca o `State`;
   sem atualizá-los, a agenda do RS-01 chamaria uma revisão `INACTIVE`. O plano
   aplicado inclui os 3 agendamentos, só com a troca de `task_definition_arn`
   (`deploy-plan-taskdefs-agendas.txt`, `deploy-apply.txt`).
4. Com `-target`, o Terraform não recalculou o output `ingestion_runbook`, que
   continuou com a `:1` e a imagem antiga. Novo backup do state
   (`terraform.tfstate.antes-refresh-only-20261005T143521Z`) e
   `terraform apply -refresh-only` (`deploy-plan-refresh-only.txt`,
   `deploy-apply-refresh-only.txt`). O refresh-only só gravou no state e nos
   outputs o que já estava na AWS (0 added, 0 changed, 0 destroyed). Além dos
   outputs, ele sincronizou drift que já existia: normalização do provider em
   38 alarmes, 2 metric filters, API Gateway, autoscaling, listener e NAT
   (`[]`/`{}` vazios e reordenação de `metric_query`), e valores preenchidos
   pela AWS no bastion (IP público `54.162.76.194` → `3.86.70.75`), EIP,
   target group, rotas `0.0.0.0/0`, Cognito e criptografia do bucket de flow
   logs. Nenhum recurso remoto foi alterado.

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| `execucoes.txt` | Horário de cada passo (UTC) |
| `deploy-plan-taskdefs.txt` | Plano só com task definitions e imagem (não aplicado) |
| `deploy-plan-taskdefs-agendas.txt` | Plano aplicado: task definitions, imagem e 3 agendamentos |
| `deploy-apply.txt` | Saída do `apply -target` |
| `deploy-plan-refresh-only.txt` | Plano `-refresh-only` |
| `deploy-apply-refresh-only.txt` | Saída do `apply -refresh-only` |
| `ativacao-dataset-150000.json` | Resposta da ativação do dataset da importação de 150.000 eventos, pré-condição do RS-01 |
| `rs01-<N>lotes-execucao.txt` | Marcos de cada rodada do RS-01 (pré-checagem, publicação, agenda ligada/desligada, motivo do fim) |
| `rs01-<N>lotes-lotes.json`, `rs01-<N>lotes-publicacao.log` | Lotes publicados (janela, `batchId`, SHA-256, chave do manifesto) |
| `rs01-<N>lotes-acumulo.txt` | Contagem antes da publicação e estado da fila a cada ~30 s durante o acúmulo |
| `rs01-<N>lotes-drenagem.txt` | Fila, DLQ, tasks e registros `BATCH#` a cada ~30 s durante a drenagem, e contagem final |
| `rs01-<N>lotes-logs-ingest.json`, `rs01-<N>lotes-runs.txt` | Logs do `ingest-incremental` na janela e resumo dos runs e das linhas de alerta |
| `rs01-alarmes.txt` | Histórico de estado dos alarmes da FIFO incremental de 05/10 15:00Z a 06/10 05:00Z |
| `rs01-2lotes-coleta-final.txt` | Coleta final feita à mão depois da falha do monitor na rodada de 2 lotes |
| `sqs-rs01-<N>lotes.json` | Métricas SQS da janela (`ingestao-falhas.sh metricas-fila`) |
| `verificacao-pos-deploy.txt` | Revisões, imagens, agendamentos, imagem no ECR, `terraform output` e comparação do `visibility_heartbeat.py` da imagem com o commit |
