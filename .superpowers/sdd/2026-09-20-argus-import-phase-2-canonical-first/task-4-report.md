# Tarefa 4 — publicação canônica antes de servir dados

## Status

Implementada com TDD. O fluxo `canonical-v2` agora extrai somente para o spool local, publica
objetos Parquet determinísticos e reconcilia todas as partições como `AVAILABLE` antes de gravar
o commit marker. Somente um marker válido, reconciliado contra DynamoDB e `HEAD` de cada objeto,
autoriza pular restore, extração e publicação em uma repetição. O caminho `legacy-v1` e seus
testes foram preservados.

## Implementação

- `application/backfill.py` separa os caminhos `_extract_to_spool` e
  `_write_hot_from_batches`. A extração v2 não recebe nem usa `HotRecordSink` ou
  `CheckpointRepository`, mantém `recordsWritten=0` e ignora checkpoints legados.
- `_archive_canonical` divide por bytes estimados, faz split adaptativo quando o tamanho Parquet
  observado ultrapassa 512 MiB, envia cada objeto para staging determinístico, confirma com
  `HEAD`, remove o Parquet local e só então conserva a evidência leve necessária para calcular
  `aggregateDigest`.
- Objetos finais usam `generation=<aggregateDigest>` e promoção server-side. Cada partição só
  chega a `AVAILABLE` após promoção, `HEAD`, registro Glue, contagem Athena e reconciliação. O
  marker é escrito somente depois que todas as partições terminaram esse ciclo.
- `ArchiveBuildResult` devolve `CanonicalSet`, objetos novos e contagens escritas/inalteradas.
  O replay de partição já `AVAILABLE` usa apenas `HEAD`, sem novo upload, Glue ou Athena.
- O workspace canônico inclui `runId`; uma falha anterior ao marker inicia outra extração em um
  workspace pertencente à nova execução. Após marker, a origem é pulada somente depois de
  reconciliar cobertura, estado, digest, contagens, objetos e `HEAD`, sem listar S3.
- `domain/archive.py` valida metadata v1 e v2 separadamente. Em v2 a identidade imutável contém
  a lista ordenada de objetos e o digest agregado, exige `hotItemCount=0` e não contém
  `projectionItemCount`. O helper de staging v2 é determinístico e independente do run.
- O encoder Parquet mira row groups de 128 MiB por bytes serializados. O adaptador S3 aceita o
  layout staging v2, rejeita objetos acima de 512 MiB e diferencia divergência física de
  checksum de indisponibilidade de armazenamento.
- A reconciliação DynamoDB v2 usa o digest agregado e não consulta catálogos de hot facts,
  projeções ou retention seals. O comportamento v1 permanece inalterado.
- O `CanonicalSetStore` real/fake diferencia conflito lógico de corrupção de checksum. O
  container injeta o store no `Backfill` real.
- Falhas agora atravessam wrappers por tipo, com os códigos públicos seguros e retryability
  exigidos: `ARCHIVE_PUBLICATION_FAILED`, `DYNAMODB_THROTTLED`, `DISK_PRESSURE`,
  `CHECKSUM_MISMATCH`, `SOURCE_SCHEMA_INVALID` e `DATA_RECONCILIATION_FAILED`. As allowlists e
  mensagens coincidem em Python, fixture compartilhada, contrato/OpenAPI, API e frontend.
- A guarda defensiva após restore também lança `SnapshotChecksumMismatch` caso um adaptador
  inválido devolva SHA divergente sem lançar por conta própria.

As portas `CanonicalSetStore`, os parâmetros de geração em Glue/Athena e os modelos físicos v2
já haviam sido entregues pelas Tarefas 1–3; esta tarefa os consumiu no fluxo real sem duplicar ou
alterar essas APIs. Os testes de resiliência legados foram executados sem precisar ser reescritos.

## RED registrado

O gate Python exato antes das mudanças estava verde com `374 passed`. Cada comportamento novo
foi introduzido primeiro por teste e observado em falha:

1. Os primeiros testes canônicos falharam durante coleta pela ausência de
   `canonical_staging_archive_key`; após o helper mínimo, falharam pela ausência de
   `publish_canonical` e do caminho v2 no Backfill.
2. O teste do staging real S3 falhou porque a validação aceitava apenas a regex v1.
3. Os testes de contrato/API ficaram RED com 9 falhas pelos seis códigos ausentes; os testes do
   frontend ficaram RED com 7 falhas pelas allowlists e mensagens ainda incompletas.
4. Os testes de falhas tipadas ficaram RED pela ausência de `ArchiveChecksumMismatch` e das
   classificações por causa encadeada.
5. Split adaptativo acima de 512 MiB e validação de checksum físico produziram 2 falhas antes
   das guardas de tamanho/`HEAD`; depois passaram isoladamente.
6. Workspace por run e reconciliação de `catalogDigest` produziram 2 falhas em 3 testes antes
   de incluir `runId` e comparar o digest catalogado ao marker; depois os 3 passaram.
7. A cobertura do marker corrompido inicialmente falhou na coleta pela classe de checksum ainda
   ausente; após a separação conflito/checksum, os 53 testes pertinentes ficaram verdes.
8. A partição lógica vazia reproduziu um `IndexError` depois de persistir estado. A guarda foi
   movida para antes do primeiro efeito; o teste isolado passou com `1 passed`.
9. Um restorer deliberadamente fora do contrato reproduziu a causa genérica:

   ```text
   test_backfill_defensively_types_an_unchecked_restore_checksum_divergence
   1 failed: __cause__ era BackfillValidationError, não SnapshotChecksumMismatch
   ```

   Depois da correção, os dois cenários de checksum de restore passaram: `2 passed`.

## GREEN e gates finais

Gate Python exato do brief, após o último RED/GREEN:

```text
.venv/bin/python -m pytest tests/unit/application/test_archive_partition.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py tests/unit/adapters/test_parquet.py tests/unit/adapters/test_archive_aws.py tests/resilience/test_archive_ttl_guard.py tests/resilience/test_idempotent_backfill.py -q
409 passed in 16.29s
```

Cobertura adicional de domínio/store/bootstrap canônico:

```text
.venv/bin/python -m pytest tests/unit/adapters/test_s3_canonical_sets.py tests/unit/domain/test_canonical_set.py tests/unit/bootstrap/test_cli.py tests/unit/bootstrap/test_config.py tests/unit/bootstrap/test_reprocess_runtime_contract.py -q
134 passed in 1.50s
```

Regressão Python ampla, sem infraestrutura real:

```text
.venv/bin/python -m pytest tests/unit tests/resilience tests/contracts -m 'not mysql' -q
1465 passed, 1 deselected in 26.22s
```

O mesmo comando sem exclusão chegou a `1464 passed` e uma única falha ambiental: o teste
marcado `mysql` informou `service "mysql" is not running`. `docker compose ... ps mysql`
confirmou que não havia serviço ativo. Nenhum código do benchmark/MySQL foi alterado e nenhum
serviço foi iniciado para contornar o ambiente.

API/contratos, comandos exatos do brief:

```text
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts tests/import-domain.test.ts
3 files passed; 90 tests passed
```

Frontend, comando exato do brief:

```text
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts
2 files passed; 23 tests passed
```

Checks estáticos e de formato:

- Ruff nos 20 arquivos Python alterados: `All checks passed`; `20 files already formatted`.
- Mypy configurado: `Success: no issues found in 5 source files`.
- Mypy `--strict` nos 11 módulos Python de produção alterados: `Success: no issues found in 11
  source files`.
- API `npm run lint` e `npm run typecheck`: exit 0.
- Prettier nos 6 arquivos API alterados: todos conformes.
- Frontend `npm run lint` e `npm run typecheck`: exit 0.
- Prettier nos 4 arquivos frontend alterados: todos conformes.
- `git diff --check`: exit 0.

O `ruff format --check .` global continua apontando 26 arquivos preexistentes fora deste diff. O
`npm run format:check` global da API continua apontando exatamente dois arquivos não alterados:
`src/modules/imports/ports/import-repository.ts` e `tests/import-reconciler.test.ts`. Os recortes
alterados passaram integralmente.

## Arquivos alterados

- Orquestração/domínio: `application/archive_partition.py`, `application/backfill.py`,
  `application/import_dump.py`, `domain/archive.py`, `domain/import_job.py`.
- Infraestrutura: `adapters/archive/parquet.py`, `adapters/archive/s3.py`,
  `adapters/archive/s3_canonical_sets.py`, `adapters/dynamodb/archive_partitions.py`,
  `adapters/dynamodb/import_jobs.py`, `bootstrap/container.py`.
- Python testes/fakes/fixture: `tests/fakes.py`, os testes unitários de publisher, Backfill,
  Parquet, S3, marker, import job e classificação, além de
  `tests/fixtures/import_job_typescript.json`.
- Contrato/API: OpenAPI, contrato TypeScript, domínio de imports e três suítes de contrato.
- Frontend: tipos/presentação de imports e suas duas suítes.
- Este relatório.

## Autorrevisão

- O marker é a única prova que permite pular a origem; checkpoint MySQL nunca participa dessa
  decisão no caminho v2.
- A consulta do marker é por chave; a reconciliação usa identidades declaradas no próprio marker
  e `HEAD`. Nenhum `list_*` S3 foi introduzido.
- O marker só é gravado após todas as partições estarem `AVAILABLE`; qualquer falha anterior
  deixa a repetição obrigada a restaurar e extrair desde o começo.
- Upload, promoção, registro, validação e replay usam chaves e idempotency keys determinísticas.
  Evidência diferente para a mesma identidade falha fechado.
- Parquets locais são removidos logo após staging confirmado; o processo mantém o spool JSON e
  no máximo o objeto Parquet em processamento, nunca todos os Parquets locais simultaneamente.
- O replay `AVAILABLE` não promove, não recataloga e não consulta Athena; ele confirma somente
  os objetos finais contra a evidência persistida.
- O fluxo legado continua usando helpers/APIs explicitamente v1 e passou pelos mesmos gates de
  resiliência e idempotência.
- Mensagens persistidas/públicas permanecem allowlisted e não incorporam texto interno de S3,
  Glue, Athena, DynamoDB, paths ou consultas.
- Nenhum AWS real foi chamado.

## Preocupações

- A Tarefa 5 ainda precisa fornecer leitura a partir do arquivo canônico para reconstruir
  projeções/hot depois de um marker. Até lá, uma retomada que encontra marker mas não encontra
  entrada de projeção disponível falha explicitamente em `PROJECTING`; mesmo assim, conforme o
  contrato desta tarefa, ela não toca restore, source reader nem publicação canônica.
- O `AGENTS.md` fornecido pelo contexto referencia `RTK.md`, mas esse arquivo não existe nem na
  raiz compartilhada nem neste worktree. O `AGENTS.md` específico do frontend foi lido; as
  mudanças são apenas allowlist/mensagens/testes e não usam APIs Next.js.
- As únicas pendências de gate são baselines fora do diff (formatação global) e a ausência do
  serviço MySQL local; não há bloqueio funcional ou decisão arquitetural pendente para a Tarefa
  4.

---

## Rodada de correções 1/5 — 2026-09-22

### Status

Os cinco apontamentos `Important` da primeira revisão foram corrigidos com TDD em um commit
separado, sem `amend`. Esta rodada não altera os códigos públicos nem contratos TypeScript; ela
fecha as fronteiras de replay, integridade física, throttling e reconciliação do marker.

### RED registrado

1. **Replay `AVAILABLE` e preflight global.** Os testes novos reproduziram quatro falhas:
   `publish_canonical` exigia a quantidade de objetos em staging antes de consultar a partição,
   o replay sem staging falhava com `staged object count differs`, a divergência de
   `catalogDigest` não era alcançada e o retry do Backfill realizou 23 novos stages antes de
   reconciliar o estado persistido. O cenário de conflito tardio foi reforçado removendo uma
   partição anterior, de modo que uma implementação sequencial voltaria a fazer upload antes de
   descobrir o conflito posterior.
2. **Tipos S3.** Três testes focais falharam inicialmente: checksum divergente de part multipart
   virou `ArchiveStorageError`, e corrupção/indisponibilidade no `HEAD` da promoção viraram
   `ConditionalWriteError`. Um quarto RED demonstrou que um `HEAD` internamente válido, mas
   diferente da evidência staged, também era classificado como conflito condicional.
3. **Throttling DynamoDB.** A primeira coleta falhou porque `DynamoDbThrottled` ainda não existia
   no módulo compartilhado `adapters.dynamodb.client`. Após introduzir os testes das demais
   fronteiras e antes de implementá-las, manifest/outbox produziram quatro falhas, deixando
   escapar `ClientError` em transação, `GetItem` e `Query`.
4. **Digest catalogado antes do marker.** O teste do publisher falhou antes da implementação
   porque staging era validado primeiro; depois passou a alcançar e rejeitar `catalogDigest`
   divergente. A cobertura de Backfill exercita agora tanto `catalogGeneration` quanto
   `catalogDigest` em uma partição posterior, sem marker/candidato e sem uploads ou promoções
   anteriores.
5. **Marker checksum-válido porém logicamente inválido.** A coleta de store/classificador ficou
   RED pela ausência de `CanonicalSetEvidenceError`. Os cenários cobrem schema fechado,
   contagens, objeto, digest agregado, membro JSON duplicado e profundidade hostil.

### GREEN e implementação

- `ArchivePartitionPublisher.preflight_canonical` valida identidade, geração, objetos, estado,
  `catalogDigest == aggregateDigest` e cada chave final por `HEAD` sem produzir efeitos. O
  Backfill calcula evidência leve, preflights todas as partições antes do primeiro stage e só
  reencoda/stageia partições que ainda não estão `AVAILABLE`. Replay idêntico com staging
  expirado não chama `PutObject`, promoção, Glue nem Athena.
- `S3ArchiveStore` preserva `ArchiveStorageError` para indisponibilidade/ausência não confirmada e
  usa `ArchiveChecksumMismatch` para divergência física, inclusive part multipart, metadata de
  `HEAD` e conteúdo staged diferente durante promoção. O classificador público continua
  retornando `ARCHIVE_PUBLICATION_FAILED` retryable para indisponibilidade e
  `CHECKSUM_MISMATCH` terminal para corrupção.
- `DynamoDbThrottled` e a detecção fechada de throttling direto/transacional foram centralizados
  em `adapters.dynamodb.client`. Archive partitions, controle de run/lease/checkpoint,
  manifests, projections e outbox traduzem o erro em suas fronteiras `GetItem`, `Query` e
  transacionais. Cancelamentos condicionais ou mistos continuam seguindo a classificação
  fechada anterior. O classificador público reconhece o tipo compartilhado como
  `DYNAMODB_THROTTLED`, retryable.
- Uma partição v2 `AVAILABLE` só é compatível quando seu `catalogDigest` coincide com o
  `aggregateDigest` recém-calculado. Qualquer divergência interrompe o preflight antes do marker
  e impede a publicação do candidato.
- `S3CanonicalSetStore` separa resposta/evidência física inválida de evidência lógica inválida.
  `CanonicalSetEvidenceError` é terminal e mapeia para `DATA_RECONCILIATION_FAILED`; falha S3
  permanece `CanonicalSetStorageError` retryable e checksum físico permanece
  `CanonicalSetChecksumMismatch` terminal.

### Gates da rodada

Gate Python exato do brief:

```text
.venv/bin/python -m pytest tests/unit/application/test_archive_partition.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py tests/unit/adapters/test_parquet.py tests/unit/adapters/test_archive_aws.py tests/resilience/test_archive_ttl_guard.py tests/resilience/test_idempotent_backfill.py -q
418 passed in 16.26s
```

Store/domínio/bootstrap canônico:

```text
.venv/bin/python -m pytest tests/unit/adapters/test_s3_canonical_sets.py tests/unit/domain/test_canonical_set.py tests/unit/bootstrap/test_cli.py tests/unit/bootstrap/test_config.py tests/unit/bootstrap/test_reprocess_runtime_contract.py -q
137 passed in 0.65s
```

Regressão Python sem infraestrutura MySQL:

```text
.venv/bin/python -m pytest tests/unit tests/resilience tests/contracts -m 'not mysql' -q
1480 passed, 1 deselected in 26.54s
```

Verificações estáticas e contratos:

- Ruff: `All checks passed`; `22 files already formatted`.
- Mypy configurado: `Success: no issues found in 5 source files`.
- Mypy `--strict` nos 12 módulos de produção tocados: `Success: no issues found in 12 source
  files`.
- API: `npm run build:contracts`; 3 arquivos/90 testes; `npm run lint`; `npm run typecheck`, todos
  com exit 0.
- Frontend: 2 arquivos/23 testes; `npm run lint`; `npm run typecheck`, todos com exit 0.
- `git diff --check`: exit 0.

### Arquivos desta rodada

- Publicação/store: `application/archive_partition.py`, `application/backfill.py`,
  `application/import_dump.py`, `adapters/archive/s3.py` e
  `adapters/archive/s3_canonical_sets.py`.
- DynamoDB: `adapters/dynamodb/client.py`, `import_jobs.py`, `archive_partitions.py`, `control.py`,
  `manifests.py`, `projections.py` e `outbox.py`.
- Testes: publisher/Backfill/import dump, adaptadores S3/store/DynamoDB e resiliência de archive
  TTL/ativação.

### Autorrevisão e preocupações

- O preflight global é totalmente read-only: nenhuma divergência já persistida em uma partição
  posterior é descoberta depois de um stage/promotion anterior da mesma tentativa. Conflitos
  concorrentes ainda são fechados pelas condições/idempotência de cada fronteira.
- O fast path `AVAILABLE` depende somente de metadata persistida e `HEAD` das chaves finais; não
  consulta nem recria staging, não lista S3 e não volta a Glue/Athena.
- O marker continua sendo a única prova que permite pular a origem; esta rodada não promove
  checkpoint MySQL a prova de durabilidade.
- Os Minors da revisão permanecem deliberadamente fora desta rodada: o row group PyArrow ainda
  possui cap implícito por linha, e `code/retryability` ainda não é fechado em todas as
  fronteiras. Não houve mudança nesses pontos.
- Nenhum AWS real, checkout original, state, stash, push ou merge foi usado.

---

## Rodada de correções 2/5 — 2026-09-22

### Status

O apontamento residual sobre throttling no caminho legado do Backfill foi corrigido em escopo
fechado. `DynamoHotRecordSink` agora traduz throttling esgotado em todas as suas fronteiras
DynamoDB, e `UnprocessedKeysExhausted` participa do mesmo contrato tipado reconhecido pelo
classificador público. Os dois `Minor` deferidos continuam fora desta rodada.

### RED registrado

Antes de alterar produção, foram adicionados cenários focais para `BatchGetItem`, `Query`,
`TransactWriteItems`, esgotamento de `UnprocessedKeys` e classificação pública através de
`BackfillFailed`:

```text
.venv/bin/python -m pytest tests/resilience/test_unprocessed_items.py tests/unit/adapters/test_dynamodb_hot_records.py tests/unit/application/test_import_dump.py -q
5 failed, 130 passed in 1.47s
```

As cinco falhas demonstraram que:

- `BatchGetItem`, `Query` e `TransactWriteItems` propagavam `ClientError` de throttling sem a
  tradução compartilhada;
- `UnprocessedKeysExhausted` não era um `DynamoDbThrottled` mesmo depois das oito tentativas;
- por consequência, o wrapper público devolvia `INTERNAL_ERROR` em vez de
  `DYNAMODB_THROTTLED` retryable.

Os controles negativos para `ValidationException` já passaram no RED, comprovando que a
correção não precisava ampliar retryability para erros DynamoDB não relacionados.

### GREEN e implementação

- `DynamoHotRecordSink` centraliza as chamadas low-level em wrappers para `BatchGetItem`,
  `Query` e `TransactWriteItems`. Cada wrapper usa o detector fechado compartilhado e relança
  intacto qualquer `ClientError` que não seja throttling.
- Todas as cinco fronteiras transacionais internas do sink passam pelo mesmo wrapper; isso cobre
  claim, takeover, conclusão do marker, migração incremental de catálogo e gravação de fatos.
- `DynamoBatchRetryExhausted` deriva de `DynamoDbThrottled`, preservando
  `UnprocessedKeysExhausted` e sua compatibilidade anterior enquanto permite ao classificador
  público produzir `DYNAMODB_THROTTLED`, `retryable=true`.
- Cancelamentos condicionais, cancelamentos mistos, `TransactionConflictException` direto e
  erros não-throttling continuam fora da tradução. As mensagens privadas do SDK não aparecem no
  erro tipado.
- As fronteiras `GetItem`, `Query` e transacionais do `DynamoHotExpirationRepository`, fechadas
  na rodada anterior, foram mantidas e exercitadas novamente pela suíte de TTL/Backfill.

### Gates da rodada

Hot records, classificação pública, Backfill e expiração:

```text
.venv/bin/python -m pytest tests/resilience/test_unprocessed_items.py tests/unit/adapters/test_dynamodb_hot_records.py tests/integration/test_dynamodb_hot_records.py tests/unit/application/test_import_dump.py tests/unit/application/test_backfill.py tests/resilience/test_archive_ttl_guard.py -q
235 passed in 21.70s
```

Regressão Python sem infraestrutura MySQL:

```text
.venv/bin/python -m pytest tests/unit tests/resilience tests/contracts -m 'not mysql' -q
1487 passed, 1 deselected in 33.13s
```

Integração DynamoDB simulada repetida após formatação:

```text
.venv/bin/python -m pytest tests/integration/test_dynamodb_hot_records.py -q
11 passed in 1.64s
```

Verificações estáticas:

- Ruff check: `All checks passed!`.
- Ruff format: `4 files already formatted` após a formatação mecânica do módulo de produção.
- Mypy configurado: `Success: no issues found in 2 source files`.
- Mypy `--strict`: `Success: no issues found in 2 source files`.
- `git diff --check`: exit 0.

API e frontend não foram alterados nesta rodada; seus contratos e códigos públicos permanecem os
já validados na rodada 1.

### Arquivos desta rodada

- Produção: `adapters/dynamodb/hot_records.py`.
- Testes: `tests/resilience/test_unprocessed_items.py`,
  `tests/unit/adapters/test_dynamodb_hot_records.py` e
  `tests/unit/application/test_import_dump.py`.
- Relatório: este apêndice em `task-4-report.md`.

### Autorrevisão e preocupações

- A quantidade e o backoff de `UnprocessedKeys` não mudaram: a falha continua ocorrendo somente
  após oito tentativas e sete esperas; apenas sua classificação foi fechada.
- A implementação não cria retry próprio sobre o SDK. Ela traduz somente a evidência de
  throttling que chega após os retries configurados no cliente, evitando duplicar writes
  transacionais de modo inseguro.
- O protocolo low-level e as formas `AttributeValue` existentes foram preservados porque são
  parte do contrato validado pelo adaptador e pelos testes; todos os clientes permanecem
  injetados e nenhuma chamada à AWS real foi feita.
- Nenhum código público novo foi necessário, e nenhuma mensagem de tabela, operação ou payload é
  exposta por `DYNAMODB_THROTTLED`.
- Os dois `Minor` deferidos continuam deliberadamente intocados: o cap implícito por linha do row
  group PyArrow e o fechamento global de `code/retryability` nas demais fronteiras.
- Nenhum checkout original, state, stash, push, merge ou subagente foi usado.
