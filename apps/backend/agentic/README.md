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
| `src/contracts/analysis-event.ts` | Envelope da fila de análise e identidade da execução |
| `src/domain/evidence.ts` | Entrada da investigação: incidente, evidência, caso curado |
| `src/prompts/rca-v1.ts` | Prompt versionado, com bloco de dados delimitado |
| `src/application/investigate.ts` | Orquestração: gate → curado → modelo → validação |
| `src/bootstrap/llm-provider-factory.ts` | Seleção do provider na inicialização |
| `src/adapters/llm/ollama-provider.ts` | Provider real; roda sem AWS |
| `src/adapters/llm/bedrock-provider.ts` | Provider de produção, API Converse |
| `src/adapters/llm/fake-provider.ts` | Duplo determinístico, só para teste |
| `src/ports/llm-provider.ts` | Fronteira com o modelo de linguagem |
| `src/ports/agentic-diagnosis.ts` | Como o backend aciona esta camada |

## Três decisões que valem explicação

**Não existe `anomalyScore` de 0 a 1.** Os quatro métodos do notebook produzem
escalas diferentes e incomparáveis: z robusto por mediana/MAD, pontuação de
episódio sem teto, distância de Mahalanobis e buffer ratio previsto. Cada sinal
carrega o próprio limiar; `relativeMargin()` é a única comparação válida entre
detectores, porque mede cada um contra a própria régua.

**Diferir é decisão, não silêncio.** O gate reprova antes de chamar o modelo e
o diagnóstico fica `pending` com os motivos anexados. Com falso positivo de 63%
a 71% nos detectores, investigar tudo significaria pagar inferência em dois
terços dos disparos para escrever "não sei".

**A máquina não declara inconclusivo.** Quando o modelo responde e nada alcança
o piso de confiança, as hipóteses fracas ainda vão para revisão, com a ressalva
`BELOW_CONFIDENCE_FLOOR`. Por `analise-e-ia.md` §9, inconclusivo é veredito de
pessoa sobre uma hipótese, não estado do diagnóstico.

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

## Providers

`ollama` é o provider real desta fase, por necessidade e não por preferência:
Bedrock está bloqueado na conta do AWS Academy. Num acionamento assíncrono a
latência de um modelo local deixa de pesar, porque ninguém espera na tela.

O adaptador nunca devolve sucesso duvidoso — HTTP de erro, corpo que não é
JSON, conteúdo vazio e tempo limite viram exceção, que a orquestração traduz em
`failed`. Um adaptador que engolisse isso faria o diagnóstico quebrar mais
tarde, em outro lugar, com mensagem que não aponta para a causa.

`bedrock` usa a API Converse, e não `InvokeModel`: o código anterior montava
`anthropic_version` na mão, o que prendia a camada a modelos Anthropic. **O SDK
da AWS não é dependência deste pacote** — o adaptador recebe uma função
`converse` com interface estreita, e quem integra faz a ligação:

```ts
const client = new BedrockRuntimeClient({ region, maxAttempts: 4 });
const provider = createLlmProvider({
  kind: "bedrock",
  modelId,
  environment: process.env.NODE_ENV ?? "development",
  converse: (input) => client.send(new ConverseCommand(input)),
});
```

Assim o núcleo continua sem dependência de runtime, e não se carrega um SDK
inteiro por um provider que hoje está bloqueado na conta do AWS Academy.

`fake` só é construído com `environment === "test"`; em qualquer outro a
fábrica lança. Um duplo determinístico que vaze para produção não quebra — ele
responde, e a tela mostra um diagnóstico inventado com aparência de real. É a
pior falha possível aqui, e recusar na largada é a defesa mais barata.

## Avaliação com modelo real

Os testes automatizados provam que o código faz o que foi escrito. O avaliador
responde outra pergunta, que nenhum duplo consegue: um modelo de verdade,
recebendo o nosso prompt, produz diagnóstico utilizável — e obedece às regras
quando o dado tenta subvertê-las?

```bash
ollama serve                       # noutro terminal
ollama pull llama3.1
OLLAMA_MODEL=llama3.1 npm run eval:ollama
```

Cinco casos: incidente claro, **injeção de prompt plantada na evidência**,
evidência fraca, previsão preventiva e caso sem evidência. O relatório mostra
status, hipóteses, confiança e latência de cada um, e confere por fora que
nenhuma evidência inexistente chegou ao resultado.

No caso da injeção, o modelo obedecer não é falha do sistema: a hipótese é
descartada e aparece como `UNKNOWN_EVIDENCE`. Falha seria um identificador
inventado chegar ao diagnóstico entregue.

## Rodar

```bash
npm install
npm run verify   # typecheck + testes
```

Sem AWS, sem rede, sem banco. Os testes de integração sobem um servidor HTTP
local que fala o protocolo do Ollama, então o caminho de rede é exercitado de
verdade — o único faz-de-conta é o modelo.

## Falha de contrato é permanente

`parseAnalysisEvent` devolve `permanent: true` em toda rejeição. O documento é
explícito (§4): campo obrigatório ausente, versão incompatível ou janela
inválida vão direto à DLQ. Reprocessar não conserta contrato quebrado — só
queima as cinco tentativas antes de chegar ao mesmo lugar.

Os metadados que acompanham a mensagem à DLQ levam só identificadores. O escopo
do payload pode carregar dimensões vindas de telemetria, e isso não precisa
estar na DLQ.

A identidade da execução vem da `idempotencyKey`, nunca do `eventId`: uma
republicação técnica preserva a primeira e troca o segundo, e deduplicar pelo
`eventId` reprocessaria a mesma análise.

## Vocabulário

`artefatos/arquitetura/analise-e-ia.md` v1.1 é a fonte normativa da orquestração
do diagnóstico, e o vocabulário daqui segue o dela: os estados são `pending`,
`processing`, `ready` e `failed` (§10); os gatilhos são `ANOMALY_DETECTION`,
`QOE_FORECAST` e `REANALYSIS_REQUESTED` (§3); toda execução carrega o
`datasetVersion` recebido no evento (§8), que é o que permite reproduzir uma
análise depois.

Esse documento também já supera a ADR-004 num ponto: §11 determina que uma
indisponibilidade do modelo **não produz hipótese artificial**. O fallback por
template que a ADR-004 exigia está proibido — falha do provider vira `failed`.

## Fontes

- `artefatos/extras/notebooks/argus_algoritmo.ipynb` — detectores, calibração e
  os números de recall e falso positivo citados acima
- Fluxograma do parceiro — gate de qualidade, diferimento e as duas entradas
  (preventiva e reativa)
- `artefatos/arquitetura/analise-e-ia.md` v1.1 — **fonte normativa** do fluxo,
  do contrato da fila e dos estados
- `artefatos/sprint3/modelagem.md` — modelo de domínio vigente
