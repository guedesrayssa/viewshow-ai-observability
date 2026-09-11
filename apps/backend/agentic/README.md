# Agentic layer — runtime not implemented, observability ready

Ownership: futuro time da camada agêntica.

O código agêntico legado foi removido do runtime. Este diretório registra apenas
o limite reservado para a implementação futura do Worker de Análise definido
em `artefatos/arquitetura/analise-e-ia.md`.

A integração futura ocorre pelos ports consumidores `AgenticDiagnosisPort` e
`ReviewFeedbackPort`. Esta entrega não contém agente novo, prompt, algoritmo,
execução Bedrock nem servidor fake. O módulo `incidents` da API apenas lê
diagnósticos persistidos e declara `AGENTIC_RESULT_UNAVAILABLE` quando não
existem.

## Contrato de observabilidade

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
`python3.13 -m unittest discover -s tests`. Ainda não há consumidor SQS nem lógica
agêntica neste diretório: métricas e traces começam a aparecer apenas quando o
futuro worker importar e invocar estes hooks.
