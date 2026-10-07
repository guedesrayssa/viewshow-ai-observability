# Três repetições nominais independentes — ECS

Mesma imagem e recursos, 150.000 registros por janela, hashes distintos, orçamento de900 s declarado antes de cada run. A migração de develop não alterou o k6 nem o core Python; a terceira coleta registra o checkout novo e preserva a mesma imagem ECS.

| Repetição | ImportId | Início UTC | K6/prazo (s) | Contagem independente | Terminal |
| --- | --- | --- | ---: | ---: | --- |
| R1 | `imp_01M49XBGZRRQB76CE60QQJ0GHM` | 2026-10-07T00:48:52.359Z | 905.094 /900 | 150,000 | FAILED/WORKER_STOPPED |
| R2 | `imp_01M49YHAKQ34T7P0ACD2M0J1EH` | 2026-10-07T01:09:32.219Z | 903.481 /900 | 150,000 | FAILED/WORKER_STOPPED |
| R3 | `imp_01M49ZQ2FHWPN0E6ET2GR6KVE5` | 2026-10-07T01:30:08.381Z | 900.350 /900 | 150,000 | FAILED/WORKER_STOPPED |

**RNF01 reprovado nas três observações:** 150.000 fatos em23 datasets foram recontados em cada versão, mas nenhuma chegou a READY antes do prazo. Permaneceram em PROJECTING; interrupção controlada da task própria após o k6. Duração é censurada: não calcular média/percentil de conclusão ou vazão final com ela. K6=99 em todas. Zero READY no resumo não significa zero persistidos.

Cada pasta preserva mass-manifest, metadata, resumo k6, outcome e recontagem fortemente consistente. O console integral está em GZIP; hashes da entrega no auditor.
