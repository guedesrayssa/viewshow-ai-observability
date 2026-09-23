# Tarefa 5 — projeções exclusivamente do conjunto canônico

## Status

Implementada com TDD. O caminho `canonical-v2` agora descarta o spool de registros depois da
publicação confirmada, baixa somente os objetos autorizados pelo `CanonicalSet` e constrói as
projeções a partir de batches Parquet limitados. Repetições após o marker continuam sem tocar a
origem e refazem as projeções lendo o arquivo canônico. O caminho `legacy-v1` permanece
inalterado.

## RED registrado

No primeiro gate exato do brief, os quatro módulos de teste não foram coletados porque a nova
fronteira ainda não existia:

```text
.venv/bin/python -m pytest tests/unit/application/test_read_canonical_set.py tests/unit/application/test_projections.py tests/unit/application/test_backfill.py tests/integration/test_canonical_projection_rebuild.py -q
4 errors during collection: ModuleNotFoundError: application.read_canonical_set
```

Depois de criar apenas a ABC/assinatura mínima, o mesmo gate confirmou o RED comportamental:

```text
74 failed, 12 passed
```

As falhas cobriam reader ainda não implementado, download S3 sem owner/stream, ausência de
`ParquetFile.iter_batches`, Backfill sem factory canônica e rebuild ainda dependente de fatos
quentes. Na autorrevisão foi acrescentado um RED específico para limpeza de download cujo corpo
excedia o tamanho declarado: `1 failed, 1 passed`; após a correção: `2 passed`.

## Implementação

- `application/read_canonical_set.py` define `CanonicalRecordSource` e implementa
  `ReadCanonicalSet`. Antes de baixar qualquer byte, compara todas as partições persistidas com
  o marker e exige estado `AVAILABLE`, contagens, objetos, digest agregado e digest catalogado.
  Depois baixa exatamente uma key autorizada por vez, valida sua evidência e remove o temporário
  em `finally`.
- `adapters/archive/s3.py` adiciona download por `GetObject` com `ExpectedBucketOwner`, limite de
  512 MiB, leitura em chunks e SHA-256 calculado durante o stream. Tamanho/checksum divergentes
  falham fechado e qualquer arquivo parcial conhecido é removido.
- `adapters/archive/parquet.py` abre `pyarrow.parquet.ParquetFile`, valida footer, schema completo,
  fingerprint e metadata antes do primeiro batch, usa apenas `iter_batches(batch_size=...)` e
  confere versão do dataset, partição e row count acumulado. O novo caminho não chama
  `read_table`, `read_partition` nem materializa `_iter_partition` em uma tupla integral.
- `application/backfill.py` libera JSONL/evidência do spool antes de projetar e relê o conjunto
  confirmado pela fonte canônica. O replay com marker reconstrói schema/cobertura/candidato sem
  restore, source reader ou republicação. O fluxo v2 não escreve nem consulta fatos quentes.
- `application/rebuild_projections.py` aceita marker store + fonte canônica como par obrigatório,
  mantém o snapshot intermediário em SQLite e somente materializa projeções depois que todas as
  partições solicitadas foram encontradas. O fallback existente preserva o comando legado.
- `bootstrap/container.py` injeta a fonte canônica no Backfill e configura o owner esperado no
  store S3 real.
- Os testes unitários e de integração cobrem allowlist de keys, preflight global, estado, owner,
  tamanho, SHA, schema, dataset, partição, row count, batch bound, objeto esparso de 512 MiB,
  ausência de fatos quentes, dependências `ArchiveDependency`, idempotência e round-trip real de
  Parquet até as projeções.

## GREEN e gates

Gate exato do brief, após o último RED/GREEN:

```text
.venv/bin/python -m pytest tests/unit/application/test_read_canonical_set.py tests/unit/application/test_projections.py tests/unit/application/test_backfill.py tests/integration/test_canonical_projection_rebuild.py -q
89 passed in 8.48s
```

Regressões adicionais:

```text
.venv/bin/python -m pytest tests/unit tests/resilience tests/contracts -m 'not mysql' -q
1504 passed, 1 deselected in 36.26s

.venv/bin/python -m pytest tests/unit/adapters/test_parquet.py tests/unit/adapters/test_archive_aws.py -q
82 passed in 1.40s
```

Checks estáticos:

- Ruff nos dez arquivos de código/teste da tarefa: `All checks passed!`.
- Mypy nos seis módulos de produção alterados: `Success: no issues found in 6 source files`.
- `git diff --check`: exit 0.
- Nenhum AWS real foi chamado.

## Arquivos alterados

- Produção: `application/read_canonical_set.py`, `application/rebuild_projections.py`,
  `application/backfill.py`, `adapters/archive/s3.py`, `adapters/archive/parquet.py` e
  `bootstrap/container.py`.
- Testes: `tests/unit/application/test_read_canonical_set.py`,
  `tests/unit/application/test_projections.py`, `tests/unit/application/test_backfill.py` e
  `tests/integration/test_canonical_projection_rebuild.py`.
- Este relatório.

## Autorrevisão

- O marker é a allowlist única: não há listagem de prefixo nem fallback para objetos/fatos fora
  do `CanonicalSet`.
- A validação das partições é global e acontece antes do primeiro download; uma ausência ou
  divergência não alcança a escrita do candidato ou a ativação.
- A integridade física é verificada antes de o Parquet emitir dados, e o reader só materializa o
  batch Arrow configurado. O teste de 512 MiB espiona e proíbe explicitamente `read`,
  `read_row_group`, `read_table`, `read_partition` e `_iter_partition`.
- O spool JSONL é apagado antes da factory canônica ser usada. Apenas evidência leve para o
  manifesto volta a ser calculada durante os batches vindos do arquivo.
- `projectionItemCount` deixou de participar da evidência imutável v2; metadados antigos que
  ainda contenham o campo são aceitos pelo reader, e a contagem continua no resultado/candidato.
- Repetir o rebuild com as mesmas revisões conserva os heads e as dependências de arquivo. O
  repositório espião falha se `iter_input_batches` ou `query_inputs` forem chamados.
- O caminho legado mantém as APIs e ordem anteriores e passou na regressão ampla.

## Preocupações

- O `AGENTS.md` fornecido pelo contexto referencia `RTK.md`, mas o arquivo não existe neste
  worktree nem na raiz compartilhada; não houve instrução adicional disponível para aplicar.
- Nenhuma decisão arquitetural ou dependência externa ficou pendente.

---

## Correção round 1/5 — 2026-09-22

### Status

Os três apontamentos foram corrigidos com TDD em um commit separado. O handler real de
`rebuild-projections` agora recebe marker store e reader canônico, o runtime de Backfill resolve
o `CanonicalSetStore`, e o candidato persiste/reconcilia a cardinalidade física das projeções.
O fallback legado continua sendo usado exclusivamente quando não existe marker para a versão.

### RED registrado

1. O teste do fallback com store canônico configurado e marker ausente falhou com
   `ValueError: canonical set marker is missing`, em vez de consultar os fatos legados.
2. Os testes do container real produziram dois REDs independentes: `resolve("backfill")`
   terminou em `KeyError: canonical_sets`, e o handler real de rebuild chamou
   `ProjectionRepository.iter_input_batches` apesar de existir marker.
3. Os dois testes de evidência do candidato falharam com `KeyError: partitions`, demonstrando
   que `ProjectionBuildResult.catalog_item_counts` não era persistido.
4. Depois da persistência mínima, o replay idêntico falhou com
   `stored candidate differs from canonical reconstruction`. A comparação mostrou que a
   primeira execução gravava fingerprints físicos da origem enquanto o replay usava os
   fingerprints Parquet do marker. A primeira execução passou a derivar a evidência final do
   mesmo `CanonicalSet` confirmado.
5. Três testes de configuração falharam inicialmente porque Backfill/rebuild aceitavam ausência
   de `ARCHIVE_BUCKET`/`ARCHIVE_BUCKET_OWNER` e só falhariam durante a construção dos adapters.

### Implementação

- `_capabilities("backfill")` inclui `canonical_sets`; a configuração de Backfill exige o owner
  necessário ao download canônico.
- O runtime de rebuild resolve registry, marker store, catálogo de partições e object store. O
  handler constrói `ReadCanonicalSet` com workspace local e o use case escolhe a fonte canônica
  quando o marker existe; caso `get(dataset_version)` retorne `None`, conserva o caminho legado.
- A configuração de rebuild valida bucket e owner antes de construir factories externas.
- `_manifest` converte `catalog_item_counts` na evidência fechada
  `validations.parquetCatalog.datasets.<dataset>.partitions.<partition>.projectionItemCount` e
  exige cobertura exata das partições arquivadas. O domínio valida partição, cardinalidade e
  contagens não negativas, preservando leitura de manifests legados sem o membro novo.
- O replay compara essa cardinalidade pela evidência normal do candidato; qualquer drift falha
  em `FINALIZING_CANDIDATE` e não altera o manifesto ativo.
- Conforme o ruling, nenhum snapshot SQLite/two-pass adicional foi introduzido no Backfill;
  projeções parciais versionadas continuam permitidas, mas candidato/ativação ficam bloqueados.

### GREEN e gates

```text
.venv/bin/python -m pytest tests/unit/application/test_read_canonical_set.py tests/unit/application/test_projections.py tests/unit/application/test_backfill.py tests/integration/test_canonical_projection_rebuild.py -q
92 passed in 8.64s

.venv/bin/python -m pytest tests/unit/bootstrap/test_config.py tests/unit/bootstrap/test_cli.py tests/unit/application/test_commands.py -q
170 passed in 2.83s

.venv/bin/python -m pytest tests/contracts -q
170 passed in 0.95s

.venv/bin/python -m pytest tests/resilience/test_idempotent_backfill.py tests/resilience/test_activation_boundaries.py -q
25 passed in 2.71s

.venv/bin/python -m pytest tests/unit tests/resilience tests/contracts -m 'not mysql' -q
1512 passed, 1 deselected in 36.19s
```

- Ruff nos oito arquivos de código/teste corrigidos: `All checks passed!`.
- Mypy nos cinco módulos de produção corrigidos: `Success: no issues found in 5 source files`.
- `git diff --check`: exit 0.
- Nenhum AWS real foi chamado.

### Autorrevisão e preocupações

- O teste de runtime executa o handler construído por `RuntimeContainer`, com Parquet real,
  marker e catálogo persistido; um repositório espião falha se fatos quentes forem consultados.
- A ausência do marker é distinguida de falha do marker store: somente `None` autoriza fallback;
  erros externos continuam fail-closed.
- `projectionItemCount` não voltou para metadata/identidade imutável da partição canônica v2.
- Manifests anteriores sem a nova evidência continuam válidos no contrato; novos manifests
  produzidos pelo Backfill sempre incluem e reconciliam a cardinalidade por partição.
- Não há bloqueio ou decisão arquitetural pendente nesta rodada.
