# Ingestão de dados ARGUS 2.0

## Visão geral

Este componente é um worker batch Python finito: executa uma operação, registra
seu resultado e termina. Não há servidor HTTP nem Flask aqui. A API do dashboard
continua sendo a interface pública; o worker é acionado pela CLI ou por uma task
Kubernetes/EKS.

## Como o fluxo funciona

Um snapshot imutável é enviado ao S3 e restaurado em um MySQL efêmero. O worker
valida o contrato ARGUS 2.0, normaliza os dados e publica os dados quentes/de
controle no DynamoDB. Também grava o arquivo Parquet no arquivo histórico e
reconcilia o resultado com Glue/Athena. No fluxo operacional legado, uma
candidata pode ser ativada somente por uma operação posterior e explícita;
o fluxo de importação web sempre termina sem ativação. Eventos de outbox seguem
para SQS para alimentar os consumidores de análise. Depois da ativação, um
caminho opcional exporta janelas fechadas para lotes raw versionados no S3 e as
adiciona ao mesmo dataset ativo. Ele não substitui nem altera o fluxo inicial
`.sql.gz`/ZIP → `import-dump` → `backfill` → candidata → ativação.

## Estrutura de pastas

```text
domain/       immutable domain rules, identities, quality and run state
application/  use cases and orchestration
ports/        interfaces between application and infrastructure
adapters/     MySQL, DynamoDB, S3, Glue, Athena, SQS and telemetry
bootstrap/    configuration, dependency assembly and CLI
contracts/    executable ARGUS 2.0 allowlist and normalizers
scripts/      safe operator entry points for snapshot and Kubernetes execution
tests/        unit, contract, resilience, integration, CI and AWS checks
```

## Como navegar pelo código

Comece pelos módulos de `bootstrap/`: `cli.py` transforma argumentos em um
comando, `config.py` valida a configuração de ambiente e `container.py` monta
somente as dependências necessárias ao comando escolhido. A partir daí, a
execução segue para um caso de uso em `application/`.

Cada camada tem uma responsabilidade deliberadamente limitada:

- `domain/` contém valores imutáveis, regras determinísticas e máquinas de
  estado. Ela não acessa AWS, MySQL, arquivos nem variáveis de ambiente.
- `contracts/` carrega e valida o contrato versionado do ARGUS; os
  normalizadores convertem as tabelas legadas para os registros canônicos.
- `ports/` define os contratos tipados usados pelos casos de uso. Um caso de
  uso depende de uma porta, nunca de boto3, PyMySQL ou PyArrow diretamente.
- `application/` coordena o fluxo: validação, backfill, sincronização,
  reprocessamento, projeções, arquivamento e publicação da outbox.
- `adapters/` implementa as portas em integrações concretas (DynamoDB, S3,
  Glue, Athena, SQS, MySQL e telemetria). Suas validações defensivas impedem
  que respostas externas malformadas atravessem a fronteira.
- `scripts/` são entradas operacionais independentes para preparar snapshots
  ou iniciar a Job Kubernetes; não devem concentrar regra de negócio do worker.

As docstrings dos módulos explicam a responsabilidade e os limites de cada
arquivo. Nas APIs públicas, as docstrings indicam o que é produzido ou
validado, quais invariantes devem permanecer verdadeiros e em que situações
ocorrem falhas. Comentários de linha são reservados para decisões que não são
evidentes pela própria implementação, como idempotência, ordenação ou limites
de recursos.

## Preparação local

Para desenvolvimento local, requer Python 3.12. Docker Compose, AWS CLI,
Terraform e Node.js são necessários para os testes integrados e o
provisionamento no Learner Lab. A partir da raiz do repositório:

```bash
cd apps/backend/ingestion-data
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
python -m bootstrap --help
```

Os comandos Python desta seção pressupõem que `.venv` continua ativado. A CLI do
Learner Lab detecta ou cria esse ambiente automaticamente. Credenciais e
segredos devem vir do ambiente ou da cadeia padrão da AWS; nunca os coloque em
argumentos, logs ou arquivos versionados.

## Benchmark reproduzível da leitura MySQL

O builder de benchmark reutiliza o schema e a fixture oficiais, mantém linhas
nas 23 tabelas e completa a quantidade solicitada com buckets determinísticos
em `signal_bucket`. Ele grava o gzip em streaming, com blocos de no máximo
1.000 linhas, `mtime=0` e nome interno vazio. Dumps, manifests e resultados
devem ficar sob `/.artifacts/`, que não é versionado. Cada tamanho usa um
diretório próprio e o dump conserva o nome lógico `argus_dump.sql.gz`:

```bash
mkdir -p ../../../.artifacts/argus-benchmarks/100k
.venv/bin/python scripts/build_benchmark_snapshot.py \
  --rows 100000 \
  --snapshot-extracted-on 2026-09-01 \
  --variant baseline \
  --output ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz \
  --manifest ../../../.artifacts/argus-benchmarks/100k/manifest.json
```

Com o MySQL de teste ativo, o leitor restaura sempre uma base vazia, executa o
preflight de produção nas 23 tabelas (criando os três índices cujos cursores
divergem da chave natural) e percorre todas elas com o reader e retry reais. A
falha opcional existe somente no harness:

```bash
docker compose -f docker-compose.test.yml up -d --wait mysql
.venv/bin/python scripts/benchmark_snapshot_reader.py \
  --snapshot ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz \
  --rows 100000 \
  --page-size 5000 \
  --output-json ../../../.artifacts/argus-benchmarks/local-100k-p5000-clean.json
.venv/bin/python scripts/benchmark_snapshot_reader.py \
  --snapshot ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz \
  --rows 100000 \
  --page-size 5000 \
  --disconnect-after-page 10 \
  --output-json ../../../.artifacts/argus-benchmarks/local-100k-p5000-retry.json
docker compose -f docker-compose.test.yml down --volumes
```

Compare 2.000, 5.000 e 10.000 em restaurações limpas. Um run é elegível quando
tem zero ausências, duplicações e retries e o p99 do último quartil não supera
1,25 vez o primeiro. Escolha o maior throughput; diferenças de até 2% são
empate e favorecem a menor página. O run separado de desconexão deve terminar
com exatamente um retry e zero ausências ou duplicações.

`queryP50Ms`, `queryP95Ms` e `queryP99Ms` resumem todas as consultas das 23
tabelas. Para medir degradação ao avançar o cursor sem contaminação pelas
tabelas pequenas, `firstQuartileP99Ms` e `lastQuartileP99Ms` usam somente as
páginas de `signal_bucket`, o dataset dominante do fixture. Cada quartil contém
`ceil(páginas de signal_bucket / 4)` páginas; se houver apenas uma página, ela
representa ambos os quartis.

O relatório também separa `restoreDurationSeconds`,
`preflightDurationSeconds`, `durationSeconds` (somente consultas) e
`queryPages`. Para diagnosticar o pipeline canonical-first completo, forneça
observações medidas, nunca estimativas, com `--pipeline-observations-json`:

```json
{
  "provenance": {
    "snapshotSha256": "<sha256-do-argus_dump.sql.gz>",
    "importId": "imp_<ulid>",
    "label": "phase2-10000",
    "runId": "run_import_<mesmo-ulid>",
    "datasetVersion": "dsv_<sha256>",
    "canaryCompletedAt": "2026-09-22T12:34:56.789Z"
  },
  "smallFileBytes": 33554432,
  "observations": [
    {
      "component": "encode",
      "durationMs": 81.4,
      "parquetRows": 10000,
      "parquetBytes": 4194304
    },
    { "component": "upload", "durationMs": 125.2 },
    { "component": "athena", "durationMs": 732.9 },
    { "component": "projection", "durationMs": 44.1 }
  ]
}
```

Passe também `--canary-evidence-json` apontando para a evidência `0600` do
`import-canary`. As duas opções são inseparáveis: antes de restaurar o MySQL, o
benchmark calcula o SHA-256 do snapshot e exige igualdade exata de
`snapshotSha256`, `importId`, `label`, `runId`, `datasetVersion` e horário de
conclusão com o canário atual. Proveniência ausente, antiga, divergente ou com
campos extras falha fechado.

O arquivo exige pelo menos uma amostra de `encode`, `upload`, `athena` e
`projection`; ausência ou campo desconhecido falha fechado. O resultado inclui
p50/p95/p99 de cada componente, o gargalo por p95, quantidade/bytes/linhas de
Parquet e quantidade de arquivos abaixo do limite configurado. Assim, uma
falha do SLO pode ser localizada sem aumentar concorrência por tentativa e
erro. Use somente medições sanitizadas: não inclua URL assinada, chave física,
credencial, cookie ou conteúdo de registro.

O runtime de implantação usa Kubernetes. Backfill manual, importação pelo painel e coleta de evidência dos Jobs estão no [runbook Kubernetes](../../kubernetes/README.md). O benchmark local e os contratos de proveniência acima continuam disponíveis; os comandos antigos `seed` e `import-canary` do launcher ECS foram retirados.

## Comandos disponíveis

| Comando               | Uso                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `validate`            | Valida o snapshot e os contratos; use `--no-write` para uma checagem sem escrita.        |
| `backfill`            | Executa a carga histórica identificada por `--run-id`.                                   |
| `import-dump`         | Processa a importação web durável identificada por `--import-id`; nunca aceita ativação. |
| `sync`                | Sincroniza a origem live quando o controle autenticado da plataforma estiver ligado.     |
| `reprocess`           | Reprocessa um dataset quando o controle autenticado da plataforma estiver ligado.        |
| `rebuild-projections` | Reconstrói projeções, opcionalmente por versão, partição ou arquivo.                     |
| `publish-outbox`      | Publica eventos pendentes; `--limit` restringe o lote.                                   |
| `export-incremental`  | Exporta a próxima janela fechada do MySQL live para S3 e publica sua referência FIFO.    |
| `ingest-incremental`  | Consome lotes raw da FIFO; `--limit` limita as entregas processadas.                      |

## Controle da sincronização live

O estado live do ARGUS fica em `CONTROL#ARGUS`/`LIVE_SYNC` na tabela
operacional; esse é o controle autoritativo. Item ausente equivale a
desligado. O botão em **Configurações** controla sync e reprocess para qualquer
usuário autenticado, por meio do endpoint autenticado
`PATCH /api/v1/integrations/argus` da plataforma.

Antes de invocar `sync` ou `reprocess`, entre na plataforma com uma sessão
autenticada e habilite a integração em **Configurações** (ou use o endpoint
autenticado). Desligar bloqueia novas leituras e pausa novos disparos, mas não
cancela uma task já iniciada. As credenciais continuam no Secrets Manager; não
as forneça em variáveis de controle, argumentos, logs ou arquivos versionados.

Defina os valores de exemplo antes de usar os comandos que os referenciam:

```bash
DATASET="<dataset>"
START="<inicio>"
END="<fim>"
DATASET_VERSION="<versao>"
PARTITION_DATE="<YYYYMMDD>"
ARCHIVE_PARTITION="year=<YYYY>/month=<MM>/day=<DD>"
RUN_ID="<run_id>"
IMPORT_ID="<imp_ULID>"
ACTIVATION_LAUNCH_ATTEMPT="<activation-attempt-id>"
```

Exemplos de invocação:

```bash
python -m bootstrap validate --no-write
python -m bootstrap backfill --run-id "${RUN_ID}"
python -m bootstrap import-dump --import-id "${IMPORT_ID}"
python -m bootstrap sync
python -m bootstrap reprocess --dataset "${DATASET}" --start "${START}" --end "${END}"
python -m bootstrap rebuild-projections \
  --dataset-version "${DATASET_VERSION}" \
  --partition-key "DATASET#${DATASET_VERSION}#FACT#TS#${DATASET}#${PARTITION_DATE}" \
  --archive-partition "${DATASET}=${ARCHIVE_PARTITION}"
python -m bootstrap publish-outbox --limit 100
python -m bootstrap export-incremental
python -m bootstrap ingest-incremental --limit 20
```

Os códigos de saída são `0` (sucesso), `1` (falha operacional ou resultado
terminal `PARTIAL`), `2` (falha de configuração/argumentos) e `130`
(interrupção). Com a integração desligada, `sync` e `reprocess` retornam
`SKIPPED_DISABLED` antes de abrir a origem live. O CronJob nasce suspenso;
habilite a integração pelo controle autenticado da plataforma somente após uma
mudança operacional revisada e evidência de conectividade.

## Incrementos S3 opcionais

Esse caminho tem duas tasks e duas agendas independentes. A exportação roda a
cada 15 minutos e executa exatamente `export-incremental`; a ingestão roda a
cada 5 minutos e executa `ingest-incremental --limit 20`. As duas agendas nascem
`DISABLED` e só passam a `ENABLED` quando `incremental_s3_enabled=true` e o gate
`live_sync_enabled=true`. A exportação recebe o segredo MySQL live; a ingestão
não recebe credenciais MySQL.

O exportador parte do watermark do manifesto `ACTIVE`, aceita somente janelas
de 15 minutos completamente fechadas de `signal_bucket` e usa `revision=0`.
Ele grava primeiro `data.parquet` e depois `manifest.json` sob este layout:

```text
raw/argus/incremental/dataset=<dataset>/
  window_start=<YYYYMMDDTHHMMSSmmmZ>/batch_id=<bat_sha256>/data.parquet
raw/argus/incremental/dataset=<dataset>/
  window_start=<YYYYMMDDTHHMMSSmmmZ>/batch_id=<bat_sha256>/manifest.json
```

O manifesto é o marcador de commit e fixa `batchId`, janela, origem, revisão,
contagem, schema físico, colunas extras, checksum/tamanho do Parquet e os
`VersionId` S3. A referência FIFO também fixa o `VersionId`; nunca edite nem
republique os objetos existentes. Colunas extras permanecem no raw e são
ignoradas na projeção canônica. Coluna obrigatória ausente ou tipo/nulabilidade
incompatível coloca o lote em `QUARANTINED`. O MVP não interpreta deletes e os
incrementos apenas adicionam fatos ao `datasetVersion` ativo; um lote duplicado
não cria fatos nem eventos lógicos duplicados.

### Variáveis de runtime

As duas tasks exigem `AWS_REGION`, `OPERATIONAL_TABLE_NAME`,
`INCREMENTAL_BATCH_BUCKET`, `INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER` e
`INCREMENTAL_BATCH_QUEUE_URL`. `INCREMENTAL_BATCH_PREFIX` é fixo em
`raw/argus/incremental/` e divergências falham na configuração.

`export-incremental` exige ainda `ARGUS_SOURCE_MODE=live`,
`LIVE_SYNC_ENABLED=true` e `LIVE_MYSQL_HOST`, `LIVE_MYSQL_PORT`,
`LIVE_MYSQL_USER`, `LIVE_MYSQL_PASSWORD` e `LIVE_MYSQL_DATABASE`. Somente a
task exportadora recebe esses cinco campos do Secrets Manager.

`ingest-incremental` exige `ANALYSIS_QUEUE_URL`; `INCREMENTAL_INGEST_LIMIT`
tem default 100, enquanto a task gerenciada usa 20 e divide cada leitura SQS em
chamadas de no máximo 10 mensagens. O consumidor usa a tabela operacional, o
S3 raw, a FIFO incremental e a fila de análise, sem montar uma conexão MySQL.

### Evidência e recuperação

Antes de habilitar, obtenha os nomes/ARNs com
`terraform -chdir=apps/fullstack output -json ingestion_runbook` e confirme que
`incremental.enabled` e as duas agendas continuam falsas/desligadas. Em uma
prova controlada, correlacione os log groups separados de export e ingest e
verifique, sem copiar payloads ou segredos:

```bash
aws s3api head-object \
  --bucket "${INCREMENTAL_BATCH_BUCKET}" \
  --key "${MANIFEST_KEY}" \
  --version-id "${MANIFEST_VERSION_ID}"
aws sqs get-queue-attributes \
  --queue-url "${INCREMENTAL_BATCH_QUEUE_URL}" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible RedrivePolicy
```

Confronte janela, `batchId`, checksum, `VersionId`, contagem e schema do
manifesto com o log estruturado e o estado durável do batch. Monitore backlog,
idade da FIFO, lag do watermark, quarentena e DLQ. A fila e a DLQ retêm mensagens
por 14 dias; o raw S3 tem retenção padrão de 90 dias.

Falha transitória vira `RETRYABLE_FAILED`: a mensagem não é confirmada, volta
após o visibility timeout e, depois de cinco recebimentos, segue para a DLQ.
`QUARANTINED` é uma decisão permanente e confirma a mensagem; corrija contrato
ou origem antes de produzir uma nova revisão suportada. Para uma mensagem na
DLQ, preserve o corpo e a referência de versão, investigue primeiro o S3, o
manifesto ativo, IAM e schema e só então inicie um redrive para a FIFO. Nunca
recrie uma mensagem manualmente nem altere o raw para “consertar” a evidência.

## Importação web assíncrona

O comando operacional executado pela Job Kubernetes é:

```bash
python -m bootstrap import-dump --import-id <imp_ULID>
```

Ele recebe somente um `importId` validado. Bucket, chave, versão física,
tamanho, nome do arquivo e `snapshotExtractedOn` são relidos do registro
durável; não existem flags para fornecer esses valores ou para ativar um
dataset. `snapshotExtractedOn` é a data civil de origem do dump, não a data em
que o browser iniciou o envio.

Qualquer pessoa autenticada pode criar uma importação e ler o histórico
compartilhado, mas somente o autor gerencia o upload. Há uma única importação
não terminal global. O browser envia partes de 16 MiB, exceto a final, e a API
assina no máximo 20 por chamada. Fechar ou recarregar o browser interrompe os
bytes locais; durante a expiração de 24 horas, a retomada exige selecionar de
novo o mesmo arquivo e validar os checksums das partes. O backend continua
independentemente do browser somente depois de `UPLOADED`.

### Formato e limites

O worker aceita exatamente `argus_dump.sql.gz` ou um `.zip` de até 10 GiB com
um único membro regular, não criptografado, na raiz e chamado
`argus_dump.sql.gz`. O GZIP direto e o GZIP interno ficam limitados a 5 GiB; a
expansão do ZIP fica limitada a 100:1; o SQL descompactado fica limitado a
100 GiB. O arquivo é validado incrementalmente e o SHA-256 integral é
calculado pelo worker, sem confiar em uma declaração do navegador.

O limite de 100 GiB é uma guarda de validação, não uma garantia de que haja
capacidade física, tempo ou memória suficientes para qualquer dump desse
tamanho. A task dedicada de importação está configurada no Terraform com 200 GiB de
storage efêmero, enquanto `INGESTION_DISK_BUDGET_BYTES` limita os artefatos
pertencentes à ingestão a no máximo 16 GiB. Antes da promoção, o worker ainda
confere o espaço livre para o arquivo de entrada e o GZIP normalizado.

O download de staging é gravado sob `ARCHIVE_WORKDIR` em arquivo regular modo
`0600`. Depois da validação e promoção imutável, o ZIP/GZIP local é apagado
antes do backfill para liberar o budget; a limpeza também ocorre em falhas.

### Configuração do runtime

`import-dump` exige `OPERATIONAL_TABLE_NAME`, `ARCHIVE_BUCKET`,
`ARCHIVE_BUCKET_OWNER`, `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`,
`MYSQL_DATABASE`, `GLUE_DATABASE`, `ATHENA_WORKGROUP`,
`ATHENA_OUTPUT_LOCATION` e `ANALYSIS_QUEUE_URL`. `AWS_REGION`,
`ARCHIVE_WORKDIR` (padrão `/tmp/ingestion`) e
`INGESTION_DISK_BUDGET_BYTES` completam a configuração operacional. As
variáveis `SNAPSHOT_*` não são entradas desse comando: são derivadas do objeto
validado antes de montar o backfill. Mesmo que o ambiente contenha
`ACTIVATE_CANDIDATE=true`, o handler substitui o valor por `false`.

Para alimentar o worker de análise, `ANALYSIS_FACT_CATALOG_LOCATION` (opcional)
aponta para o catálogo de séries do worker, em `s3://bucket/chave` ou caminho
absoluto. Quando definida, `import-dump`, `backfill` e `rebuild-projections`
gravam na tabela operacional os fatos `DATASET#<versão>#FACT#TS#<seriesId>#<dia>`
das séries do catálogo, sempre a partir do arquivo confirmado e de forma
idempotente. `sync` e `ingest-incremental` ainda não gravam esses fatos.
`ANALYSIS_FORECAST_MODEL_NAME` e `ANALYSIS_FORECAST_MODEL_VERSION`, sempre em
par, definem o modelo declarado nos eventos `QOE_FORECAST` e precisam coincidir
com o bundle aprovado do worker; sem elas vale `qoe-random-forest` e
`2026.09.1`. Valor vazio equivale a variável ausente: o Terraform declara
essas variáveis mesmo com o worker desligado (`analysis_fact_catalog_location`
vazio desliga a gravação), e a ingestão não deve falhar na partida por isso;
valores só com espaços continuam sendo recusados. A regra de identidade e o formato do item estão em
`domain/analysis_facts.py`, e `tests/contracts/test_worker_contract.py` congela o
que a ingestão grava e publica nos arquivos lidos pelo teste do worker.

### Estados, progresso e falhas

O registro compartilhado percorre `PREPARING`, `UPLOADING`, `UPLOADED`,
`VALIDATING`, `PROCESSING` e termina em `READY` ou `FAILED`. Upload expõe bytes
confirmados/total; processamento expõe a etapa real e os contadores acumulados
`recordsRead`, `recordsWritten` e `recordsRejected`, sem inventar percentual.
A etapa interna `ACTIVATING` é apresentada como `PUBLISHING`, pois o caminho web
nunca ativa o candidato.

`PREPARING` preso expira após 5 minutos e `UPLOADING` após 24 horas. A API
executa o reconciliador imediatamente ao iniciar e depois a cada 60 segundos;
não há comando de reconciliador neste pacote. Ele dispara
`import-dump --import-id <id>` e encerra jobs interrompidos de modo seguro.

Sucesso persiste a `candidateVersion` e termina em `READY`, mas jamais escreve
ou altera `CONTROL#DATASET/ACTIVE`. O manifesto candidato usa a partition key
isolada `CANDIDATE#DATASET#<datasetVersion>` com sort key `MANIFEST`; em
production isso permite que a task role exclusiva de `import-dump` publique o
candidato sem receber permissão IAM de ativação. No Learner Lab todas as tasks
continuam usando `LabRole`, logo essa separação IAM não é garantida nesse
perfil. Falhas de validação/backfill terminam em
`FAILED` com mensagem segura. Para troubleshooting, correlacione pelo
`importId` e `requestId`; não copie para logs ou tickets URL pré-assinada,
upload ID, credencial, chave de staging nem conteúdo do dump.

## Validação local

Com o ambiente virtual ativado, valide primeiro o pacote e a suíte rápida:

```bash
python -m pip check
python -m ruff check .
python -m ruff format --check .
python -m mypy domain application ports adapters bootstrap contracts
python -m pytest tests/unit tests/contracts tests/resilience tests/ci --cov=. --cov-fail-under=70
```

Para a integração MySQL, use Docker Compose e sempre execute o cleanup, mesmo
que o teste termine com falha:

```bash
docker compose -f docker-compose.test.yml config --quiet
docker compose -f docker-compose.test.yml up -d --wait mysql
python -m pytest tests/integration -m 'integration or mysql' -q
docker compose -f docker-compose.test.yml down --volumes
```

O smoke incremental local usa esse MySQL compatível e adapters S3/SQS em memória
ou simulados; ele não acessa o ARGUS real nem uma conta AWS:

```bash
docker compose -f docker-compose.test.yml up -d --wait mysql
python -m pytest tests/integration/test_incremental_mysql_parquet.py -m mysql -q
python -m pytest \
  tests/unit/adapters/test_incremental_s3.py \
  tests/unit/adapters/test_incremental_sqs.py \
  tests/integration/test_incremental_cli.py \
  tests/resilience/test_incremental_export_resume.py \
  tests/resilience/test_incremental_ingest_resume.py -q
docker compose -f docker-compose.test.yml down --volumes
```

Para validar apenas a interface da CLI:

```bash
python -m bootstrap --help
```

## Provisionamento e backfill em Kubernetes

Siga o [runbook Kubernetes](../../kubernetes/README.md). O upload seguro permanece em `scripts/upload_snapshot.py`; o novo `apps/kubernetes/run-job.mjs` valida a evidência do objeto S3, cria um Job com senha própria e preserva `ACTIVATE_CANDIDATE=false`. Importação web é lançada pela API e acompanhada pelo reconciliador, com Job e UID persistidos no campo histórico `taskArn`.

## Limitações atuais

O worker é batch e não oferece endpoint próprio. O snapshot reduzido é adequado
para smoke e validação de caminho; não representa capacidade, volume, custo ou
tempo de uma carga completa. Os testes incrementais comprovam apenas uma fonte
MySQL compatível e S3/SQS simulados; a rede, as credenciais, o schema observado e
a capacidade do ARGUS real ainda exigem homologação externa. A arquitetura
mantém todos os CronJobs live/incrementais suspensos por padrão e exige opt-in
explícito.

## Referências

- [Arquitetura de ingestão e dados](../../../artefatos/arquitetura/ingestao-e-dados.md)
- [Status da implementação](../../../artefatos/arquitetura/status-implementacao.md)
- [README da infraestrutura fullstack](../../fullstack/README.md)
