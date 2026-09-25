# Camada agêntica

Ownership: futuro time da camada agêntica.

Dois pacotes convivem neste diretório com responsabilidades separadas:

| Pacote | Linguagem | O que é |
| --- | --- | --- |
| worker e núcleo de diagnóstico (`package.json`) | TypeScript | consome SQS, executa detecção e previsão, persiste resultados e produz hipóteses A′ ancoradas em evidência |
| `view_show_agentic` (`pyproject.toml`) | Python | biblioteca de hooks de observabilidade preservada para consumidores Python |

**A documentação completa do núcleo está em
[`artefatos/arquitetura/implementacao/camada-agentica/`](../../../artefatos/arquitetura/implementacao/camada-agentica/camada-agentica.md)**
— padrão arquitetural, organização de pastas, tecnologias, decisões de projeto,
verificação, implantação e pendências. Este arquivo é só o guia de quem vai
mexer no código. A fonte normativa de ambos é
[`artefatos/arquitetura/analise-e-ia.md`](../../../artefatos/arquitetura/analise-e-ia.md).

## Worker e núcleo de diagnóstico (TypeScript)

`investigate()` continua sendo um núcleo puro: recebe o pacote pronto e devolve
o diagnóstico. O runtime em `src/worker/` e `src/bootstrap/` liga esse núcleo ao
SQS, DynamoDB, S3, aos modelos determinísticos e ao provider de LLM.

```bash
npm install
python3.13 -m pip install -e '.[training]'
npm run verify   # typecheck + testes
```

Os testes não exigem uma conta AWS. Os testes de integração sobem um servidor
HTTP local que fala o protocolo do Ollama, enquanto os adaptadores AWS são
verificados também com DynamoDB Local quando `DYNAMODB_ENDPOINT` está definido.
O CI fornece esse endpoint. Para executar apenas essa integração localmente,
use `DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:integration` com um
DynamoDB Local descartável ativo.

### Integração

`AgenticDiagnosisPort` tem a mesma assinatura do port reservado em
`apps/backend/api/src/modules/incidents/ports/incident-repository.ts`, então o
encaixe é um adaptador e não uma renegociação de contrato. `requestDiagnosis`
devolve `"accepted"`, não o diagnóstico: o acionamento é assíncrono por
construção e nada bloqueia esperando o LLM.

### Providers

`ollama` é o provider real desta fase — o Bedrock está bloqueado na conta do AWS
Academy. `bedrock` usa a API Converse, e **o SDK da AWS não é dependência deste
pacote**: o adaptador recebe uma função `converse` com interface estreita, e quem
integra faz a ligação.

```ts
const client = new BedrockRuntimeClient({ region, maxAttempts: 4 });
const provider = createLlmProvider({
  kind: "bedrock",
  modelId,
  environment: process.env.NODE_ENV ?? "development",
  converse: (input) => client.send(new ConverseCommand(input)),
});
```

`fake` só é construído com `environment === "test"`; em qualquer outro a fábrica
lança na inicialização.

`none` desliga o LLM: o worker mantém a detecção e a previsão, e o diagnóstico é
registrado como falha permanente `LLM_DISABLED`, sem retentativa nem DLQ. É o
modo do Learner Lab, que não tem Bedrock.

### Avaliação com modelo real

Os testes automatizados provam que o código faz o que foi escrito. O avaliador
responde outra pergunta, que nenhum duplo consegue: um modelo de verdade,
recebendo o nosso prompt, produz diagnóstico utilizável — e obedece às regras
quando o dado tenta subvertê-las?

```bash
ollama serve                                              # noutro terminal
RCA_PROMPT=v2 OLLAMA_MODEL=gemma4:12b npm run eval:ollama
```

Cinco casos: incidente claro, **injeção de prompt plantada na evidência**,
evidência fraca, previsão preventiva e caso sem evidência. Resultado medido,
recomendação de modelo e limitações em
[`avaliacao-modelos.md`](../../../artefatos/arquitetura/implementacao/camada-agentica/avaliacao-modelos.md).

## Contrato de observabilidade (Python)

O pacote Python `view_show_agentic` já fornece os hooks que o futuro Worker de
Análise deve usar. Ele cobre processamento SQS, duração da investigação,
time-to-signal, fila/DLQ, invocações, latência, fallback e tokens do Bedrock,
além das métricas de golden set. Cada mensagem e chamada do modelo produz spans
correlacionados e logs JSON com redação de prompt, tokens e credenciais.

```python
from view_show_agentic import AgenticTelemetry

telemetry = AgenticTelemetry()
try:
    with telemetry.message(event_type, message_id):
        with telemetry.investigation("golden-set"):
            with telemetry.bedrock_invocation(model_id):
                invoke_model()
finally:
    telemetry.shutdown()
```

Configuração para a stack local:

```bash
export OTEL_SERVICE_NAME=view-show-agentic
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4320
export DEPLOYMENT_ENVIRONMENT=development
```

Os logs são escritos em JSON no `stdout`, sem chamadas de rede no caminho de
cada mensagem; o Alloy faz a coleta quando o worker roda em Docker. O
`BatchSpanProcessor` exporta spans em lote e `shutdown()` drena a telemetria ao
encerrar o processo. Reserve `force_flush()` para processos deliberadamente
curtos, não para o loop de consumo SQS.

O runtime de referência é Python 3.13, declarado em `.python-version`. Instale e
teste com `python3.13 -m pip install -e .` e
`python3.13 -m unittest discover -s tests`.

## Estado do runtime

O consumidor SQS, o worker, os adaptadores AWS e o ponto de entrada estão
implementados. O catálogo piloto de dez canais foi gerado, mas sua identidade
de séries ainda precisa ser adotada pela ingestão. O deploy continua
desabilitado até essa integração e a aprovação do bundle. O guia operacional está em
[`worker-analise.md`](../../../artefatos/arquitetura/implementacao/worker-analise.md)
e a primeira avaliação com o dump real está em
[`avaliacao-worker-argus.md`](../../../artefatos/arquitetura/implementacao/avaliacao-worker-argus.md).
