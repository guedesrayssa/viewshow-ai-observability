# Tarefa 6 — pular materialização quente no v2

## Status

Implementada com TDD. `canonical-v2` agora rejeita explicitamente hot materialization, persiste
`MATERIALIZING_HOT` como `SKIPPED_BY_POLICY` com `0/0 datasets`, publica candidato com
`hotMaterialization: "SKIPPED"` e `hotItemCount: 0`, e nunca chama hot sink, checkpoints ou TTL.
O fluxo administrativo `legacy-v1`, retry e ingestão incremental mantêm o comportamento anterior.

## RED registrado

O primeiro gate, antes da implementação, produziu três falhas comportamentais esperadas:

```text
FAILED test_backfill_request_rejects_hot_materialization_in_canonical_pipeline
  Failed: DID NOT RAISE ValueError
FAILED test_canonical_pipeline_archives_before_projection_without_hot_or_checkpoints
  AttributeError: RunTransitionMetadata has no attribute substage
FAILED test_canonical_retry_republishes_no_hot_items_and_keeps_skip_evidence
  AttributeError: RunTransitionMetadata has no attribute units_completed
```

O teste MySQL executado fora do bloco Docker também falhou por conexão recusada, como esperado.
Depois do primeiro GREEN com fakes, dois REDs adicionais provaram que os limites reais ainda
descartavam a evidência: `RunActivity` não aceitava `substage` e o item Dynamo não continha
`substage`. Ambos passaram depois da persistência e do espelho público serem implementados.
Na autorrevisão, um RED de upgrade reproduziu `IdempotencyConflict` ao repetir uma transição
legada cujo fingerprint não tinha os campos opcionais; os campos novos agora entram na identidade
somente quando presentes, preservando markers anteriores.

## Implementação

- `materialize_hot_records_for` centraliza a política imutável: legado `true`, canônico `false`.
- `BackfillRequest` rejeita `canonical-v2 + materialize_hot_records=true` antes de efeitos.
- O v2 não possui chamada de hot writer; entra na etapa observável com skip e zero unidades.
- `RunTransitionMetadata`, `RunActivity`, auditoria Dynamo e progresso público preservam
  `substage`, unidades e label como grupo validado e all-or-none.
- Fingerprints sem detalhe opcional permanecem byte-a-byte compatíveis com a versão anterior.
- Manifestos legados mantêm o contrato anterior; candidatos v2 acrescentam o par fechado
  `hotMaterialization`/`hotItemCount`, validado como `SKIPPED`/`0`.
- Testes verificam ausência de hot writes, TTL e checkpoints, projeções/reconciliação obrigatórias,
  ponteiro ativo inalterado, replay idempotente e preservação das 29 gravações legadas.
- Nenhuma permissão ou chamada `BatchWriteItem` foi adicionada.

## GREEN e gates

```text
Bloco principal Docker/MySQL do brief: 76 passed in 8.74s
Bloco incremental Docker/MySQL do brief: 4 passed in 0.61s
pytest tests/unit tests/resilience tests/contracts -m 'not mysql' -q:
1515 passed, 1 deselected in 37.43s
Regressão adapters/domínio/import dump: 113 passed in 3.86s
```

- `ruff check .`: `All checks passed!`.
- Ruff format nos 11 arquivos tocados: `11 files already formatted`.
- Mypy em `domain application ports adapters bootstrap contracts`: 95 módulos sem erros.
- `git diff --check`, busca de adição de `BatchWriteItem` e ausência de containers: exit 0.
- Ambos os blocos Docker usaram `trap '... down --volumes' EXIT` e removeram os recursos.

## Arquivos e decisões

Além dos seis arquivos inicialmente enumerados, o contrato exigiu atualizar os limites que
realmente persistem/validam a evidência: `domain/archive.py`, adapters Dynamo/telemetria e seus
dois testes. Sem isso, os fakes passariam enquanto produção descartaria `SKIPPED_BY_POLICY`.

## Preocupações

- `AGENTS.md` referencia `RTK.md`, mas esse arquivo não existe no repositório/worktree.
- `ruff format --check .` aponta 26 arquivos preexistentes fora da tarefa; nenhum foi alterado.
- Nenhuma AWS real, checkout original/state, stash, push ou merge foi usada.
