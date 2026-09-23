# Importação ARGUS rápida e resiliente

## Objetivo

Reduzir o tempo de uma importação ARGUS de aproximadamente 77 horas projetadas
para uma meta inicial inferior a duas horas, sem publicar dados incompletos e sem
obrigar a pessoa usuária a reiniciar todo o processo após uma falha transitória.

Esta especificação evolui o fluxo de importação assíncrona descrito em
`docs/superpowers/specs/2026-09-17-argus-import-design.md`. Upload multipart,
controle de autoria, histórico compartilhado e ativação explícita permanecem
válidos. O trabalho aqui começa depois que o upload foi concluído.

## Evidência que motiva a mudança

A importação `imp_01M2XKZ3BX076WH4QBQKW1MRJS` restaurou o snapshot em cerca de
50 minutos, validou-o em 16 segundos e permaneceu 15 horas e 42 minutos em
`INGESTING`. Ela gravou 1.874.500 dos 9.253.953 registros, sem rejeições, antes
de falhar com MySQL 2013: conexão perdida durante uma consulta que excedeu o
timeout de leitura de 30 segundos.

O ritmo médio observado foi de aproximadamente 33 registros por segundo. Nesse
ritmo, a carga completa levaria 77,5 horas. Não houve throttling relevante no
DynamoDB e a CPU da task não permaneceu saturada; a espera estava concentrada
nas consultas MySQL e nas chamadas sequenciais ao DynamoDB.

Há quatro causas concretas:

- `MySqlSourceReader` fixa `read_timeout` e `write_timeout` em 30 segundos;
- cada página de 500 registros abre uma nova conexão MySQL;
- `signal_bucket`, `finding_status_log` e `live_event` não possuem índice cujo
  prefixo corresponda à respectiva `cursorKey`;
- cada página executa leituras fortes, marcadores de idempotência, catálogos,
  checkpoints e várias `TransactWriteItems` sequenciais antes de produzir o
  arquivo canônico.

## Critérios de sucesso

- A mesma carga de 9.253.953 registros conclui em menos de duas horas no perfil
  Learner Lab depois da fase 2. Esse é um objetivo de benchmark, não uma promessa
  derivada apenas de configuração.
- Uma desconexão MySQL 2006/2013 durante uma página é recuperada sem duplicar nem
  perder registros.
- Uma interrupção antes do commit marker pode reler o snapshot, mas nunca reenvia
  um objeto canônico de conteúdo idêntico; depois do marker validado, restore,
  extração e archive são pulados integralmente.
- O candidato nunca se torna ativo antes da reconciliação de contagens,
  checksums, projeções e arquivos canônicos.
- O frontend diferencia worker saudável, operação lenta, retry transitório e
  ausência de progresso.
- Toda falha pública possui código seguro, etapa, tentativa e ação de recuperação;
  stack trace, credenciais, bucket e cursor físico continuam privados.
- O caminho existente de sincronização incremental não muda de semântica.

## Decisão arquitetural

A implementação será incremental e dividida em três entregas independentes.

### Fase 1 — leitura MySQL previsível e retomável

O backfill continua monolítico, mas passa a preparar o snapshot antes de
ingeri-lo. Um adaptador dedicado garante índices compatíveis com cada
`cursorKey`, executa `ANALYZE TABLE` apenas quando cria índice e valida o plano
com `EXPLAIN FORMAT=JSON`.

O leitor recebe timeouts e política de retry por configuração. Erros MySQL 2006
e 2013 repetem exatamente a página corrente em uma nova conexão, usando backoff
exponencial com full jitter e número limitado de tentativas. O checkpoint só
avança depois que todos os efeitos da página são reconciliados.

Configuração inicial do import worker:

- `PAGE_SIZE=5000` no primeiro canário (o default de código/IaC permanece 500 até o benchmark);
- `MYSQL_CONNECT_TIMEOUT_SECONDS=10`;
- `MYSQL_READ_TIMEOUT_SECONDS=300`;
- `MYSQL_WRITE_TIMEOUT_SECONDS=300`;
- `MYSQL_DDL_TIMEOUT_SECONDS=1800`;
- `MYSQL_QUERY_MAX_ATTEMPTS=4`;
- `MYSQL_QUERY_RETRY_BASE_MS=250`;
- `MYSQL_QUERY_RETRY_MAX_MS=4000`.

Os valores são limites operacionais e devem ser ajustados somente por benchmark.
Uma página continua limitada a 10.000 registros pelo contrato existente.

O índice secundário reservado chama-se `ix_ingestion_cursor`. Ele é necessário
somente em `signal_bucket`, `finding_status_log` e `live_event`; os outros
datasets já possuem `PRIMARY` com o prefixo do cursor. O reader de snapshot usa
o índice comprovado pelo preflight, enquanto live/incremental permanecem sem
hint. DDL cuja resposta se perdeu sempre reconsulta `INFORMATION_SCHEMA` antes
de qualquer nova tentativa.

O sidecar MySQL recebe redo log maior, buffer pool explícito e métricas de
restauração. Desabilitar redo logging não faz parte da configuração padrão; pode
ser avaliado somente em benchmark isolado porque uma interrupção invalida a
instância descartável e obriga a refazer toda a restauração.

### Fase 2 — S3 canônico antes do serving store

O backfill deixa de gravar fatos quentes durante a leitura. A sequência passa a
ser:

```text
RESTORING -> VALIDATING -> EXTRACTING -> ARCHIVING
          -> PROJECTING -> MATERIALIZING_HOT
          -> FINALIZING_CANDIDATE -> PUBLISHING
```

`EXTRACTING` normaliza e escreve o spool limitado em disco. `ARCHIVING` gera
Parquet particionado por dataset/data, publica objetos imutáveis e persiste
manifestos de partição com contagem e SHA-256. Somente partições canônicas
`AVAILABLE` alimentam projeções ou materialização quente.

`FINALIZING_CANDIDATE` reconcilia os artefatos e grava o manifesto candidato;
`PUBLISHING` conclui os efeitos derivados permitidos. Nenhuma dessas etapas
altera `CONTROL#DATASET/ACTIVE`: a ativação continua sendo a ação humana separada
já existente na interface.

Depois que todas as partições esperadas ficam `AVAILABLE`, o worker grava
`canonical/schema_version=1.0/dataset_version=<datasetVersion>/manifest.json`.
Esse commit marker enumera inclusive datasets esperados com zero linhas e, para
cada dataset, schema fingerprint, coverage, contagens de origem/aceitos/rejeitados,
snapshot date e objetos com tamanho/SHA-256. Objetos vivem sob o layout já usado
pelo catálogo:
`.../dataset=<dataset>/<partition>/generation=<aggregateDigest>/part-<ordinal>-<sha>.parquet`.
Glue/Athena apontam apenas para a geração confirmada, de modo que objetos órfãos
de uma tentativa interrompida não entram na consulta. O marker é a única prova
de que o conjunto canônico está completo. Sem ele, uma nova task relê o snapshot
desde o começo e reaproveita uploads idênticos; com ele, a task reconcilia
S3/DynamoDB e pode pular restore, extração e archive.
Checkpoints de página do pipeline legado nunca são usados como prova de
durabilidade no caminho canônico, porque o spool local é efêmero.

Para importações pelo painel, `materialize_hot_records=false`. As APIs públicas
atuais de visão geral e incidentes leem projeções versionadas, portanto os fatos
brutos não pertencem ao caminho crítico. O backfill administrativo mantém
`materialize_hot_records=true` por compatibilidade. A sincronização incremental
continua gravando sua janela quente como hoje.

Quando uma futura tela precisar de fatos brutos, a carga quente será um job
separado, dirigido por allowlist de datasets e retenção. Esse job poderá usar
`BatchWriteItem` com chaves determinísticas, checksum de partição, concorrência
limitada e retry de `UnprocessedItems`. Transações permanecem reservadas ao
control plane: manifestos, fences, checkpoints e troca do ponteiro ativo.

Arquivos Parquet devem ser grandes o suficiente para evitar o problema de
small files. O encoder mantém row groups de 128 MiB quando o volume permitir,
com limite superior de 512 MiB por objeto e ao menos um objeto por partição não
vazia. Partições pequenas não são artificialmente preenchidas.

O spool não pode conservar simultaneamente todo o JSON normalizado e todos os
Parquets. Ao concluir um dataset/partição, o worker codifica em Parquet temporário,
registra a evidência e libera o fragmento normalizado. O orçamento inicial do
workdir é 64 GiB dentro dos 200 GiB efêmeros da task; um preflight mede espaço
livre e falha com `DISK_PRESSURE` antes da extração se não houver a reserva, e as
métricas da task preservam margem para o volume MySQL e arquivos de entrada.

### Fase 3 — workflow durável e feedback operacional

Uma Step Functions Standard passa a ser a proprietária da execução depois de
`UPLOADED`. A primeira versão orquestra três tasks idempotentes:

1. `prepare-archive`: download, promoção, restauração, índices, validação,
   extração e publicação canônica;
2. `build-projections`: leitura das partições canônicas e materialização das
   projeções versionadas;
3. `verify-publish-candidate`: reconciliação final e publicação do candidato.

A primeira task mantém o sidecar MySQL porque seu banco é efêmero e local à
task. A paralelização da leitura ocorre dentro dessa task, com no máximo quatro
datasets/partições simultâneos e sem dois workers escreverem a mesma partição.
As etapas posteriores podem ser tasks Fargate independentes porque consomem S3.

Cada etapa possui um receipt fenced em DynamoDB, identificado por importação,
versão do workflow e etapa. O item registra `executionAttempt`, `stageAttempt`,
lease, fingerprint, estado e referência ao artefato durável produzido. Uma nova
tentativa cria uma nova execução Standard e reaproveita receipts `SUCCEEDED` cujo
fingerprint de entrada seja idêntico; receipt `RUNNING` só pode ser reclamado
depois do lease e com `stageAttempt` maior. Não se depende de `RedriveExecution`
como contrato de produto.

O workflow usa `ecs:runTask.sync` e timeout explícito. O `Retry` nativo cobre
somente falhas de infraestrutura anteriores ao início do container. Depois de
qualquer saída da task, `Catch -> GetReceipt -> Choice`: `FAILED` retryable ou
lease expirado incrementa `stageAttempt`, espera o backoff e relança; receipt
terminal vai para `Fail`, e `SUCCEEDED` segue adiante. Cada worker persiste a
causa segura antes de sair; o reconciliador grava um fallback somente se a task
morrer antes disso. O nome da execução deriva de `importId` e da tentativa,
enquanto uma reserva CAS impede dois workflows concorrentes para a mesma
importação. Antes de criar recursos, a implementação deve confirmar que
Step Functions está disponível no Learner Lab; se a política do laboratório a
bloquear, mantém-se o reconciliador atual como orquestrador e aplicam-se os
mesmos estados duráveis.

## Identidade e idempotência

- `importId` identifica a solicitação do usuário.
- `datasetVersion` continua derivada do checksum do dump e versões de contrato.
- `executionAttempt` é reservado apenas na criação (`1`) ou pelo endpoint de
  retry (`N+1`); o reconciliador nunca o incrementa.
- Cada tentativa usa `processingRunId=run_<importId>-a<executionAttempt>` e client
  token `<importId>-a<executionAttempt>`, evitando reutilizar um run/task terminal
  do modo legado.
- Uma unidade canônica é identificada por
  `(datasetVersion, dataset, partition)`.
- O conteúdo de uma unidade é identificado por `rowCount` e `sha256` do Parquet.
- Um retry pode confirmar uma unidade idêntica; conteúdo diferente para a mesma
  identidade é conflito terminal.
- Checkpoints MySQL identificam a próxima página, mas não substituem o manifesto
  de partição publicado.
- A troca de `ACTIVE` permanece uma operação atômica e separada da importação.

## Estados e retomada

O estado público da importação continua compacto (`UPLOADED`, `VALIDATING`,
`PROCESSING`, `READY`, `FAILED`). O progresso de processamento passa a conter:

- `stage` e `substage`;
- `stageStartedAt`, `heartbeatAt` e `lastProgressAt`;
- `currentDataset` e `currentPartition`;
- `recordsRead`, `recordsWritten`, `recordsRejected` e `recordsTotal`;
- `throughputPerSecond` e `estimatedSecondsRemaining`, ambos anuláveis;
- `attempt`, `maxAttempts` e `retryReason`, quando houver retry;
- `unitsCompleted`, `unitsTotal` e `unitLabel` para etapas sem registros.

`heartbeatAt` prova apenas que o worker está vivo. `lastProgressAt` muda somente
quando registros, bytes ou unidades avançam. A interface considera o progresso
possivelmente estagnado depois de dois minutos sem avanço, mas não declara
falha enquanto o backend não confirmar um estado terminal.

Falhas transitórias terminam em `FAILED` com `retryable=true` e preservam os
artefatos/checkpoints. Um endpoint autenticado de retry cria uma nova tentativa
da mesma importação e do mesmo `datasetVersion`, limpa apenas erro/progresso/ARN
da tentativa anterior e reserva novo `processingRunId`; ele não solicita novo upload.
Falhas de contrato, checksum, schema ou chave conflitante são terminais e não
oferecem retry.

## Taxonomia de erros

Os códigos públicos adicionados são:

- `MYSQL_CONNECTION_LOST` — retryable;
- `MYSQL_QUERY_TIMEOUT` — retryable até esgotar tentativas;
- `DYNAMODB_THROTTLED` — retryable;
- `ARCHIVE_PUBLICATION_FAILED` — retryable;
- `WORKER_TIMEOUT` — retryable;
- `ORCHESTRATION_FAILED` — retryable quando o workflow termina sem estado terminal coerente;
- `DISK_PRESSURE` — retryable somente em nova task com capacidade suficiente;
- `QUERY_PLAN_INVALID` — terminal;
- `SOURCE_SCHEMA_INVALID` — terminal;
- `CHECKSUM_MISMATCH` — terminal;
- `DATA_RECONCILIATION_FAILED` — terminal.

Mensagens públicas são estáveis e traduzíveis. O erro interno durável mantém
etapa, dataset, partição, código MySQL/AWS, tentativa e correlation ID, sem
credenciais nem conteúdo de registros.

## Observabilidade

Métricas mínimas, dimensionadas por ambiente e etapa:

- duração da restauração e bytes restaurados;
- duração e resultado do preflight por dataset;
- páginas e registros por segundo;
- latência de consulta MySQL e contagem de retries;
- duração de encode/upload por partição;
- bytes/linhas Parquet e quantidade de small files;
- latência/itens DynamoDB, `UnprocessedItems` e throttling;
- idade da importação, idade do heartbeat e idade do último progresso;
- duração e resultado de cada task/workflow.

Alarmes devem cobrir task parada, ausência de progresso, armazenamento efêmero
acima de 80%/90%, retry esgotado e importação acima do SLO. Logs estruturados
usam `importId`, `runId`, `datasetVersion`, etapa e unidade; nunca registram
senhas, URLs pré-assinadas ou conteúdo do dump.

## Validação e testes de falha

Além das suítes unitárias e de integração existentes, o aceite usa um fixture
sintético com a mesma distribuição de cardinalidade de `signal_bucket` e escala
progressiva de 100 mil, 1 milhão e 10 milhões de linhas.

Para escolher o page size, as medições limpas exigem zero ausência, duplicação
e retry, além de `lastQuartileP99 <= 1,25 * firstQuartileP99`. Entre candidatos
válidos vence o maior throughput; diferença de até 2% favorece o menor page
size. A injeção MySQL 2013 roda separadamente e não contamina essa comparação.

### Evidência da fase 1

A execução de 21–22 de setembro de 2026 partiu do commit de planejamento
`423016a`; as alterações locais preexistentes foram consolidadas separadamente
em `6a611a9` antes da criação do worktree. Os fixtures determinísticos usados no
worktree e no checkout operacional original foram idênticos:

- 100 mil linhas: 613.952 bytes, SHA-256
  `849ede9f4315f978015e5e8575cf2b28447d25a9e6cc97d520206d05b7869449`;
- 1 milhão de linhas: 6.081.767 bytes, SHA-256
  `74aa4cf28c3547a7d9bbb5a8050a6eecb3dd5d2ba12374120b0dd4aef0a4aa16`.

O benchmark local limpo de 100 mil linhas produziu:

| Page size | Linhas/s | p95 da consulta | p99 da consulta | p99 1º quartil | p99 último quartil | Ausentes/duplicadas/retries |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2.000 | 55.870,401 | 43,756 ms | 46,931 ms | 42,764 ms | 46,931 ms | 0/0/0 |
| 5.000 | 63.482,085 | 89,933 ms | 111,687 ms | 111,687 ms | 108,115 ms | 0/0/0 |
| 10.000 | 71.463,181 | 137,027 ms | 149,573 ms | 149,573 ms | 135,616 ms | 0/0/0 |

O page size escolhido foi 10.000: todos os candidatos passaram os critérios de
integridade e estabilidade, e 10.000 obteve o maior throughput. O ensaio
separado com page size 5.000 e MySQL 2013 injetado retomou exatamente a página
corrente, registrou um retry, 69.614,207 linhas/s, zero ausentes e zero
duplicadas.

No Learner Lab, sempre com profile `default` e região `us-east-1`, o canário de
100 mil linhas (`backfill-62038033cf479f2ecaaf7058f5bf4f521bfae43a`, dataset
`dsv_9b11432411e8c71d3519f60bbe04b7ed1e56ef8c09d3355352fda2e5fa33268d`)
terminou `SUCCEEDED`. Leu e escreveu 100.000 registros, com zero rejeições,
zero erros e zero retries. A ingestão durou 357,310 s (279,869 linhas/s), com
p95/p99 de página em 206,435 ms. As demais etapas duraram: restore 2,688 s,
validação 2,380 s, projeção 79,994 s, archive 6.769,256 s, ativação 0,272 s e
publicação 0,128 s; o total foi 7.212,345 s e gerou 1.064 objetos canônicos. O
ponteiro ativo permaneceu no dataset anterior.

O canário de 1 milhão de linhas
(`backfill-8539fecc32db6f49f18d3c28d73524b39c93ef7c`, dataset
`dsv_0ae09c63065df86dbc272d8f01be67dd74e79cd5a5c83c488db7290fd9606dcb`)
leu e escreveu 1.000.000 de registros, com zero rejeições, zero erros e zero
retries. Restore, validação, ingestão e projeção duraram respectivamente
11,123 s, 17,054 s, 5.708,359 s e 801,474 s. A ingestão sustentou 175,182
linhas/s; em 100 páginas úteis, p95 foi 278,363 ms e p99 286,837 ms. O p99 do
último quartil foi 298,495 ms contra 285,784 ms no primeiro, razão 1,0445, abaixo
do limite 1,25 e sem crescimento contínuo com o cursor.

O fixture de 1 milhão distribui `signal_bucket` em 10.417 dias e, portanto, o
pipeline monolítico da fase 1 tenta validar 10.417 partições via Athena. Depois
de coletada a evidência MySQL, o rollback foi ensaiado enquanto essa task
autônoma continuava na revisão anterior: às `2026-09-22T00:30:17Z`, havia 74 de
10.439 objetos esperados e o candidato continuava inativo. As novas revisões de
backfill/import foram verificadas com `MYSQL_SNAPSHOT_PREPARE_ENABLED=false` e
`PAGE_SIZE=500`; o state preservou a lineage
`7796ee79-2679-710b-7eed-ecf88a8820ee` e chegou ao serial 377. A demora do archive
é evidência adicional para retirar archive/serving store do caminho crítico na
fase 2; ela não invalida o benchmark de leitura da fase 1.

O gate técnico também confirmou por testes que os três índices
`ix_ingestion_cursor` são criados ou reutilizados de forma idempotente, que o
`EXPLAIN FORMAT=JSON` da paginação não usa filesort e que 2006/2013 não avança o
checkpoint antes da reconciliação. Em retomadas, o `EXPLAIN` usa um cursor que
ainda possua linhas posteriores; métricas de página são agregadas na fronteira
do reader e retries são contados separadamente. Para manter updates stateless
previsíveis, mudança automática da AMI do bastion foi excluída do plano: upgrade
de AMI passa a exigir manutenção deliberada.

### Evidência da fase 2

O rollout `phase2-10000` foi aplicado no Learner Lab em 22 de setembro de 2026,
sempre com o profile `default` e a região `us-east-1`. O import público de 100
mil linhas `imp_01M35ANDN1QC2ZE91XYRF47EHR`, associado ao run
`run_import_01M35ANDN1QC2ZE91XYRF47EHR` e à versão canônica
`dsv_eadf1ea2e5f9adbc34bd3664808193ba5b69979d1318525f45e41544d5282a7b`,
leu os 100.000 registros dos 23 datasets, rejeitou zero e chegou a `ARCHIVING`
às `2026-09-22T19:52:16.680Z`. O heartbeat permaneceu vivo e a task ECS ficou
saudável; o encerramento do notebook não interrompeu a execução remota.

O canário revelou o gargalo residual previsto pelo gate alternativo. O fixture
de 100 mil linhas contém 1.042 dias distintos de `signal_bucket` e 1.064
partições no total. Antes do primeiro upload, `_archive_canonical` codifica
serialmente todas as partições apenas para derivar evidência; depois as codifica
novamente e, também serialmente, promove o objeto, registra a partição no Glue e
executa uma consulta Athena por partição. Após mais de 38 minutos em
`ARCHIVING`, havia zero objetos tanto em `staging/canonical/<datasetVersion>/`
quanto no prefixo canônico e nenhuma consulta Athena desse dataset: a task ainda
estava na primeira passagem local. A evidência histórica do fixture de 1 milhão
também mostrou consultas Athena serializadas e confirma que os prazos de 1, 2 e
3 horas dos canários progressivos não são alcançáveis com esse número de
partições. O gargalo, portanto, é a cardinalidade de partições multiplicada por
duas codificações e por operações de control plane/Athena serializadas, não a
leitura MySQL nem uma falha causada pelo notebook.

Como o critério da fase aceita um benchmark que identifique precisamente o
gargalo residual quando o dump completo não conclui em menos de duas horas, os
canários de 1 milhão e do dump completo não foram iniciados: eles apenas
repetiriam o mesmo custo sem alcançar `PROJECTING` dentro do prazo. A task exata
do canário foi encerrada sem publicar candidato; o reconciliador persistiu
`FAILED`, código `WORKER_STOPPED`, `retryable=true`, e removeu o lock ativo. O
ponteiro ativo permaneceu em
`dsv_e6a99d424ed4a8d69e154c9c9c97a8727754cfa38ab127b95cbfcaa828c9c5f5`.

O rollback `phase1-10000` foi então aplicado pelo checkout original que contém
o `terraform.tfstate`. O deployment da API concluiu saudável em
`g05-s3-api-task:14`, com uma task desejada e uma em execução, e
`IMPORT_CANONICAL_FIRST_ENABLED=false`. Nenhum objeto ou manifesto canônico foi
apagado. A fase 2 fica parada no gate final: seus contratos, idempotência e
falhas estão cobertos localmente, mas o pipeline canônico não deve ser
reabilitado no Learner Lab antes de eliminar a publicação/validação serial por
partição. A fase 3 não foi iniciada.

Em continuação controlada, a publicação canônica foi corrigida para codificar e
enviar cada objeto ao staging uma única vez, preservando a pré-validação de
evidências já persistidas antes de qualquer nova escrita. O teste de regressão
observou 46 codificações para 23 objetos antes da correção e uma codificação por
objeto depois dela; a suíte Python não-MySQL ficou em 1.694 testes aprovados,
um ignorado e 14 desselecionados. Em seguida, `phase2-10000` foi novamente
aplicado no checkout original, com o profile `default` em `us-east-1`. A API
está saudável em `g05-s3-api-task:15`, com uma task desejada/em execução,
rollout concluído e `IMPORT_CANONICAL_FIRST_ENABLED=true`; `/health` respondeu
`{"status":"ok"}`. O próximo import público canônico é deliberadamente o E2E
manual do operador, que tem prioridade sobre repetir o canário de benchmark.
A fase 3 permanece não iniciada.

O harness deve injetar:

- MySQL 2013 depois de uma página confirmada;
- interrupção da task durante extração, archive e projeção;
- `UnprocessedItems` e throttling DynamoDB;
- tentativa duplicada do mesmo workflow;
- checksum divergente para uma partição já publicada;
- disco acima de 80% e acima do limite fatal;
- heartbeat vivo sem avanço de trabalho.

O aceite exige ausência de duplicação/perda, retomada da última unidade
confirmada, candidato não ativado em falha, `lastProgressAt` correto e mensagem
de recuperação coerente no frontend.

## Implantação e rollback

Cada fase possui feature flag independente:

- `MYSQL_SNAPSHOT_PREPARE_ENABLED` para índices/preflight;
- `IMPORT_CANONICAL_FIRST_ENABLED` para a nova ordem;
- `IMPORT_HOT_MATERIALIZATION_ENABLED` para fatos quentes do import;
- `IMPORT_STEP_FUNCTIONS_ENABLED` para o novo orquestrador.

Além das flags, cada importação persiste `pipelineVersion` e
`orchestrationMode` antes de iniciar o worker. Alterar uma flag afeta somente
novas importações; uma execução em voo nunca troca de pipeline ou orquestrador.

As flags começam desabilitadas fora do Learner Lab. A implantação no laboratório
usa canário reduzido, depois 1 milhão de linhas e somente então o dump completo.
Rollback desabilita a flag da fase sem apagar arquivos canônicos nem candidatos.

Todos os comandos AWS usam exclusivamente `--profile default` e região
`us-east-1`. A execução deve validar o caller identity do Learner Lab antes de
qualquer mutação e nunca pode usar o profile `nora`.

Implementação e testes ocorrem em worktree isolado, mas o state local do Learner
Lab não é copiado nem compartilhado: ele permanece em
`/home/messias/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate`.
Antes de qualquer update, os commits são integrados nesse checkout original
limpo. O wrapper rejeita state ausente/symlink, valida lineage/serial, confirma
que `ingestion_runbook.imports.expected_bucket_owner` é a conta STS, cria backup
`0600`, aplica exatamente o plan allowlisted e revalida state e outputs.

## Fora de escopo

- Migrar o snapshot temporário para RDS.
- Usar DMS, Glue ou EMR para o volume atual.
- Alterar imediatamente o produtor para MySQL Shell `util.dumpInstance`.
- Importar o histórico na tabela operacional por DynamoDB Import from S3, que
  exigiria criar e promover uma tabela nova.
- Materializar detalhes de incidente/eventos que as APIs atuais ainda declaram
  indisponíveis.
- Alterar o contrato da sincronização incremental.
