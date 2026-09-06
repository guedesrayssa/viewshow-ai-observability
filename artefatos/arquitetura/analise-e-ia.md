# Análise de dados e diagnóstico por IA

- **Status:** aprovado para implementação
- **Versão:** 1.0
- **Última atualização:** 06/09/2026
- **Responsáveis:** equipe de análise de dados e IA
- **Região AWS:** `us-east-1`

## 1. Objetivo e escopo

Este documento define como o View Show transforma janelas já materializadas no
DynamoDB em previsões, incidentes, evidências e hipóteses diagnósticas. Ele é a
fonte normativa do contrato da fila de análise, da execução dos modelos, da
orquestração do diagnóstico e da recuperação de falhas.

O Worker de Análise não ingere registros diretamente do ARGUS. Ele recebe pela
SQS apenas uma referência à janela que deve processar e consulta os dados no
DynamoDB. A ingestão continua responsável pela normalização e pela persistência
dos fatos e das projeções de entrada.

## 2. Componentes e responsabilidades

```text
SQS de Análise
  → Worker de Análise
      → detector de anomalias
      → modelo de previsão de QoE
      → orquestrador de análise
          → DynamoDB operacional
          → conjunto de referência
          → agente diagnóstico
              → Amazon Bedrock
```

- O Worker valida mensagens, controla idempotência e registra cada execução.
- O detector identifica anomalias em janelas de 15 minutos.
- O modelo de previsão estima o risco da hora seguinte.
- O orquestrador decide quando existem dados suficientes para investigar.
- O agente diagnóstico prepara o contexto e estrutura hipóteses candidatas.
- O Bedrock auxilia na geração das explicações, mas não confirma a causa raiz.
- O Backend registra a decisão humana e promove somente hipóteses confirmadas.

O orquestrador é um módulo interno do Worker de Análise. Ele não precisa de um
repositório ou serviço implantável separado na primeira versão.

## 3. Frequência das análises

A análise reativa executa quando a ingestão publica uma nova janela completa de
15 minutos. A previsão preventiva executa quando existe uma nova janela horária
completa. Não é necessário um segundo agendamento independente: a publicação da
ingestão informa exatamente qual janela já está disponível.

| Tipo | Frequência | Evento | Resultado principal |
| --- | --- | --- | --- |
| Detecção reativa | 15 minutos | `ANOMALY_DETECTION` | evidência e possível incidente |
| Previsão preventiva | 1 hora | `QOE_FORECAST` | previsão de risco para a hora seguinte |
| Reanálise | sob demanda | `REANALYSIS_REQUESTED` | nova execução para um incidente existente |

Uma previsão não é registrada como incidente observado. Ela pode produzir uma
hipótese preventiva quando o risco ultrapassar o limiar. Um incidente é criado
ou atualizado somente quando uma anomalia efetivamente observada sustenta essa
decisão.

## 4. Contrato da SQS

A fila é `SQS Standard`. Portanto, o consumidor deve tolerar duplicidade e
entrega fora de ordem. A mensagem transporta identificadores e referências;
fatos ou séries extensas permanecem no DynamoDB ou no S3.

### 4.1 Envelope comum

```json
{
  "eventId": "evt_01K2F8BAYX",
  "eventType": "ANOMALY_DETECTION",
  "schemaVersion": "1.0",
  "idempotencyKey": "ana_01K2F8BAYX",
  "traceId": "trc_01K2F8BAYX",
  "occurredAt": "2026-09-06T15:00:00.000Z",
  "producedAt": "2026-09-06T15:01:12.000Z",
  "source": "data-ingestion-service",
  "payload": {
    "window": {
      "start": "2026-09-06T14:45:00.000Z",
      "end": "2026-09-06T15:00:00.000Z",
      "grainSeconds": 900
    },
    "scope": {
      "kind": "global",
      "dimensions": {}
    },
    "inputWatermark": "2026-09-06T15:00:00.000Z",
    "datasetVersion": "dsv_01K2F8BAYX"
  }
}
```

Campos obrigatórios:

- `eventId`: identidade da publicação, preservada em novas tentativas;
- `eventType`: operação solicitada;
- `schemaVersion`: versão do contrato da mensagem;
- `idempotencyKey`: identidade da execução lógica;
- `traceId`: correlação entre ingestão, análise e API;
- `occurredAt`: instante de negócio que originou a solicitação;
- `producedAt`: instante em que a mensagem foi criada;
- `payload.window`: janela que já pode ser consultada;
- `inputWatermark`: versão publicada da entrada;
- `datasetVersion`: conjunto de dados utilizado pela análise.

Mensagem sem campo obrigatório, com versão incompatível ou janela inválida é
considerada erro permanente e enviada à DLQ com metadados sanitizados.

### 4.2 Previsão de QoE

`QOE_FORECAST` utiliza uma janela horária completa e acrescenta:

```json
{
  "model": {
    "name": "qoe-forecast",
    "version": "2026.09.1"
  },
  "targetWindow": {
    "start": "2026-09-06T16:00:00.000Z",
    "end": "2026-09-06T17:00:00.000Z"
  }
}
```

### 4.3 Reanálise

`REANALYSIS_REQUESTED` não modifica a execução anterior. Seu payload contém
`incidentId`, `requestedBy`, `reason` e uma nova `idempotencyKey`. A identidade
do solicitante vem da sessão validada pelo Backend.

## 5. Idempotência e estado da execução

O `analysisRunId` é determinístico para uma execução lógica:

```text
analysisRunId = hash(eventType + idempotencyKey)
```

Estado persistido:

```text
PK = ANALYSIS#RUN#<analysisRunId>
SK = META
```

Estados possíveis:

```text
PROCESSING
RETRY_PENDING
SUCCEEDED
FAILED
```

Ao receber uma duplicata, o Worker executa `GetItem` com a chave determinística.
Uma execução `SUCCEEDED` faz a mensagem ser confirmada sem novo processamento.
Uma execução incompleta é retomada a partir da última etapa persistida. A
transição de estado utiliza escrita condicional para impedir dois consumidores
de concluírem a mesma execução simultaneamente.

Cada registro preserva `eventId`, `traceId`, tipo, janela, tentativa, versão do
modelo, versão do detector, watermark de entrada, dataset e timestamps das
etapas.

## 6. Detecção reativa

O detector consulta a janela atual, o histórico e o baseline por meio de
`Query`. A primeira versão combina:

- desvio absoluto mediano (MAD) para séries individuais;
- distância de Mahalanobis para variáveis correlacionadas.

O resultado contém score, limiar, sinais afetados, versão do detector e
qualidade da entrada. A ausência de anomalia encerra a execução sem criar um
incidente. Quando o limiar é ultrapassado, o orquestrador procura um incidente
ativo correlacionável. Se encontrar, adiciona uma evidência; caso contrário,
cria um incidente com escrita condicional.

O resultado estatístico é evidência, não prova de causalidade. Correlação
temporal isolada não autoriza afirmar que uma alteração causou o incidente.

## 7. Previsão preventiva

O modelo utiliza a janela horária atual, valores anteriores, médias móveis,
sessões, erros e variáveis de calendário. A saída mínima é:

```json
{
  "predictedValue": 0.083,
  "riskScore": 0.81,
  "riskLevel": "ELEVATED",
  "threshold": 0.70,
  "modelVersion": "2026.09.1",
  "targetWindow": {
    "start": "2026-09-06T16:00:00.000Z",
    "end": "2026-09-06T17:00:00.000Z"
  }
}
```

Persistência principal:

```text
PK = PREDICTION#<predictionId>
SK = META

PK = VIEW#PREDICTIONS#DAY#<YYYYMMDD>
SK = TARGET#<epochMs>#<predictionId>
```

Antes de gerar uma nova previsão, o Worker avalia a previsão cuja janela-alvo
acabou de terminar. Quando os dados observados estão completos, o resultado é
classificado como `TP`, `FP`, `TN` ou `FN`. Dados insuficientes após a tolerância
geram `UNKNOWN` e `validationStatus = UNAVAILABLE`.

## 8. Dataset importado e versionamento

Cada importação concluída recebe um `datasetVersion` derivado do `importId`, do
checksum do dump e do watermark produzido. O dump permanece no S3 conforme a
política de retenção, enquanto os registros normalizados são gravados no
DynamoDB.

Previsões, detecções e avaliações sempre registram o `datasetVersion`. Dessa
forma, uma análise feita sobre um dump pode ser reproduzida e comparada com
outra versão sem confundir os resultados.

O treinamento e a avaliação de novos modelos ocorrem fora do fluxo online.
Somente um artefato previamente avaliado é disponibilizado ao Worker, com nome,
versão, checksum, métricas de avaliação e data de aprovação. A troca da versão
ativa não altera resultados históricos.

## 9. Orquestração e diagnóstico

O agente diagnóstico só é acionado quando existe risco elevado ou anomalia e a
qualidade mínima foi atendida. O orquestrador reúne:

- janela atual e histórico relevante;
- métricas e dimensões que contribuíram para o sinal;
- erros e mudanças próximas no tempo;
- evidências já associadas ao incidente;
- casos humanos confirmados semelhantes;
- versões do dataset, detector e modelo.

Esse contexto é estruturado, limitado e sanitizado antes de ser enviado ao
Bedrock. O agente recebe hipóteses candidatas, valida o formato, associa cada
hipótese às evidências disponíveis e as ordena por confiança.

O resultado da IA permanece como hipótese `PENDING`. A interface deve deixar
claro que a causa raiz ainda não foi confirmada. Somente a decisão humana pode
alterar a hipótese para `CONFIRMED` ou `REFUTED`.

## 10. Persistência de incidentes e diagnósticos

```text
PK = INCIDENT#<incidentId>  SK = META
PK = INCIDENT#<incidentId>  SK = EVIDENCE#<evidenceId>
PK = INCIDENT#<incidentId>  SK = DIAGNOSIS#<diagnosisId>
PK = INCIDENT#<incidentId>  SK = HYPOTHESIS#<hypothesisId>
PK = INCIDENT#<incidentId>  SK = TIMELINE#<timestamp>#<itemId>
```

Estados do diagnóstico:

```text
PENDING       dados insuficientes ou aguardando processamento
PROCESSING    investigação automática em andamento
READY         hipóteses disponíveis para revisão
FAILED        investigação interrompida sem apagar as evidências
```

O Worker de Análise pode ler o conjunto de referência, mas não pode promovê-lo
ou alterá-lo. O Backend possui a permissão de escrita usada pela revisão
humana. A confirmação atualiza a hipótese, registra auditoria, salva a resposta
idempotente e cria o caso de referência em uma única transação.

## 11. Falhas, novas tentativas e DLQ

Configuração inicial:

| Configuração | Valor |
| --- | ---: |
| Tempo de invisibilidade | 5 minutos |
| Renovação durante processamento | 60 segundos |
| Máximo de recebimentos | 5 |
| Retenção da fila principal | 4 dias |
| Retenção da DLQ | 14 dias |
| Long polling | 20 segundos |

Falhas transitórias utilizam espera progressiva de 30 segundos, 2 minutos, 5
minutos e 15 minutos. Após o quinto recebimento sem sucesso, a política de
redrive da SQS envia a mensagem à DLQ e o CloudWatch dispara um alarme.

Resultados intermediários permanecem no DynamoDB. Uma indisponibilidade do
Bedrock não remove previsão, incidente ou evidência e não produz hipótese
artificial. Erros permanentes de contrato seguem diretamente para a DLQ.

O reenvio técnico preserva `eventId` e `idempotencyKey`. Uma reanálise solicitada
pelo usuário cria uma nova chave, pois representa outra execução lógica.

## 12. Segurança e privacidade

- O Worker executa em sub-redes privadas e não oferece porta pública.
- A role permite consumir a fila, consultar e atualizar os itens autorizados e
  ler o conjunto de referência.
- Somente o Backend pode gravar decisões humanas no conjunto de referência.
- Payloads enviados ao Bedrock não contêm credenciais, tokens ou PII desnecessária.
- Logs não armazenam o prompt completo quando ele puder conter dado operacional
  sensível.
- A versão do modelo e as evidências usadas são registradas para auditoria.

## 13. Observabilidade

Logs e métricas usam `traceId`, `analysisRunId`, `eventId`, `incidentId`, etapa,
tentativa, duração e versões. Alarmes mínimos:

- mensagem na DLQ;
- fila envelhecendo além da janela esperada;
- ausência de detecção bem-sucedida por 30 minutos;
- ausência de previsão bem-sucedida por duas horas;
- aumento de falhas do Bedrock;
- execução presa sem renovação da visibilidade;
- taxa de `UNKNOWN` acima do limite acordado.

## 14. Critérios de conformidade

Uma implementação está conforme quando:

- consome somente janelas publicadas pela ingestão;
- trata duplicidade e entrega fora de ordem;
- nunca usa `Scan` no caminho operacional;
- distingue previsão de incidente observado;
- registra versões do dataset, modelo e detector;
- preserva resultados intermediários diante de falhas;
- não apresenta hipótese de IA como causa confirmada;
- restringe a promoção ao conjunto de referência à revisão humana;
- permite rastrear ingestão, análise e resposta da API pelo `traceId`;
- recupera mensagens transitórias e preserva falhas permanentes na DLQ.

## 15. Documentos relacionados

- [Visão geral da arquitetura](visao-geral.md)
- [Ingestão e dados](ingestao-e-dados.md)
- [API do dashboard](api-dashboard.md)
- [Fluxos integrados](fluxos.md)
- [Status de implementação](status-implementacao.md)
