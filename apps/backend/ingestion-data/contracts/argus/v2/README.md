# Contrato executável ARGUS 2.0

`registry.json` define a allowlist e referencia os 23 descriptors validados por
`descriptor.schema.json`. Cada descriptor fecha esquema físico, chave natural,
cursor, timestamp, cobertura, retenção e estratégia de partição.

A elegibilidade para leitura por janela live é derivada sem fallback:

- `archivePartition.strategy` deve ser `event_time`;
- `timestampField` deve existir e ser o mesmo campo da partição;
- o dataset deve estar na allowlist.

Esse predicado é exposto por `DatasetDescriptor.supports_live_window_sync` e é
compartilhado por `sync` e `reprocess`. Consequentemente, `signal_meta` e
`live_event_sde`, que usam `snapshot_date`, entram apenas por `backfill`; uma
janela de `reprocess` nunca tenta interpretá-los como eventos live. Para uma
correção sem reler a origem, `rebuild-projections` consome somente dados já
materializados.
