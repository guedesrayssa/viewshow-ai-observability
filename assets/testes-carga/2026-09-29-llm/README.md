# Evidências brutas — teste de carga da camada de LLM, 29/09/2026

Pasta de evidências da rodada consolidada em
[`testes-carga-llm.md`](../../../artefatos/arquitetura/implementacao/camada-agentica/testes-carga-llm.md).
Nada aqui é template. Cada `resumo-*.json` é o arquivo `OUT` gravado por uma
execução real de `npm run load:llm` (`apps/backend/agentic/scripts/load-llm.ts`).
Cada `metadados-*.json` registra o comando, as datas UTC de início e fim, a
duração, o `exit code`, a versão do Node, o commit, o ambiente e o stdout
daquela execução, no mesmo formato de
[`2026-09-11/`](../2026-09-11/README.md).

## Ambiente comum a todas as execuções

| Item      | Valor                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| Código    | branch `feat/test-llm-module` (`92f2cd1`)                                              |
| Gerador   | `node dist/scripts/load-llm.js` (Node v22), no mesmo processo que `investigate()`      |
| Host      | Linux 6.17 x86_64                                                                      |
| Provider  | `fake`: latência simulada de 800 ± 400 ms, sem rede                                    |
| Estágios  | concorrência 1, 2, 4, 8 e 16 (modelo fechado), 50 investigações por estágio            |
| Mistura   | 3 cenários em rodízio: evidência forte, evidência fraca e sem evidência (barrado no gate) |
| Limites   | `ERROR_RATE_MAX=0.05`; `P95_MAX_MS` não definido                                       |

## Resumos

| Arquivo                          | Cenário                              | `exit` | Leitura                                                                                       |
| -------------------------------- | ------------------------------------ | -----: | --------------------------------------------------------------------------------------------- |
| `resumo-fake-baseline.json`      | `npm run load:llm`                   |      0 | linha de base: 0% de falha em todos os estágios; a vazão cresce linearmente de 1,87 para 24,03 req/s |
| `resumo-fake-erro-injetado.json` | `FAKE_ERROR_RATE=0.1 npm run load:llm` |    1 | **reprovada de propósito**: comprova que o gate de `ERROR_RATE_MAX` reprova a rodada (C=1, 2 e 8 acima de 5%). Gravado antes de `taxaFalha` passar a dividir só pelas chamadas ao LLM; com o cálculo atual, os cinco estágios reprovam |

`exit=1` significa que algum estágio violou um limite (o equivalente ao
`exit=99` do k6).

## O que esta pasta não contém

- **Rodadas com `ollama` ou `bedrock`.** Na janela não havia Ollama local
  ativo e a credencial AWS estava expirada. Os números medem a camada, não o
  modelo.
- **Séries do Prometheus e capturas do Grafana.** O script roda em processo e
  não passa pela API nem pelo worker instrumentado.
