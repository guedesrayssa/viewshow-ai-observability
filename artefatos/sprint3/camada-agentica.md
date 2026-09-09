# Camada agêntica — análise de causa raiz

- **Status:** implementada e avaliada; integração e implantação pendentes
- **Versão:** 1.0
- **Última atualização:** 09/09/2026
- **Código:** [`apps/backend/agentic`](../../apps/backend/agentic)
- **Fonte normativa:** [`analise-e-ia.md`](../arquitetura/analise-e-ia.md) v1.1

## 1. O que é

&emsp; A camada agêntica decide **se um sinal de aprendizado de máquina merece
investigação** e, quando merece, produz **hipóteses de causa raiz ancoradas em
evidência**. Ela ocupa a caixa "agente diagnóstico" do fluxo definido em
[`analise-e-ia.md`](../arquitetura/analise-e-ia.md) §2, entre o orquestrador de
análise e o modelo de linguagem.

&emsp; Ela **não** detecta anomalias, não prevê degradação e não decide o que é
incidente. Isso é dos modelos de ML, cujo resultado ela recebe pronto.

## 2. Por que é um módulo isolado

&emsp; Quando o trabalho começou, duas reescritas do backend estavam em curso
simultaneamente e divergindo: `develop` e `refactor/backend`, esta última
convertendo a API para microsserviços TypeScript e congelando o código agêntico
anterior fora do runtime. Amarrar a camada a qualquer uma das duas garantiria
retrabalho — como já havia acontecido com duas entregas anteriores, perdidas
porque a base mudou embaixo.

&emsp; A resposta foi construir a camada sem nenhuma dependência do
repositório: sem Express, sem DynamoDB, sem SDK da AWS. O `package.json`
declara `dependencies: {}`. Só há `typescript` e `@types/node` como
dependências de desenvolvimento.

&emsp; O diretório `apps/backend/agentic/` é o mesmo que a branch
`refactor/backend` reservou com a nota *"Ownership: futuro time da camada
agêntica"*, e o `AgenticDiagnosisPort` daqui tem assinatura idêntica ao port
declarado lá. A integração é um adaptador, não uma renegociação de contrato.

## 3. Estrutura

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
│   └── bootstrap/                      seleção de provider
├── tests/                              107 testes
└── scripts/eval-ollama.ts              avaliação contra modelo real
```

## 4. Fluxo de investigação

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
Recebe o pacote pronto e devolve o diagnóstico. Quem integra faz
`ler → investigate → gravar`. Consequência prática: a camada inteira é testável
com um único duplo, o do modelo de linguagem.

## 5. Decisões de projeto

### 5.1 Não existe score de anomalia normalizado

&emsp; O [notebook de ML](../extras/notebooks/argus_algoritmo.ipynb) produz
quatro saídas em escalas incomparáveis: z robusto por mediana e MAD, pontuação
de episódio sem teto superior, distância de Mahalanobis, e risco previsto de
QoE. As palavras `confidence` e `anomalyScore` não aparecem nele nenhuma vez.

&emsp; Por isso todo sinal carrega o **limiar contra o qual foi comparado**, e a
única comparação válida entre detectores é `relativeMargin()`, que mede cada um
contra a própria régua: um z de 6 contra limiar 4 e uma distância de 30 contra
limiar 20 estão ambos 50% além do normal, apesar de escalas incomparáveis.

### 5.2 O gate de qualidade vem antes de qualquer chamada paga

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

### 5.3 Diferir não é o mesmo que não concluir

&emsp; O gate reprova **antes** do modelo; o piso de confiança avalia **depois**.
Os dois estados existem separados porque o custo é diferente: um evita a
chamada, o outro qualifica a resposta.

&emsp; A camada nunca declara "inconclusivo". Por
[`analise-e-ia.md`](../arquitetura/analise-e-ia.md) §9, inconclusivo é veredito
**humano** sobre uma hipótese. Quando nada alcança o piso, as hipóteses fracas
ainda vão para revisão, com a ressalva `BELOW_CONFIDENCE_FLOOR` anexada.

### 5.4 A ancoragem em evidência é a defesa contra injeção de prompt

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

### 5.5 O modelo não escreve `id` nem `rank`

&emsp; Identificador é derivado da posição, ranque é a ordem por confiança.
Deixar o modelo inventar identificador convida colisão; deixá-lo numerar o
ranque convida sequência furada. Erros que não podem acontecer se ele nunca
escreve esses campos.

### 5.6 Score do detector e confiança do agente nunca se misturam

&emsp; Um mede quão anômalo é o sinal; o outro, quanto o agente acredita
naquela explicação. Ficam em campos separados, e é isso que permite auditar
depois se o agente concordou ou discordou do modelo.

### 5.7 Falha de contrato do evento é sempre permanente

&emsp; `parseAnalysisEvent` devolve `permanent: true` em toda rejeição, conforme
§4: campo obrigatório ausente, versão incompatível ou janela inválida vão
direto à DLQ. Reprocessar não conserta contrato quebrado; apenas queima as cinco
tentativas antes de chegar ao mesmo lugar.

&emsp; A identidade da execução vem da `idempotencyKey`, nunca do `eventId`: uma
republicação técnica preserva a primeira e troca o segundo, e deduplicar pelo
`eventId` reprocessaria a mesma análise.

### 5.8 O SDK da AWS não é dependência

&emsp; O adaptador Bedrock recebe uma função `converse` com interface estreita,
e quem integra faz a ligação. Assim o núcleo permanece sem dependência de
runtime, e não se carrega um SDK inteiro por um provider hoje bloqueado na
conta do laboratório.

&emsp; O adaptador usa a API **Converse**, não `InvokeModel`: o código anterior
montava `anthropic_version` à mão, o que prendia a camada a modelos Anthropic.

### 5.9 O provider falso é recusado fora de teste

&emsp; Um duplo determinístico que vaze para produção não quebra — ele responde,
e a tela mostra um diagnóstico inventado com aparência de real. É a pior classe
de falha possível aqui. A fábrica de providers recusa `fake` quando o ambiente
não é `test`, na inicialização, quando o erro ainda aparece no log de boot.

### 5.10 Prompts são versionados e coexistem

&emsp; A versão fica gravada em todo diagnóstico (`model.promptVersion`). Sem
isso, uma mudança de redação torna impossível saber se a qualidade caiu por
causa do modelo, do dado ou do texto que pedimos. `rca-v1` e `rca-v2` coexistem;
a v2 é o padrão desde 09/09/2026, com base na comparação medida registrada em
[`avaliacao-modelos-camada-agentica.md`](avaliacao-modelos-camada-agentica.md).

## 6. Alinhamento com a fonte normativa

| `analise-e-ia.md` | Implementação |
|:--|:--|
| §4.1 envelope comum | `contracts/analysis-event.ts` |
| §4.2 `QOE_FORECAST` | `QoeForecastSignal` com `riskScore`, `predictedValue`, `targetWindow` |
| §4.3 `REANALYSIS_REQUESTED` | tipo de gatilho e validação de payload |
| §5 `analysisRunId` determinístico | `analysisRunId(evento, hash)` |
| §6 MAD e Mahalanobis, com score, limiar e versão | união de `MlSignal` |
| §9 acionar só com qualidade mínima | `quality-gate.ts` |
| §9 validar formato, associar evidências, ordenar por confiança | `response-validation.ts` e `outcome.ts` |
| §9 hipótese nasce `PENDING` até revisão humana | `reviewStatus` |
| §10 estados do diagnóstico | `pending`, `processing`, `ready`, `failed` |
| §10 worker lê o conjunto de referência mas não promove | `goldenCase` entra pronto e nunca é escrito |
| §11 indisponibilidade não produz hipótese artificial | erro de provider vira `failed`, sem template |

&emsp; O último item **supera a ADR-004**, que exigia fallback por template. O
documento normativo proíbe hipótese artificial, e a implementação segue o
documento.

## 7. O que a camada não faz, e por quê

| Fora de escopo | Motivo |
|:--|:--|
| Persistir qualquer coisa | é o que ainda muda entre as branches do backend |
| Estado da execução (§5: `PROCESSING`, `RETRY_PENDING`, `SUCCEEDED`, `FAILED`) | persistência com escrita condicional; a camada fornece o `analysisRunId` que isso exige |
| Consumir SQS | responsabilidade do Worker de Análise |
| Detectar anomalia ou prever QoE | responsabilidade dos modelos de ML |
| Promover caso ao conjunto de referência | escrita exclusiva da revisão humana (§10, ADR-002/005) |
| Checar qualidade da prosa gerada | **lacuna conhecida** — ver seção 8.3 |

## 8. Verificação

### 8.1 Testes automatizados

&emsp; 107 testes, sem AWS, sem rede e sem banco. Os testes de integração sobem
um servidor HTTP local que fala o protocolo do Ollama, exercitando socket,
`fetch` e serialização reais; o único faz-de-conta é o modelo.

```bash
cd apps/backend/agentic
npm install
npm run verify        # typecheck + testes
```

### 8.2 Avaliação com modelo real

&emsp; Cinco casos executados contra `gemma4:12b` e `qwen2.5-coder:14b` em GPU
NVIDIA L4, nas duas versões de prompt. Resultado completo, recomendação de
modelo e limitações em
[`avaliacao-modelos-camada-agentica.md`](avaliacao-modelos-camada-agentica.md).

&emsp; Os três achados que mudaram o projeto: nenhum modelo obedeceu à injeção
de prompt plantada na evidência; a calibração de confiança separa os modelos de
forma decisiva, o que torna o piso de confiança um critério de **seleção de
modelo** e não um parâmetro ajustável; e a latência medida de 30 a 134 segundos
por caso confirma que o acionamento precisa ser assíncrono.

### 8.3 Lacuna conhecida

&emsp; A validação garante **estrutura e ancoragem**, não **qualidade de
texto**. Numa das execuções, o modelo produziu uma explicação com a frase
truncada no meio, emendando um timestamp. Aquela resposta passa pelo validador,
porque cita evidência existente e tem todos os campos, e chegaria assim à tela.

## 9. Implantação na AWS

&emsp; A camada é biblioteca, não serviço: não tem ponto de entrada, servidor
HTTP nem consumidor de fila. O destino de implantação está definido em
[`analise-e-ia.md`](../arquitetura/analise-e-ia.md) §2 — ela é *"um módulo
interno do Worker de Análise"*, e não um serviço implantável separado.

&emsp; Três impedimentos existem hoje, e **nenhum deles é a escolha entre
`develop` e `refactor/backend`**, que decide quem *lê* o diagnóstico e não quem
o *produz*:

| Impedimento | Situação |
|:--|:--|
| **Nenhum modelo disponível na AWS** | Bedrock bloqueado no Learner Lab, conforme registrado no próprio [`variables.tf`](../../apps/infra/variables.tf); ECS Fargate não oferece GPU. Medimos 30 a 134 s por caso em L4 dedicada; em CPU seria várias vezes isso. Subir hoje colocaria no ar algo que não produz diagnóstico: todo caso terminaria em `failed`. |
| **Não existe fila** | Nenhum recurso SQS ou EventBridge no Terraform. O evento que dispara a análise não tem por onde chegar. |
| **Não existe o Worker de Análise** | A camada precisa de um hospedeiro que consuma a fila, leia o DynamoDB e grave o resultado. |

&emsp; O primeiro é o mais grave porque não se resolve com decisão interna:
depende de liberação do Bedrock na conta ou de acesso a instância com GPU. Os
outros dois são trabalho de infraestrutura e de aplicação, já especificados pelo
documento normativo.

## 10. Pendências

| Item | Depende de |
|:--|:--|
| Adaptador `ler → investigate → gravar` | escolha entre `develop` e `refactor/backend` |
| Estado da execução com escrita condicional (§5) | mesma escolha |
| Worker de Análise e fila SQS | infraestrutura |
| Provider de LLM em produção | liberação do Bedrock ou GPU |
| `rca-v3` — regra de causa e consequência como restrição definicional | avaliação com mais execuções por configuração |
| Checagem de sanidade da prosa antes de exibir | ver 8.3 |
