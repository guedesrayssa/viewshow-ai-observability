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
| `src/domain/response-validation.ts` | Interpreta e ancora a resposta do modelo |
| `src/domain/outcome.ts` | Piso de confiança e ordenação por confiança |
| `src/domain/evidence.ts` | Entrada da investigação: incidente, evidência, caso curado |
| `src/prompts/rca-v1.ts` | Prompt versionado, com bloco de dados delimitado |
| `src/application/investigate.ts` | Orquestração: gate → curado → modelo → validação |
| `src/adapters/llm/fake-provider.ts` | Duplo determinístico, só para teste |
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

**A ancoragem em evidência é a defesa contra injeção de prompt.** Evidência vem
de log e alerta, sistemas que o time não controla, e um texto plantado ali pode
convencer o modelo a afirmar qualquer coisa. O que ele não consegue é citar um
identificador de evidência que não exista no pacote carregado. Hipótese que
cita evidência inventada é descartada, e o descarte é reportado mesmo quando as
outras passam — senão a injeção parcial some no caminho de sucesso.

**O score do detector e a confiança do agente nunca se misturam.** Um mede quão
anômalo o sinal é; o outro, quanto o agente acredita naquela explicação. Ficam
em campos separados, e é isso que permite auditar depois se o agente concordou
com o modelo.

## A camada não lê nem escreve

`investigate()` recebe o pacote pronto e devolve o diagnóstico. Não toca banco,
nem através de port. Enquanto as duas branches divergem, persistência é
justamente a parte que ainda vai mudar — um adaptador em cada backend faz
`ler → investigate → gravar`, e esta função sobrevive aos dois.

O efeito colateral é bom: a camada inteira é testável com um único duplo, o do
modelo de linguagem. Sem banco, sem fila, sem rede.

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
