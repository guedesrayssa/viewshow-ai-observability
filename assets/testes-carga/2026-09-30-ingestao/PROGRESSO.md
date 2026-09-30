# Progresso da rodada de 2026-09-30 (pausada às ~23:15 UTC)

Documento de resultados: `artefatos/sprint5/testes-carga-ingestao.md` (revisão de conformidade aplicada em 30/09, fim do dia).
Linha do tempo das execuções: `execucoes.txt`.

## Onde paramos

- Último teste executado: **RS-01 da tarde** (20:16–20:57 UTC), com a imagem da revisão 6 (`sha256:2d409c86…`). Reprovado por um defeito novo (`visibility_timeout`, achado 9 da Seção 9). Já está registrado no documento.
- Depois disso não foi rodado nenhum teste. O RS-03(a) **não** foi iniciado.
- Às ~23:14 UTC as credenciais do Learner Lab estavam revogadas de novo (`voc-cancel-cred` negando ECS, Scheduler, S3 e SQS). Por isso o estado do ambiente abaixo é o **último registrado nas evidências**, e não uma conferência feita agora.

## Estado do ambiente (último registro)

| Item | Estado | Fonte |
| --- | --- | --- |
| 3 agendamentos (`sync`, `incremental-ingest`, `incremental-export`) | DISABLED às 20:55:56 UTC | `rs01-drenagem.txt` |
| Tasks `ingest-incremental` em execução | nenhuma às 20:55:57 UTC | `rs01-drenagem.txt` |
| Política do bucket de ingestão | removida às 19:52:06 UTC (`s3-restaurar`; o estado original é sem política) | `execucoes.txt` |
| DLQ incremental | 1 mensagem (lote `bat_f68597fc…`, `ApproximateReceiveCount = 6`), **mantida de propósito como evidência do RS-01**; alarme `*-incremental-dlq-depth` em `ALARM` por causa dela | `rs01-dlq-espiar.json`, `rs01-drenagem.txt` |

**Primeira coisa ao retomar:** renovar as credenciais do Learner Lab e confirmar esses 4 itens (`ingestao-falhas.sh recursos`, `ingestao-falhas.sh filas`, `aws s3api get-bucket-policy`, `aws ecs list-tasks`).

## O que falta

### Testes pendentes (precisam de execução na AWS)

1. **RS-03(a)** — válido → inválido (M-06) → válido na FIFO. Não executado.
2. **RS-04** — interromper a task `ingest-incremental` no meio de um lote. Não executado.
3. **CG-03** — frescor ponta a ponta (RNF02), 5 amostras. Não executado.

Os três estavam bloqueados pelo defeito `PK`/`SK`, que foi corrigido e implantado às 19:45 UTC. Todos vão esbarrar no defeito novo do RS-01 (lote de 150 mil leva mais que 300 s de escrita): decidir antes se corrigem o `visibility_timeout` primeiro ou se rodam assim e registram o efeito.

### Parciais a fechar na redação (sem nova execução)

- **CG-04** — 71 × `503` em vez de `409`; justificar o Parcial (a causa provável, disputa na leitura do registro ativo com a CPU em 92,8%, não pôde ser confirmada porque o log da API não grava `error.code`).
- **RS-05** — “100% das válidas processadas” não verificado; executado só com os lotes da manhã (defeito `PK`/`SK`). Decidir se fica Parcial com justificativa ou se entra na próxima rodada.
- **RS-06** — sem `429` pela URL pública (API Gateway); rate limit só funciona direto no ALB.

### Não executados a justificar na redação

- **CG-02 R3** — exige um terceiro dump distinto (ex.: `--variant r3`) e ~4 h de sessão (a R2 levou 13.915 s).
- **CG-05** — inviável com o gerador atual (ARCHIVING cresce com o número de partições diárias: estimativa de ~5 h para M-03 e ~13 h para M-04).

### Defeito novo sem correção

- **RS-01 / `visibility_timeout`** (achado 9 da Seção 9): `visibility_timeout` de 300 s na FIFO × escrita de 482–712 s por lote + agenda de 5 min → outro run recebe a mesma mensagem, muda o estado/versão do lote e a transição final do primeiro falha com `ConditionalWriteError`; um lote fica sem confirmação e vai para a DLQ. Os runs que encontram o lote em uso terminam `SUCCEEDED` sem log da causa (lacuna de observabilidade). Nenhuma correção feita.

### Figuras e observabilidade

- **Figuras 2 a 7** (Seção 8.3) pendentes: capturas do Grafana/Prometheus. O Prometheus local não coleta a API da AWS (alvo `host.docker.internal:3000`); só há séries do CloudWatch em JSON.

### Ambiente

- **Bastion** ficou fora do `terraform apply -target` de 19:45 UTC (desvio do Learner Lab); pendente de ambiente. Até um `apply` completo, a stack pode divergir do Terraform.

### Números do documento sem arquivo de evidência em `assets/` (Seção 1 exige)

Registrar a evidência numa próxima sessão, ou marcar no documento como “sem evidência arquivada”:

- Horários de alarme da manhã: RS-01 backlog 11:03:05 e idade 11:18:32; RS-03(b) `import-worker-failures` 12:20:12 e volta a `OK` 12:35:12; RS-05 `dlq-depth` 12:36:25; CG-04 `AlarmHigh` 12:25:54 e 2ª task 12:25:56. Sustentam o RNF15 e o achado 6/7. Dá para recuperar com `aws cloudwatch describe-alarm-history` (histórico fica 14 dias).
- RS-02(b): lease `argus` expirado às 11:20:14.
- Tabela 7: SHA-256 de M-01 a M-04 e M-07 e tamanhos de M-03/M-04 (os manifestos estão em `.artifacts/argus-benchmarks/`, fora do git).
- Tabela 26: CPU da API 3,2% em smoke/drenagem (só há `cloudwatch-recursos-api-cg04.json` e `-rs06.json`).
- Seção 4.4: “54 valores distintos de `datetime.now()` em 200 mil chamadas” no Windows.
- Seção 10: janela da primeira revogação de credenciais (09:50–10:10, renovação 10:32 UTC) e a de ~14:25 UTC (só no histórico deste arquivo).
- RS-01 da tarde: horário em que `*-queue-oldest-age` entrou em `ALARM` (só está registrada a volta a `OK`, 20:56:43).

## Limpeza opcional (confirmar antes com o time)

- Mensagem na DLQ incremental (mantida como evidência; o alarme de DLQ fica em `ALARM` enquanto ela estiver lá).
- Usuário Cognito `carga-sprint5@viewshow.test`.
- Dumps em `.artifacts/argus-benchmarks/{150000,150000-r2,300000,750000}` (fora do git).

## Observações

- Pasta de evidências reorganizada em 30/09: removidos 2 instantâneos intermediários da R2 (`import-cg02-r2-retomada.json`, `etapas-cg02-r2-parcial.json`), substituídos por `import-cg02-r2-final.json` e `etapas-cg02-r2.json`. Os arquivos da manhã que a rodada da tarde tinha sobrescrito foram recuperados de uma cópia de sessão: `rs01-manha-lotes.json`, `rs01-manha-tasks.txt`, `rs02a-tentativa1-injecao.txt`, `rs02a-tentativa1-liberacao-vaga.txt`; os da tarde viraram `rs01-tarde-lotes.json` e `rs01-tarde-tasks.txt`.
- Os scripts auxiliares da rodada (k6 via Docker, `etapas.py`, `recursos.py`, `ddb.py`, `lote.sh`, `concluir.py`, monitor do RS-01) ficaram nos scratchpads das sessões e **não** estão no repositório.
