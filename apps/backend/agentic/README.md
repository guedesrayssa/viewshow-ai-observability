# Camada agêntica — análise de causa raiz

Módulo autocontido. Decide se um sinal de ML merece investigação e, quando
merece, produz hipóteses de causa raiz ancoradas em evidência.

## Por que isolado

`develop` e `refactor/backend` divergem e as duas ainda vão mudar: a segunda
reescreve a API em microsserviços TypeScript e congela o código agêntico atual
fora do runtime. Amarrar esta camada a qualquer uma das duas garantiria
retrabalho.

Por isso o núcleo **não importa nada do repositório** — nem Express, nem
DynamoDB, nem SDK da AWS. Só tipos e funções puras. A integração acontece pelos
ports, com um adaptador de cada lado.

## O que já existe

| Arquivo | Papel |
| --- | --- |
| `src/domain/ml-result.ts` | Contrato de saída dos modelos, derivado do notebook |
| `src/domain/diagnosis.ts` | Estados, hipóteses ranqueadas, motivos de diferimento |
| `src/domain/quality-gate.ts` | Decide se os dados sustentam investigação |
| `src/ports/llm-provider.ts` | Fronteira com o modelo de linguagem |
| `src/ports/agentic-diagnosis.ts` | Como o backend aciona esta camada |

## Três decisões que valem explicação

**Não existe `anomalyScore` de 0 a 1.** Os quatro métodos do notebook produzem
escalas diferentes e incomparáveis: z robusto por mediana/MAD, pontuação de
episódio sem teto, distância de Mahalanobis e buffer ratio previsto. Cada sinal
carrega o próprio limiar; `relativeMargin()` é a única comparação válida entre
detectores, porque mede cada um contra a própria régua.

**`deferred` e `inconclusive` são estados distintos.** O primeiro é decidido
antes de chamar o LLM, o segundo depois. Com falso positivo de 63% a 71% nos
detectores, fundir os dois significa pagar inferência em dois terços dos
disparos para escrever "não sei".

**O score do detector e a confiança do agente nunca se misturam.** Um mede quão
anômalo o sinal é; o outro, quanto o agente acredita naquela explicação. Ficam
em campos separados, e é isso que permite auditar depois se o agente concordou
com o modelo.

## Integração

`AgenticDiagnosisPort` tem a mesma assinatura do port que `refactor/backend`
reservou em `incidents-service/src/ports/incident-repository.ts`, então o
encaixe é um adaptador e não uma renegociação de contrato. `requestDiagnosis`
devolve `"accepted"`, não o diagnóstico: o acionamento é assíncrono por
construção e nada bloqueia esperando o LLM.

## Rodar

```bash
npm install
npm run verify   # typecheck + testes
```

Sem AWS, sem rede, sem banco.

## Fontes

- `artefatos/extras/notebooks/argus_algoritmo.ipynb` — detectores, calibração e
  os números de recall e falso positivo citados acima
- Fluxograma do parceiro — gate de qualidade, diferimento e as duas entradas
  (preventiva e reativa)
- `artefatos/sprint3/modelagem.md` — modelo de domínio vigente
