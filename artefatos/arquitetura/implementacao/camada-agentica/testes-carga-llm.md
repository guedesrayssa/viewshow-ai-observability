# Teste de carga da camada de LLM

- **Status:** linha de base executada com provider `fake`; rodadas com `ollama` e `bedrock` não executadas
- **Data:** 29/09/2026
- **Executor:** `apps/backend/agentic` → `npm run load:llm` ([`scripts/load-llm.ts`](../../../../apps/backend/agentic/scripts/load-llm.ts))
- **Evidências:** [`assets/testes-carga/2026-09-29-llm/`](../../../../assets/testes-carga/2026-09-29-llm/README.md)
- **Camada avaliada:** [`camada-agentica.md`](camada-agentica.md)

## 1. Por que esta medição existe

&emsp; A suíte k6 de [`testes-carga-inicial.md`](../../../sprint3/testes-carga-inicial.md)
mede a API de consulta, que responde em milissegundos. A camada de LLM tem outro
perfil: cada investigação leva segundos, o custo é por token e o gargalo provável
é o provider (fila do Ollama, cota e *throttling* do Bedrock), não a CPU da
aplicação. A pergunta deste teste é **qual concorrência do worker
(`WORKER_CONCURRENCY`) o provider sustenta antes de a latência ou a taxa de
falha estourar**.

&emsp; O teste não usa k6 porque não há endpoint HTTP para exercitar: o worker
consome SQS e chama `investigate()` em processo. O script chama a mesma função,
com o mesmo prompt, parse e validação da produção, e troca apenas o provider.

## 2. Método

| Item | Valor |
|:--|:--|
| Modelo de carga | fechado: C clientes, cada um dispara a próxima investigação quando a anterior termina (o formato do worker) |
| Estágios | C = 1, 2, 4, 8, 16; 50 investigações por estágio |
| Mistura | 3 cenários em rodízio: 4 evidências fortes, 2 evidências fracas e nenhuma evidência. O último é barrado pelo gate de qualidade e não chama o modelo, como boa parte dos sinais em produção |
| Latência | `totalMs` (a investigação inteira) e `llmMs` (só a chamada ao provider), com percentil por posto mais próximo |
| Limites | `ERROR_RATE_MAX` (padrão 0,05) por estágio; `P95_MAX_MS` opcional. Violação ⇒ `exit 1` |
| Bedrock | SDK com `maxAttempts: 1`, para o *throttling* aparecer em vez de ser absorvido por retentativa |
| Aquecimento | uma investigação fora da medição quando o provider é real (o Ollama carrega o modelo na primeira chamada) |

## 3. Resultados

### 3.1 Linha de base (`fake`, 800 ± 400 ms)

| C | req/s | p50 | p95 | p99 | LLM p95 | Falha | Estado |
|--:|--:|--:|--:|--:|--:|--:|:--|
| 1 | 1,87 | 584 ms | 1159 ms | 1190 ms | 1164 ms | 0% | 34 `ready`, 16 `pending` |
| 2 | 3,57 | 630 ms | 1184 ms | 1199 ms | 1199 ms | 0% | idem |
| 4 | 6,76 | 564 ms | 1180 ms | 1200 ms | 1194 ms | 0% | idem |
| 8 | 12,94 | 574 ms | 1101 ms | 1163 ms | 1116 ms | 0% | idem |
| 16 | 24,03 | 528 ms | 1162 ms | 1177 ms | 1171 ms | 0% | idem |

<sup>Fonte: [`resumo-fake-baseline.json`](../../../../assets/testes-carga/2026-09-29-llm/resumo-fake-baseline.json), `exit 0`.</sup>

&emsp; A diferença entre `p95` e `LLM p95` fica em até 5 ms: a montagem do
prompt, o parse e a validação não pesam perto da chamada ao modelo. A vazão
cresce quase linearmente com C. Em C=16 ela fica em 80% do ideal (24,03 contra
16 × 1,87 ≈ 30), porque 50 investigações divididas por 16 clientes deixam a
última rodada com clientes ociosos, e não por contenção na camada. Os 16
`pending` por estágio são o cenário sem evidência, barrado no gate
(`NO_EVIDENCE`) sem gastar inferência.

&emsp; **Este resultado não diz nada sobre o modelo.** Ele mostra que a camada
não é o gargalo e serve de régua para as rodadas com provider real.

### 3.2 Gate de falha (`FAKE_ERROR_RATE=0.1`)

&emsp; A rodada com 10% de erro injetado saiu com `exit 1`, reprovando C=1 (8%),
C=2 (6%) e C=8 (14%) contra o limite de 5%. As falhas aparecem como
`failed/PROVIDER_ERROR` e o processo continua, sem derrubar o estágio. Fonte:
[`resumo-fake-erro-injetado.json`](../../../../assets/testes-carga/2026-09-29-llm/resumo-fake-erro-injetado.json).

## 4. Aderência ao padrão dos outros testes de carga

| Prática da suíte k6 | Camada de LLM | Situação |
|:--|:--|:--|
| Script versionado com cabeçalho de uso e variáveis | cabeçalho de `load-llm.ts` | Segue |
| Limites que reprovam a rodada pelo código de saída | `ERROR_RATE_MAX`/`P95_MAX_MS` ⇒ `exit 1` | Segue |
| Resumo JSON por execução | `OUT` | Segue |
| Evidência versionada em `assets/testes-carga/<data>/` com `resumo-*` e `metadados-*` | o padrão é `resultados-carga/` (git-ignored) e o script não grava metadados | **Parcial**: esta rodada foi arquivada manualmente no padrão |
| README operacional ao lado da suíte | seção "Teste de carga" em [`apps/backend/agentic/README.md`](../../../../apps/backend/agentic/README.md) | Segue (adicionada) |
| Limite ligado a um RNF | nenhum RNF é citado e `P95_MAX_MS` vem vazio por padrão | **Não segue** |
| Modos (`smoke`, `load`, `breakpoint`, `estresse`, `spike`, `soak`) | apenas a rampa de estágios, equivalente a um `breakpoint` fechado | **Parcial** |
| Correlação com observabilidade (`X-Request-Id`, Prometheus) | roda em processo; nada chega ao Prometheus | **Não segue** (aceitável: não há API no caminho) |
| Estatística testada | `tests/load-stats.test.ts` | Segue |

### 4.1 Problema encontrado: a taxa de falha é diluída

&emsp; `taxaFalha` divide as falhas por **todas** as investigações do estágio,
incluindo o terço barrado no gate, que nunca chama o modelo e portanto nunca
falha. Com a mistura atual, um provider que falha 5% das chamadas aparece como
~3,4%. Recalculada sobre as 34 chamadas reais por estágio, a rodada 3.2 teria
falhado nos **cinco** estágios (C=16: 2/34 = 5,9%; C=4: 2/34 = 5,9%), e não em
três. Para o limite medir o provider, `resumir()` deve usar como denominador as
amostras com `llmMs !== null`.

## 5. Limitações e pendências

1. **Sem provider real.** Na janela desta rodada não havia Ollama ativo e a
   credencial AWS estava expirada. O próximo passo é
   `LLM_PROVIDER=ollama ... STAGES=1,2,4` no `opsrvbcc01` (o mesmo servidor de
   [`avaliacao-modelos.md`](avaliacao-modelos.md)) e uma rodada curta no Bedrock.
2. **Sem limite de latência derivado de requisito.** O RNF02 dá 120 s de ponta a
   ponta; a investigação precisa caber numa fração desse orçamento. Sugestão:
   `P95_MAX_MS=60000` nas rodadas com modelo real, até haver um número acordado.
3. **Amostra pequena nos estágios altos.** Com 50 investigações e C=16, cada
   cliente faz cerca de 3; o p99 é, na prática, o máximo.
4. **Metadados manuais.** O script deveria gravar o comando, o commit, as datas
   e o ambiente no próprio JSON, como o `handleSummary()` da suíte k6, em vez
   de depender de arquivamento manual.
5. **Gate de falha diluído** (seção 4.1).
