# Camada agêntica — análise de causa raiz

- **Status:** implementada e avaliada; integração e implantação pendentes
- **Versão:** 1.1
- **Última atualização:** 10/09/2026
- **Código:** [`apps/backend/agentic`](../../../../apps/backend/agentic)
- **Fonte normativa:** [`analise-e-ia.md`](../../analise-e-ia.md) v1.1
- **Avaliação de modelos:** [`avaliacao-modelos.md`](avaliacao-modelos.md)

&emsp; Este documento registra **o que está implementado**, o que a implementação
produziu como resultado e **como rodar e validar** a camada. Ele não redefine
contratos: a fonte normativa é [`analise-e-ia.md`](../../analise-e-ia.md), e a
conferência item a item contra ela está na Seção 9.

## 1. O que é

&emsp; A camada agêntica decide **se um sinal de aprendizado de máquina merece
investigação** e, quando merece, produz **hipóteses de causa raiz ancoradas em
evidência**. Ela ocupa a caixa "agente diagnóstico" do fluxo definido em
[`analise-e-ia.md`](../../analise-e-ia.md) §2, entre o orquestrador de análise e
o modelo de linguagem.

&emsp; Ela **não** detecta anomalias, não prevê degradação e não decide o que é
incidente. Isso é dos modelos de ML, cujo resultado ela recebe pronto.

&emsp; Ela é **biblioteca, não serviço**: não tem ponto de entrada, servidor HTTP
nem consumidor de fila. `investigate()` recebe um pacote pronto e devolve um
diagnóstico, e quem integra faz `ler → investigate → gravar`.

## 2. Estrutura

### 2.1 Padrão arquitetural: portas e adaptadores

&emsp; A camada segue **portas e adaptadores**, também chamada de arquitetura
hexagonal. A ideia do dia a dia é simples: o miolo que decide não conhece o
mundo lá fora. Ele declara *o que precisa* — "alguém me responda uma pergunta de
texto" — e quem sabe falar com o mundo lá fora implementa isso do lado de fora.
O nome técnico dessa declaração é **porta** (`port`); o nome de quem a
implementa é **adaptador** (`adapter`).

&emsp; No nosso caso a porta é `LlmProvider`, com um único método `generate()`.
Os adaptadores são três — Ollama, Bedrock e um duplo de teste. Trocar o modelo
de linguagem é escrever um adaptador novo; nenhuma linha da lógica de
investigação muda.

&emsp; Esse padrão foi escolhido por um motivo concreto e não por gosto: o
provider de produção está **bloqueado** hoje (Bedrock indisponível na conta do
laboratório). Sem a porta, a camada teria sido escrita contra o SDK da AWS e
estaria parada esperando liberação. Com a porta, ela foi construída, testada e
avaliada contra um modelo local, e o dia em que o Bedrock liberar troca-se o
adaptador na inicialização.

&emsp; A **regra de dependência** é o que faz o padrão valer na prática: as
setas apontam sempre para dentro, e o centro não sabe que existe borda.

```text
   ┌──────────────────────────────────────────────────────────────────┐
   │ bootstrap/   escolhe o adaptador na inicialização                │
   │              (raiz de composição — único que conhece o concreto) │
   └──────────────────────────────┬───────────────────────────────────┘
                                  │ instancia
                                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ adapters/llm/   ollama · bedrock · fake                          │
   │                 único lugar com rede, protocolo e autenticação   │
   └──────────────────────────────┬───────────────────────────────────┘
                                  │ implementa
                                  ▼
   ╔══════════════════════════════════════════════════════════════════╗
   ║ ports/   LlmProvider · AgenticDiagnosisPort                      ║
   ║          contrato puro — não importa NADA                        ║
   ╚══════════════════════════════▲═══════════════════════════════════╝
                                  │ depende só do contrato,
                                  │ nunca de quem o implementa
   ┌──────────────────────────────┴───────────────────────────────────┐
   │ application/investigate()   orquestra o roteiro                  │
   │        │ usa                                                     │
   │        ▼                                                         │
   │ domain/   regras puras, sem I/O                                  │
   └──────────────────────────────────────────────────────────────────┘
```

&emsp; Isso não é aspiração de documento: é verificável no código.

| Pasta | De onde ela importa | Evidência |
|:--|:--|:--|
| `ports/` | **nada** | nenhum `import` nos dois arquivos |
| `domain/` | só `domain/` e `ports/llm-provider` | `response-validation.ts` é o único que toca a porta |
| `application/` | `domain/`, `ports/`, `prompts/` | `investigate.ts` |
| `adapters/` | só `ports/` | os três providers |
| `bootstrap/` | `ports/` e os três adaptadores | `llm-provider-factory.ts`, a raiz de composição |

&emsp; Nenhum arquivo de `src/` importa de `adapters/` a não ser `bootstrap/`.
Quem decide nunca vê quem executa.

&emsp; A pureza foi levada a um ponto incomum: **nenhum arquivo de `src/`
importa nada de `node:`** — nem `fs`, nem `http`, nem `crypto`. Quando o núcleo
precisou de hash para derivar o `analysisRunId`, ele passou a **receber a função
de hash como parâmetro** em vez de importar `node:crypto`
(`contracts/analysis-event.ts:230`). O único I/O real do pacote são o `fetch` e o
`AbortController` do adaptador Ollama (`adapters/llm/ollama-provider.ts:63,70`).

&emsp; A consequência prática aparece na Seção 6: os 107 testes rodam sem AWS,
sem rede e sem banco, porque só existe **um** ponto a substituir por um duplo.

### 2.2 Organização de pastas

```text
apps/backend/agentic/
├── src/
│   ├── contracts/analysis-event.ts     envelope da fila e identidade da execução
│   ├── domain/
│   │   ├── ml-result.ts                saída dos modelos, escalas e limiares
│   │   ├── diagnosis.ts                estados, hipóteses, motivos
│   │   ├── quality-gate.ts             decide se vale investigar
│   │   ├── response-validation.ts      interpreta e ancora a resposta do modelo
│   │   ├── outcome.ts                  piso de confiança e ordenação
│   │   └── evidence.ts                 entrada da investigação
│   ├── application/investigate.ts      orquestração completa
│   ├── prompts/                        rca-v1, rca-v2 e o contrato de template
│   ├── ports/                          LlmProvider e AgenticDiagnosisPort
│   ├── adapters/llm/                   ollama, bedrock, fake
│   ├── bootstrap/                      seleção de provider na inicialização
│   └── index.ts                        superfície pública
├── tests/                              10 arquivos, 107 testes
└── scripts/eval-ollama.ts              avaliação contra modelo real
```

&emsp; A pasta não organiza por tipo de arquivo, e sim **por distância da
decisão**. Cada uma responde a uma pergunta diferente:

| Pasta | Pergunta que responde | Por que está separada |
|:--|:--|:--|
| `domain/` | *quais são as regras?* | funções puras, sem I/O; é o que tem de sobreviver a qualquer troca de banco, fila ou modelo |
| `application/` | *em que ordem as regras rodam?* | `investigate()` é o roteiro; separá-lo do domínio permite testar regra isolada e roteiro isolado |
| `contracts/` | *o que chega de fora e é confiável?* | fronteira de entrada: valida o envelope da fila antes que qualquer regra o veja |
| `prompts/` | *o que exatamente pedimos ao modelo?* | o texto do prompt é versionado e comparado por medição (4.11); tratá-lo como código, e não como string solta, é o que permite a comparação v1 × v2 |
| `ports/` | *de que o miolo precisa?* | contrato puro; é a costura do hexágono |
| `adapters/` | *como se fala com cada mundo externo?* | protocolo, autenticação e formato ficam confinados aqui |
| `bootstrap/` | *qual implementação concreta usar?* | raiz de composição: um único lugar onde a decisão é tomada, na inicialização, quando o erro ainda aparece no log de boot (4.10) |

&emsp; `src/index.ts` é a superfície pública: quem integra importa daí, e não de
caminhos internos, para que reorganização interna não quebre consumidor.

&emsp; O mesmo diretório hospeda um segundo pacote, em Python: o
`view_show_agentic`, que fornece os hooks de observabilidade — spans, métricas e
logs — que o futuro Worker de Análise deve usar. Os dois não se importam: o
núcleo continua sem dependência, e a telemetria só passa a produzir dado quando
o worker existir e invocar os hooks.

&emsp; `tests/` tem um arquivo por unidade exercitada, com o mesmo nome do
arquivo de `src/` que ele cobre. `scripts/` fica fora de `src/` e de `tests/`
porque avaliação não é teste: ela chama modelo real, custa minutos e não roda no
CI.

### 2.3 Tecnologias, e por que cada uma

| Tecnologia | Onde | Por que esta |
|:--|:--|:--|
| **TypeScript 5.6**, modo estrito | todo o pacote | `strict`, `exactOptionalPropertyTypes` e `noUncheckedIndexedAccess` ligados. O domínio é quase todo *tipo*: estados de diagnóstico, união de sinais de ML, motivos de reprovação. Com essas opções, um estado novo não compilado em todos os pontos vira erro de compilação, e não hipótese errada na tela |
| **Node.js ≥ 20**, ESM nativo | `type: module`, `module: node16` | é o runtime do resto do backend; ESM com extensão `.js` explícita no import mantém o pacote consumível tanto compilado quanto por ferramenta de bundle |
| **`node:test` + `node:assert/strict`** | os 10 arquivos de `tests/` | runner nativo do Node. Os testes não importam **nenhuma** biblioteca externa — sem Jest, sem Vitest, sem Chai. Uma camada cujo valor é não ter dependência não podia carregar um framework de teste inteiro só para rodar asserção |
| **Zero dependências de runtime** | `package.json` | o pacote não declara bloco `dependencies` nenhum; em `devDependencies` há só `typescript` e `@types/node`. Sem Express, sem DynamoDB, sem SDK da AWS. É o que permite a esta camada ser importada por qualquer backend sem arrastar versão de biblioteca junto |
| **`fetch` nativo + `AbortController`** | `adapters/llm/ollama-provider.ts` | cliente HTTP embutido no Node; um `axios` da vida seria dependência de runtime por nada. O `AbortController` dá o tempo limite, e estouro de tempo vira exceção — nunca sucesso duvidoso (4.9) |
| **Ollama**, API HTTP | provider real desta fase | escolhido **por necessidade, não por preferência**: o Bedrock está bloqueado na conta do AWS Academy. Num acionamento assíncrono a latência de um modelo local deixa de pesar, porque ninguém espera na tela |
| **AWS Bedrock**, API **Converse** | provider de produção | Converse e não `InvokeModel`: o código anterior montava `anthropic_version` à mão, o que prendia a camada a modelos Anthropic. E o SDK **não** é dependência: o adaptador recebe a função `converse` pronta, e quem integra faz a ligação |
| **Provider `fake`** | só em `NODE_ENV=test` | duplo determinístico para os testes; a fábrica recusa construí-lo fora de teste (4.10) |

&emsp; O que **não** foi usado é tão deliberado quanto o que foi: não há
framework de injeção de dependência (a raiz de composição é uma função), não há
ORM (a camada não persiste nada, Seção 5), e não há biblioteca de validação de
schema (`contracts/` e `domain/` validam com código próprio, para não adicionar
dependência de runtime à única coisa que precisa rodar dentro de qualquer
backend).

## 3. Fluxo de investigação

```text
sinal de ML
  → gate de qualidade ──── reprova ──→ diagnóstico `pending` com motivos
  → caso curado? ───────── existe ──→ diagnóstico `ready`, sem acionar modelo
  → prompt versionado
  → provider de LLM ────── erro ────→ diagnóstico `failed`
  → validação e ancoragem ─ inválida ─→ diagnóstico `failed`
  → ordenação por confiança
  → diagnóstico `ready` para revisão humana
```

&emsp; `investigate()` **não lê e não escreve nada** — nem através de porta.
Recebe o pacote pronto e devolve o diagnóstico; quem integra faz
`ler → investigate → gravar` em volta dele.

## 4. Decisões do projeto

### 4.1 A integração é um adaptador, não uma renegociação de contrato

&emsp; O `AgenticDiagnosisPort` daqui tem assinatura **idêntica** ao port que a
API já deixou reservado em
`apps/backend/api/src/modules/incidents/ports/incident-repository.ts`, marcado lá
como *"reserved consumer boundary for the future agentic PR"*. O mesmo vale para
o `ReviewFeedbackPort`. Encaixar é escrever um adaptador, não renegociar
contrato.

&emsp; `requestDiagnosis` devolve `"accepted"`, e não o diagnóstico: o
acionamento é assíncrono por construção e nada bloqueia esperando o modelo. Quem
chama registra que pediu e lê o resultado depois.

&emsp; Persistência, transporte e provisionamento ficam do lado de quem integra
— a camada não depende do repositório (2.3).

### 4.2 Não existe score de anomalia normalizado

&emsp; O [notebook de ML](../../../extras/notebooks/argus_algoritmo.ipynb)
produz quatro saídas em escalas incomparáveis: z robusto por mediana e MAD,
pontuação de episódio sem teto superior, distância de Mahalanobis, e risco
previsto de QoE. As palavras `confidence` e `anomalyScore` não aparecem nele
nenhuma vez.

&emsp; Por isso todo sinal carrega o **limiar contra o qual foi comparado**, e a
única comparação válida entre detectores é `relativeMargin()`, que mede cada um
contra a própria régua: um z de 6 contra limiar 4 e uma distância de 30 contra
limiar 20 estão ambos 50% além do normal, apesar de escalas incomparáveis.

### 4.3 O gate de qualidade vem antes de qualquer chamada paga

&emsp; O detector do notebook tem recall de 100% sobre os quatro incidentes
avaliáveis e falso positivo de 71% (série isolada) a 63% (multivariado). Sem
gate, aproximadamente dois terços dos disparos consumiriam inferência para
diagnosticar ruído.

&emsp; O gate é função pura e devolve **todos** os motivos de reprovação, não o
primeiro: quem lê um diferimento precisa corrigir tudo de uma vez, não
descobrir o próximo impedimento a cada nova tentativa.

&emsp; Dois limites vêm calibrados do notebook e não devem mudar sem refazer a
calibração — aquecimento de 3 dias e mínimo de 96 pontos. Os outros dois são
política operacional nossa, e estão marcados como tal no código.

### 4.4 Diferir não é o mesmo que não concluir

&emsp; O gate reprova **antes** do modelo; o piso de confiança avalia **depois**.
Os dois estados existem separados porque o custo é diferente: um evita a
chamada, o outro qualifica a resposta.

&emsp; A camada nunca declara "inconclusivo". Por
[`analise-e-ia.md`](../../analise-e-ia.md) §9, inconclusivo é veredito
**humano** sobre uma hipótese. Quando nada alcança o piso, as hipóteses fracas
ainda vão para revisão, com a ressalva `BELOW_CONFIDENCE_FLOOR` anexada.

### 4.5 A ancoragem em evidência é a defesa contra injeção de prompt

&emsp; Evidência vem de log, alerta e título de incidente — sistemas que o time
não controla. Um texto plantado ali pode convencer o modelo a afirmar qualquer
coisa. O que ele **não** consegue é citar um identificador de evidência que
exista de verdade no pacote carregado.

&emsp; A defesa real não é a instrução no prompt, e sim a validação: toda
hipótese precisa apontar para evidência real, e a que não aponta é descartada
independentemente do que afirme. O bloco delimitado no prompt é a primeira
barreira; a validação é a garantia.

&emsp; Quando parte das hipóteses é descartada, os motivos viajam junto mesmo
no caminho de sucesso. Descartar em silêncio esconderia exatamente o sinal de
ataque.

### 4.6 O modelo não escreve `id` nem `rank`

&emsp; Identificador é derivado da posição, ranque é a ordem por confiança.
Deixar o modelo inventar identificador convida colisão; deixá-lo numerar o
ranque convida sequência furada. Erros que não podem acontecer se ele nunca
escreve esses campos.

### 4.7 Score do detector e confiança do agente nunca se misturam

&emsp; Um mede quão anômalo é o sinal; o outro, quanto o agente acredita
naquela explicação. Ficam em campos separados, e é isso que permite auditar
depois se o agente concordou ou discordou do modelo.

### 4.8 Falha de contrato do evento é sempre permanente

&emsp; `parseAnalysisEvent` devolve `permanent: true` em toda rejeição, conforme
§4: campo obrigatório ausente, versão incompatível ou janela inválida vão
direto à DLQ. Reprocessar não conserta contrato quebrado; apenas queima as cinco
tentativas antes de chegar ao mesmo lugar. Os metadados que acompanham a
mensagem à DLQ levam só identificadores, porque o escopo do payload pode
carregar dimensões vindas de telemetria.

&emsp; A identidade da execução vem da `idempotencyKey`, nunca do `eventId`: uma
republicação técnica preserva a primeira e troca o segundo, e deduplicar pelo
`eventId` reprocessaria a mesma análise.

### 4.9 Nenhum adaptador devolve sucesso duvidoso

&emsp; HTTP de erro, corpo que não é JSON, conteúdo vazio e tempo limite viram
exceção, que a orquestração traduz em `failed`. Um adaptador que engolisse isso
faria o diagnóstico quebrar mais tarde, em outro lugar, com mensagem que não
aponta para a causa.

&emsp; Resposta cortada segue a mesma lógica, com a divisão de trabalho da porta:
o adaptador apenas **reporta** por que a geração parou (`stopReason`), e quem
**decide** é a validação — `stopReason: "length"` vira `TRUNCATED` e o caso
falha (`domain/response-validation.ts:94`), em vez de virar diagnóstico parcial.
Meia hipótese é pior que nenhuma.

&emsp; O adaptador Bedrock recebe a função `converse` pronta, sem importar o SDK
da AWS; a escolha da API Converse e o motivo de o SDK não ser dependência estão
em 2.3.

### 4.10 O provider falso é recusado fora de teste

&emsp; Um duplo determinístico que vaze para produção não quebra — ele responde,
e a tela mostra um diagnóstico inventado com aparência de real. É a pior classe
de falha possível aqui. A fábrica de providers recusa `fake` quando o ambiente
não é `test`, na inicialização, quando o erro ainda aparece no log de boot.

### 4.11 Prompts são versionados e coexistem

&emsp; A versão fica gravada em todo diagnóstico (`model.promptVersion`). Sem
isso, uma mudança de redação torna impossível saber se a qualidade caiu por
causa do modelo, do dado ou do texto que pedimos. `rca-v1` e `rca-v2` coexistem;
a v2 é o padrão de `investigate()` desde 09/09/2026, com base na comparação
medida registrada em [`avaliacao-modelos.md`](avaliacao-modelos.md).

## 5. O que a camada não faz, e por quê

| Fora de escopo | Motivo |
|:--|:--|
| Persistir qualquer coisa | o hospedeiro que grava é o Worker de Análise, que ainda não existe |
| Estado da execução (§5: `PROCESSING`, `RETRY_PENDING`, `SUCCEEDED`, `FAILED`) | persistência com escrita condicional; a camada fornece o `analysisRunId` que isso exige |
| Consumir SQS | responsabilidade do Worker de Análise |
| Detectar anomalia ou prever QoE | responsabilidade dos modelos de ML |
| Promover caso ao conjunto de referência | escrita exclusiva da revisão humana (§10, ADR-002/005) |
| Checar qualidade da prosa gerada | **lacuna conhecida** — ver 6.3 |

## 6. Verificação

### 6.1 Testes automatizados

&emsp; 107 testes, sem AWS, sem rede e sem banco. Os testes de integração sobem
um servidor HTTP local que fala o protocolo do Ollama, exercitando socket,
`fetch` e serialização reais; o único faz-de-conta é o modelo.

```bash
cd apps/backend/agentic
npm install
npm run verify        # typecheck + testes
```

&emsp; `npm run verify` é `typecheck` seguido de `test`, e `test` compila antes
de rodar. Falha de tipo derruba a verificação antes de qualquer teste executar.

### 6.2 Avaliação com modelo real

&emsp; Teste automatizado prova que o código faz o que foi escrito. Só a
execução contra um modelo real mostra se o que foi escrito serve. O avaliador
roda cinco casos — incidente claro, **injeção de prompt plantada na evidência**,
evidência fraca, previsão preventiva e caso sem evidência — e confere por fora
que nenhuma evidência inexistente chegou ao resultado.

```bash
# Ollama no servidor; avaliador local, ligados por túnel SSH
ssh -f -N -L 11434:127.0.0.1:11434 <usuario>@<servidor>

cd apps/backend/agentic
RCA_PROMPT=v2 OLLAMA_MODEL=gemma4:12b npm run eval:ollama
```

| Parâmetro | Padrão | Para que serve |
|:--|:--|:--|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | endereço do Ollama |
| `OLLAMA_MODEL` | `llama3.1` | modelo avaliado |
| `OLLAMA_MAX_TOKENS` | `4000` | teto da resposta |
| `OLLAMA_TEMPERATURE` | `0` | decodificação gulosa, execução reprodutível |
| `RCA_PROMPT` | `v1` | versão do prompt (`v1` ou `v2`) |

&emsp; **Atenção ao validar:** o avaliador cai em `v1` quando `RCA_PROMPT` não é
informado, enquanto `investigate()` usa `v2` por padrão. Medir a versão que está
em produção exige passar `RCA_PROMPT=v2` explicitamente.

&emsp; Os três achados que mudaram o projeto, com o resultado completo,
recomendação de modelo e limitações em
[`avaliacao-modelos.md`](avaliacao-modelos.md):

1. **Nenhum modelo obedeceu à injeção de prompt** plantada na evidência, nos
   dois modelos e nas duas versões de prompt. A ancoragem não precisou entrar em
   ação — mas continua sendo a garantia, porque obediência do modelo é
   observação, não propriedade.
2. **A calibração de confiança separa os modelos de forma decisiva.** Sobre a
   mesma evidência fraca, um devolveu 0,30 e o outro 0,80. Isso torna o piso de
   confiança um critério de **seleção de modelo**, e não um parâmetro ajustável
   depois.
3. **A latência medida de 29 a 134 segundos por caso** em GPU L4 dedicada
   confirma que o acionamento precisa ser assíncrono. É medição, não estimativa.

### 6.3 Lacuna conhecida da verificação

&emsp; A validação garante **estrutura e ancoragem**, não **qualidade de texto**.
Numa das execuções, o modelo produziu uma explicação com a frase truncada no
meio, emendando um timestamp. Aquela resposta passa pelo validador, porque cita
evidência existente e tem todos os campos, e chegaria assim à tela.

## 7. Implantação na AWS

&emsp; A camada é biblioteca, não serviço. O destino de implantação está
definido em [`analise-e-ia.md`](../../analise-e-ia.md) §2 — ela é *"um módulo
interno do Worker de Análise"*, e não um serviço implantável separado.

&emsp; Três impedimentos existem hoje, e nenhum deles depende desta camada:

| Impedimento | Situação |
|:--|:--|
| **Nenhum modelo disponível na AWS** | Bedrock bloqueado no Learner Lab, conforme registrado no próprio [`variables.tf`](../../../../apps/fullstack/variables.tf); ECS Fargate não oferece GPU. Medimos 29 a 134 s por caso em L4 dedicada; em CPU seria várias vezes isso. Subir hoje colocaria no ar algo que não produz diagnóstico: todo caso terminaria em `failed`. |
| **Não existe fila** | Nenhum recurso SQS ou EventBridge no Terraform. O evento que dispara a análise não tem por onde chegar. |
| **Não existe o Worker de Análise** | A camada precisa de um hospedeiro que consuma a fila, leia o DynamoDB e grave o resultado. |

&emsp; O primeiro é o mais grave porque não se resolve com decisão interna:
depende de liberação do Bedrock na conta ou de acesso a instância com GPU. Os
outros dois são trabalho de infraestrutura e de aplicação, já especificados pelo
documento normativo.

## 8. Pendências

| Item | Depende de |
|:--|:--|
| Adaptador `ler → investigate → gravar` | Worker de Análise |
| Estado da execução com escrita condicional (§5) | mesmo hospedeiro |
| Worker de Análise e fila SQS | infraestrutura |
| Provider de LLM em produção | liberação do Bedrock ou GPU |
| `rca-v3` — regra de causa ≠ consequência como restrição definicional | avaliação com mais execuções por configuração |
| Checagem de sanidade da prosa antes de exibir | ver 6.3 |

## 9. Alinhamento com a fonte normativa

| [`analise-e-ia.md`](../../analise-e-ia.md) | Implementação |
|:--|:--|
| §4.1 envelope comum | `contracts/analysis-event.ts` |
| §4.2 `QOE_FORECAST` | `QoeForecastSignal` com `riskScore`, `predictedValue`, `targetWindow` |
| §4.3 `REANALYSIS_REQUESTED` | tipo de gatilho e validação de payload |
| §5 `analysisRunId` determinístico | `analysisRunId(evento, hash)` |
| §6 MAD e Mahalanobis, com score, limiar e versão | união de `MlSignal` |
| §8 `datasetVersion` em toda execução | recebido no evento e propagado ao diagnóstico |
| §9 acionar só com qualidade mínima | `quality-gate.ts` |
| §9 validar formato, associar evidências, ordenar por confiança | `response-validation.ts` e `outcome.ts` |
| §9 hipótese nasce `PENDING` até revisão humana | `reviewStatus` |
| §10 estados do diagnóstico | `pending`, `processing`, `ready`, `failed` |
| §10 worker lê o conjunto de referência mas não promove | `goldenCase` entra pronto e nunca é escrito |
| §11 indisponibilidade não produz hipótese artificial | erro de provider vira `failed`, sem template |

&emsp; O último item **supera a ADR-004**, que exigia fallback por template. O
documento normativo proíbe hipótese artificial, e a implementação segue o
documento.
