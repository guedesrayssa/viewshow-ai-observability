# Recuperação operacional e reconciliação dos dados

Este procedimento cobre API, workers, filas e corrupção/exclusão da tabela
operacional. Os parâmetros vêm dos arquivos atuais; os tempos de recuperação
citados no artefato de carga pertencem às rodadas identificadas. O ensaio de
restauração e troca de tabela ainda não foi executado. Não há RPO/RTO aprovado.

## 1. Antes de executar uma contingência

Registrar conta/região/cluster, namespaces, commit, digests, réplicas, estado das
agendas e instante da falha em UTC. Preservar logs, eventos, manifesto ACTIVE,
checkpoints, outbox e atributos das filas. Selecionar os alvos do incidente;
não atuar em outro cluster nem apagar a tabela original, o bucket ou as filas.

As tabelas operacionais são declaradas em
[dynamodb.tf](../fullstack/dynamodb.tf), sem bloco point_in_time_recovery.
PITR precisa ter sido habilitado **antes** da corrupção; habilitá-lo depois
não cria um ponto anterior. A existência do runbook não comprova um backup.
Se não existir PITR ou backup verificado, o caminho é reconstruir uma candidata
de um snapshot íntegro/versionado, com cobertura dos lotes seguintes; se o
histórico estiver incompleto, registrar perda e manter a ativação bloqueada.

## 2. Detecção de falha e progresso

| Componente | Sinal / configuração existente | Tratamento e limite |
| --- | --- | --- |
| API startup | HTTP GET /health:3000, período 3 s, timeout padrão Kubernetes 1 s, 30 falhas, 1 sucesso | Falhas consecutivas reiniciam o contêiner; janela nominal de tentativas ≈90 s, sem prometer tempo exato de restauração |
| API readiness | Mesmo endpoint, período 5 s, timeout 3 s, 3 falhas, 1 sucesso | Retira o Pod dos endpoints; não reinicia o processo |
| API liveness | Mesmo endpoint, período 15 s, timeout 3 s, 3 falhas, 1 sucesso | Reinicia o contêiner; endpoint compartilhado torna saturação indistinguível de travamento neste desenho |
| MySQL sidecar | mysqladmin ping, período 5 s, timeout 3 s, 60 falhas, 1 sucesso | Ingestão aguarda startup; sem liveness própria; término do Job encerra o sidecar |
| Worker de análise | Checkpoint durável por escopo, estado SUCCEEDED e ack da mensagem; lease de 300 s e renovação a cada 60 s | Renovação de lease/SQS comprova posse, não progresso. Não há liveness HTTP nem watchdog de progresso implementado |
| Job de ingestão | Contadores e etapa persistidos do run; deadline 86.400 s para snapshot e 3.600 s para demais Jobs; backoffLimit=0, restartPolicy=Never | Processo com erro não é repetido automaticamente pelo Job; novo processamento exige reconciliar estado/lease e novo acionamento |
| Worker encerrando | SIGTERM/SIGINT interrompem novos receives; drain até 110 s; terminationGracePeriodSeconds=120 | Trabalho pendente pode ser reentregue; a confirmação só ocorre após persistência |

Fontes: [render.mjs](render.mjs),
[orchestrator.ts](../backend/agentic/src/worker/orchestrator.ts),
[analysis-worker.ts](../backend/agentic/src/bootstrap/analysis-worker.ts) e
[worker-runtime.ts](../backend/agentic/src/bootstrap/worker-runtime.ts).
Os limiares não especificados no renderer são defaults Kubernetes. Capturar o
manifest live para conferir overrides do ambiente.

Para parar uma execução sem perder a investigação, salvar eventos/logs/estado
antes da intervenção. Em snapshot interrompido, reconciliar FAILED e esperar
expiração da posse antes de reservar novamente. A liveness da API precisa de
revisão: a carga EKS já comprovou reinícios por saturação; aumentar limiares
sem repetir a carga não comprova correção.

## 3. Filas e indisponibilidade prolongada

| Parâmetro | Valor atual / arquivo |
| --- | --- |
| Retenção da análise e sua DLQ; incremental FIFO e sua DLQ | 1.209.600 s = 14 dias, default retencao_filas_ingestao_segundos em ingestion-variables.tf |
| Visibilidade da principal | 300 s; ingestion-messaging.tf |
| Long polling | 20 s |
| Recebimentos antes da DLQ | maxReceiveCount=5 |
| Incremental: renovação | Heartbeat verifica a cada 15 s e renova quando faltam ≤60 s, para mais 300 s; acompanha todas as mensagens recebidas, inclusive as esperando processamento |
| Análise: renovação | A cada 60 s renova lease de 300 s e visibilidade para 300 s |
| Análise: retry de dependência | Visibilidade 30/120/300/900 s por tentativa; lease ocupado usa 60 s |

Fontes: [ingestion-messaging.tf](../fullstack/ingestion-messaging.tf),
[ingestion-variables.tf](../fullstack/ingestion-variables.tf),
[ingest_incremental.py](../backend/ingestion-data/application/ingest_incremental.py),
[visibility_heartbeat.py](../backend/ingestion-data/application/visibility_heartbeat.py).
Visibilidade e retenção são prazos diferentes: heartbeat não impede expiração.
A extensão de visibilidade também tem limite de 12 h a partir do recebimento,
sem reiniciar esse relógio. [Referência AWS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).

Em fila standard, a passagem para DLQ preserva o instante original de envio;
em FIFO ele é reiniciado. Como a análise usa 14 dias tanto na principal quanto
na DLQ, a passagem para DLQ não garante outros 14 dias de análise operacional.
Essa política não segue a recomendação de DLQ com retenção maior que a origem;
14 dias já é o teto SQS e exige orçamento menor na origem ou cópia durável
independente antes de expirar. [Referência AWS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).

Procedimento de pausa e retomada:

1. Medir profundidade, em-processamento, idade, receives e DLQ. Comparar o prazo
   restante com o tempo estimado de reparo mais drenagem. Se a retenção não
   cobrir esse período, preservar payloads/referências em armazenamento durável
   antes de expirar; em S3 registrar bucket/key/versionId/SHA e alcance da cópia.
2. Suspender ingestion-incremental-export, ingestion-incremental-ingest e sync;
   guardar o estado anterior. Escalar analysis-worker para zero para cessar
   novos receives; aguardar drain e preservar mensagens não confirmadas.
   Suspender agenda não interrompe um Job já em execução: reconciliá-lo antes
   de parar. Não continuar recebendo dados válidos durante contenção que
   consome maxReceiveCount; esse defeito está demonstrado no CT-03.
3. Reparar destino/permissões/referências. Conferir o manifesto compatível,
   lease expirado, objetos versionados disponíveis e margem de retenção.
4. Retomar primeiro um consumidor e um lote canário. Exigir checkpoint, contagem
   independente, sem duplicação, ack após persistência e DLQ sem aumento.
5. Inspecionar a DLQ antes de redrive; corrigir a causa e preservar idempotência.
   Mensagem expirada precisa ser reconstruída da fonte durável, sem inventar
   um sucesso ou presumir que redrive recupera o que já foi apagado.
6. Drenar o backlog, validar watermark e só então restaurar os produtores e o
   estado original das agendas. Registrar condição→alerta e fim do reparo→
   recuperação. Se o prazo de alerta exceder 30 s, RNF15 continua reprovado.

## 4. Corrupção ou exclusão da tabela operacional

### 4.1 Selecionar um ponto consistente e restaurar

Bloquear novas operações de escrita/importação na entrada e pausar produtores
e consumidores como acima. Os registros de ACTIVE, manifesto, importações,
outbox, checkpoints e versões S3 definem o último conjunto consistente anterior
à falha; o timestamp mais recente disponível pode já conter corrupção.
Selecionar um instante anterior à primeira escrita defeituosa, dentro da janela
PITR. Registrar lacunas entre esse instante e a falha como RPO observado.

Com variáveis escolhidas para o ambiente do incidente, os comandos são:

```bash
aws dynamodb describe-continuous-backups --table-name "$RECOVERY_SOURCE_TABLE"
aws dynamodb restore-table-to-point-in-time \
  --source-table-name "$RECOVERY_SOURCE_TABLE" \
  --target-table-name "$RECOVERY_TARGET_TABLE" \
  --restore-date-time "$RECOVERY_TIMESTAMP_UTC"
aws dynamodb wait table-exists --table-name "$RECOVERY_TARGET_TABLE"
aws dynamodb describe-table --table-name "$RECOVERY_TARGET_TABLE"
```

Exigir nome novo e tabela ACTIVE; não restaurar sobre a original. Conferir
trace-index e outbox-pending-index. Reconfigurar IAM para o ARN e índices novos,
TTL, PITR, tags, alarmes e quaisquer Streams usados; não presumir que a restauração
transfere essas configurações. [Procedimento oficial AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery.Tutorial.html).

### 4.2 Reconciliar S3, tabelas de fatos e mensagens

O PITR da tabela operacional não retrocede os objetos S3 nem as tabelas físicas
de fatos. Ler ACTIVE e manifestos na nova tabela, conferir datasetVersion,
contagens, checksums e cada bucket/key/versionId no S3. Validar catálogos/partições
Glue e consultas Athena contra as versões aprovadas. Se uma tabela de fatos
também foi corrompida, reconstruir uma candidata independente a partir do dump
e dos lotes versionados, com ACTIVATE_CANDIDATE=false; restaurar só o controle
não corrige fatos corrompidos.

Inventariar lotes/mensagens em três conjuntos: confirmados antes do ponto,
pendentes no ponto e produzidos depois dele. Conferir outbox e checkpoints
completos antes de reprocessar. Para cada pendente, validar objeto e versão,
reexecutar com a identidade determinística original, comparar contagem/distintos
e confirmar depois do commit. Mensagens cujo dataset/modelo não é compatível
ficam isoladas; não reprocessar toda a fila indiscriminadamente.

### 4.3 Trocar o destino e validar

A referência OPERATIONAL_TABLE_NAME deve mudar em **todos** os workloads:
API, análise, templates de import/backfill e CronJobs. Os arquivos
[workloads.tf](../fullstack/workloads.tf) e
[ingestion-runtime.tf](../fullstack/ingestion-runtime.tf) hoje usam diretamente
aws_dynamodb_table.operacional; apenas um kubectl set env seria revertido pelo
deploy seguinte e deixaria outros componentes no destino antigo.

Para a contingência, exportar kubernetes_deployment para arquivo privado 0600,
alterar somente os valores OPERATIONAL_TABLE_NAME no contrato, manter agendas
suspensas/análise em zero e aplicar por KUBERNETES_CONFIG_FILE no
[deploy.mjs](deploy.mjs). Revisar previamente as permissões IRSA do ARN novo;
LabRole não deve ser presumida como acesso universal. Não publicar esse arquivo,
pois contém segredos. A admissão dos Jobs deve ser regenerada junto aos templates.
Após o incidente, incorporar o destino restaurado à configuração/IaC com
preservação da tabela original e plano revisado antes de qualquer deploy normal.

Antes de reabrir escrita, ler diretamente a nova tabela com ConsistentRead,
conferir ACTIVE/manifestos/fatos/S3, autenticar na API, comparar dados do painel
com os persistidos e executar um lote canário com idempotência/replay. Guardar
hashes, amostras, digests e início/fim; RTO termina quando o contrato e as
consultas voltam a funcionar, não quando a tabela fica ACTIVE.

Se a validação falhar, manter consumidores parados e escrita bloqueada. Não
voltar a escrever na tabela corrompida. Depois de aprovada a troca, retomar
consumidor, backlog e produtores nessa ordem. A tabela original fica preservada
para investigação até o encerramento do incidente.
