# Observabilidade do LLM com Ollama — desenho

## 1. Objetivo

Integrar a execução do LLM do worker de análise à pilha de observabilidade já
existente, sem criar uma segunda stack. A entrega deve permitir observar
chamadas ao Ollama por métricas e traces no Grafana, primeiro em ambiente local
e depois no ECS/AWS.

O trabalho não altera a responsabilidade do LLM: ele continua selecionando
hipóteses permitidas a partir de fatos preparados pelo worker. A integração
adiciona telemetria ao redor dessa chamada; não transfere decisão de negócio ao
Grafana nem ao OpenTelemetry.

## 2. Resultado esperado

Ao final da etapa local, uma chamada real ao Ollama através de túnel SSH deve
produzir:

- métricas consultáveis no Prometheus;
- spans consultáveis no Tempo;
- painéis preenchidos no Grafana;
- logs JSON no terminal local;
- nenhuma exposição de prompt, resposta bruta, evidência ou credencial.

Ao final da etapa AWS, o worker no ECS deve enviar métricas e traces ao Alloy na
EC2 de observabilidade, enviar logs ao CloudWatch e chamar o Ollama somente
depois que a conectividade entre a VPC e a rede institucional tiver sido
comprovada.

## 3. Contexto atual

O repositório já contém:

- worker agentic TypeScript com providers `ollama`, `bedrock` e `fake`;
- provider Ollama baseado em `POST /api/chat`;
- stack local Grafana, Prometheus, Loki, Tempo e Alloy;
- receptor OTLP/HTTP do Alloy para workers na porta `4320`;
- exportação de métricas do Alloy para Prometheus e traces para Tempo;
- stack equivalente em uma EC2 de observabilidade na AWS;
- regra de security group permitindo OTLP/HTTP dos serviços ECS para a EC2;
- data source CloudWatch no Grafana da AWS;
- task ECS e log group CloudWatch do worker, desabilitados por padrão;
- uma fachada OpenTelemetry Python com métricas agentic.

A lacuna é que o runtime real do worker é TypeScript e não utiliza a fachada
Python. O bootstrap TypeScript atualmente emite eventos JSON em `stdout`, mas
não inicializa OpenTelemetry nem publica as métricas esperadas pelos dashboards.

## 4. Escopo

### 4.1 Etapa 1 — validação local

1. Criar a telemetria OpenTelemetry TypeScript.
2. Criar um decorator provider-agnostic para `LlmProvider`.
3. Instrumentar a execução de cada mensagem e cada chamada ao LLM.
4. Usar o Ollama remoto por túnel SSH aberto fora da aplicação.
5. Exportar métricas e traces ao Alloy local.
6. Criar um dashboard declarativo específico do worker agentic.
7. Criar um smoke test que não dependa de SQS, DynamoDB ou S3.
8. Cobrir sucesso, falha, timeout, resposta truncada e tokens com testes.

### 4.2 Etapa 2 — deploy e validação AWS

1. Construir uma imagem imutável do worker e publicá-la no ECR.
2. Publicar bundle aprovado e catálogo no S3.
3. Injetar configuração OpenTelemetry na task ECS.
4. Confirmar permissões mínimas das roles de execução e da aplicação.
5. Provar conectividade da VPC até o endpoint Ollama antes de habilitar o
   serviço.
6. Implantar inicialmente uma única réplica do worker.
7. Validar fila, persistência, chamada ao Ollama e os três sinais no Grafana.

## 5. Fora de escopo

- executar o modelo Ollama dentro da task Fargate;
- armazenar credenciais SSH no repositório, Terraform ou task ECS;
- criar outra instância Grafana, Prometheus, Tempo, Loki ou Alloy;
- substituir a stack existente por CloudWatch Application Signals ou X-Ray;
- enviar prompts, respostas brutas ou evidências para observabilidade;
- disponibilizar o servidor Ollama publicamente;
- resolver, dentro desta entrega, a conectividade institucional caso a
  instituição não forneça VPN ou gateway aprovado;
- alterar as regras de diagnóstico, o catálogo de hipóteses ou os modelos
  determinísticos.

## 6. Arquitetura

### 6.1 Ambiente local

```text
Worker TypeScript
  ├─ HTTP localhost:11434 ── túnel SSH ── Ollama remoto
  ├─ OTLP localhost:4320 ── Alloy ─┬─ Prometheus ── Grafana
  │                                └─ Tempo ─────── Grafana
  └─ logs JSON ── terminal
```

O túnel SSH é uma pré-condição operacional e permanece fora do processo Node.
Para o worker, o Ollama é apenas `OLLAMA_BASE_URL=http://127.0.0.1:11434`.

### 6.2 Ambiente AWS

```text
Worker ECS
  ├─ HTTPS/rede privada ── gateway ou VPN institucional ── Ollama remoto
  ├─ OTLP :4320 ── Alloy na EC2 ─┬─ Prometheus ── Grafana
  │                              └─ Tempo ─────── Grafana
  └─ awslogs ── CloudWatch Logs ───────────────── Grafana
```

O worker não deve ser habilitado enquanto uma task de validação não comprovar o
caminho até o endpoint Ollama. Um endereço privado externo à VPC não é tratado
como alcançável por padrão.

## 7. Componentes

### 7.1 `telemetry.ts`

Novo módulo responsável por:

- construir `Resource`, `MeterProvider` e `TracerProvider`;
- configurar exportadores OTLP/HTTP de métricas e traces;
- criar instrumentos e tracers do serviço `view-show-agentic`;
- executar cada mensagem dentro de um span `analysis.message`;
- transformar eventos terminais do worker em métricas e status do span;
- injetar `trace_id` e `span_id` no logger enquanto houver contexto ativo;
- oferecer `forceFlush()` e `shutdown()`;
- devolver uma implementação no-op quando o endpoint não estiver configurado.

O modo no-op preserva testes, scripts de treinamento e comandos que não sobem a
stack de observabilidade.

### 7.2 `instrumented-llm-provider.ts`

Decorator que implementa `LlmProvider` e recebe outro `LlmProvider`. Para cada
`generate()` ele:

1. abre o span filho `llm.generate`;
2. mede duração monotônica;
3. chama o provider real uma única vez;
4. registra provider, modelo, resultado, motivo de parada e tokens;
5. marca erro sem alterar a exceção;
6. devolve exatamente a resposta original.

O decorator não lê nem registra `systemPrompt`, `userPrompt` ou `text`.

### 7.3 Bootstrap do worker

O bootstrap deve:

1. inicializar telemetria antes de construir o worker;
2. construir o provider Ollama existente;
3. envolver o provider com o decorator;
4. executar `worker.process()` dentro do span da mensagem;
5. parar de receber novas mensagens ao receber `SIGTERM` ou `SIGINT`;
6. aguardar o trabalho em andamento dentro do limite configurado;
7. fazer flush e shutdown da telemetria antes de sair.

### 7.4 Dashboard agentic

Novo dashboard provisionado, `View Show — Agentic/LLM Observability`, com:

- taxa de mensagens por resultado;
- duração p50, p95 e p99 da análise;
- taxa de chamadas ao LLM por resultado;
- duração p50, p95 e p99 do LLM;
- tokens de entrada e saída;
- motivos de parada, incluindo limite de tokens;
- acesso aos traces do serviço;
- logs locais somente quando o worker estiver containerizado;
- logs AWS consultados pelo data source CloudWatch.

O dashboard geral mantém apenas um resumo e um link para o dashboard agentic.

## 8. Contrato de telemetria

### 8.1 Métricas

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `analysis_messages_total` | Counter | `event_type`, `status` |
| `analysis_run_duration_seconds` | Histogram | `event_type`, `status` |
| `llm_requests_total` | Counter | `provider`, `model_id`, `status`, `stop_reason` |
| `llm_request_duration_seconds` | Histogram | `provider`, `model_id`, `status` |
| `llm_tokens_total` | Counter | `provider`, `model_id`, `token_type` |
| `llm_response_stop_total` | Counter | `provider`, `model_id`, `stop_reason` |

Valores aceitos:

- `status`: `success`, `failure`, `retry` ou `throttled` para mensagens;
- `status`: `success` ou `failure` para chamadas ao LLM;
- `token_type`: `input` ou `output`;
- `stop_reason`: `stop`, `length`, `other` ou `error`.

`runId`, `incidentId`, IDs de mensagem e texto de erro não são labels. Quando
necessários para investigação, ficam apenas em logs ou atributos de trace.

### 8.2 Spans

`analysis.message` é o span raiz da execução. Atributos permitidos:

- `messaging.system=sqs`;
- `viewshow.event_type`;
- `viewshow.analysis_status`;
- `viewshow.retry_count`;
- identificador de mensagem somente como atributo de trace.

`llm.generate` é filho de `analysis.message`. Atributos permitidos:

- `gen_ai.system=ollama`;
- `gen_ai.request.model`;
- `gen_ai.response.finish_reasons`;
- contagens de tokens quando presentes;
- `error.type` sanitizado em caso de falha.

O smoke test pode criar `llm.generate` sem pai `analysis.message`, pois não
processa uma entrega SQS.

### 8.3 Logs

No ambiente local, a primeira etapa mantém logs JSON no terminal. O Alloy atual
descobre containers Docker e não coleta automaticamente um processo Node do
host. A ingestão local de logs no Loki não é critério de aceite da etapa 1.

Na AWS, o driver `awslogs` existente envia `stdout` e `stderr` ao log group do
worker. O dashboard consulta esse grupo pelo data source CloudWatch. Quando
existe span ativo, cada linha inclui `trace_id` e `span_id`.

## 9. Configuração

### 9.1 Local

```text
LLM_PROVIDER=ollama
LLM_MODEL_ID=<modelo disponível>
OLLAMA_BASE_URL=http://127.0.0.1:11434
OTEL_SERVICE_NAME=view-show-agentic
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4320
OTEL_SERVICE_VERSION=<commit ou development>
OTEL_DEPLOYMENT_ENVIRONMENT=local
```

O usuário e a senha SSH nunca aparecem nessas variáveis. A senha deve ser
digitada interativamente ou substituída por uma chave SSH administrada fora do
repositório.

### 9.2 AWS

```text
LLM_PROVIDER=ollama
LLM_MODEL_ID=<modelo aprovado>
OLLAMA_BASE_URL=http://<ipv4-rfc1918-alcançável-pela-vpc>:11434
OTEL_SERVICE_NAME=view-show-agentic
OTEL_EXPORTER_OTLP_ENDPOINT=http://<ip-privado-observabilidade>:4320
OTEL_SERVICE_VERSION=<tag imutável da imagem>
OTEL_DEPLOYMENT_ENVIRONMENT=aws
```

Valores não secretos podem permanecer no bloco `environment` da task. Se o
gateway Ollama exigir credencial de aplicação, a referência deve entrar no
bloco `secrets` da task e ser resolvida em runtime; o valor não deve aparecer no
Terraform nem no plano.

## 10. Tratamento de falhas

| Falha | Comportamento |
| --- | --- |
| túnel local ausente | provider falha normalmente; métrica e span registram falha |
| timeout do Ollama | exceção original preservada; duração e `error.type` registrados |
| HTTP não 2xx | corpo limitado conforme adaptador atual; nenhum payload vai à telemetria |
| resposta vazia ou inválida | falha do diagnóstico; não produzir hipótese artificial |
| resposta cortada | `stop_reason=length`; validação rejeita resposta parcial |
| Alloy indisponível | diagnóstico continua; exportador falha de forma observável no log |
| shutdown | parar consumo, drenar trabalho, flush limitado e saída |
| ECS sem caminho ao Ollama | não habilitar serviço; falhar no gate de conectividade |
| DLQ não vazia | alerta existente permanece crítico |

Falha de observabilidade não deve transformar uma análise válida em falha de
negócio. Falha do LLM segue a política de retry/DLQ já existente no worker.

## 11. Segurança e privacidade

- Rotacionar credenciais compartilhadas fora do canal seguro antes do uso
  continuado.
- Não persistir senha SSH, chave privada, prompt, resposta bruta ou evidência.
- Não registrar o corpo de erros HTTP além do limite sanitizado existente.
- Usar labels de baixa cardinalidade.
- Manter o Ollama privado; não abrir sua API diretamente à internet.
- Na AWS, preferir conectividade privada e criptografada aprovada pela
  instituição.
- Restringir task role às filas, tabela e objetos S3 necessários.
- Separar execution role, usada pelo ECS para imagem e logs, da task role usada
  pela aplicação.

## 12. Estratégia de testes

### 12.1 Testes unitários

- decorator preserva resposta e chama o provider uma vez;
- duração e contador de sucesso são registrados;
- tokens ausentes não geram valores inventados;
- falha é registrada e relançada sem alteração;
- `stop`, `length` e `other` são registrados corretamente;
- prompts e respostas não aparecem em atributos ou logs;
- modo no-op funciona sem endpoint OTLP;
- shutdown chama flush e encerra providers.

Os testes usam leitores e exportadores OpenTelemetry em memória.

### 12.2 Integração local automatizada

- servidor HTTP simulado compatível com `/api/chat`;
- provider Ollama real do módulo;
- decorator real;
- métricas e spans em memória;
- cobertura de sucesso, timeout, HTTP de erro, JSON inválido e corte por tokens.

### 12.3 Smoke test local com Ollama real

- túnel aberto interativamente;
- chamada curta com entrada controlada;
- resposta estruturalmente válida;
- flush explícito antes da saída;
- `llm_requests_total{provider="ollama"}` visível no Prometheus;
- span `llm.generate` visível no Tempo;
- dashboard preenchido.

O smoke test não depende de SQS, DynamoDB ou S3.

### 12.4 Validação AWS

1. validar Terraform e task definition;
2. publicar imagem imutável no ECR;
3. executar task temporária de conectividade até o Ollama;
4. habilitar uma réplica somente após o gate;
5. publicar evento controlado na fila;
6. confirmar resultado no DynamoDB;
7. confirmar métricas, trace e logs no Grafana;
8. confirmar alarmes de falha e DLQ;
9. confirmar shutdown gracioso durante uma atualização.

## 13. Critérios de aceite

### 13.1 Etapa 1

- uma chamada real ao Ollama aparece no Prometheus e no Tempo;
- o dashboard mostra provider, modelo, resultado, duração e tokens;
- timeout e resposta truncada aparecem como falhas distintas;
- nenhum conteúdo sensível aparece nos três sinais;
- testes TypeScript e validação da configuração de observabilidade passam;
- a aplicação continua funcionando quando OTLP está desabilitado.

### 13.2 Etapa 2

- imagem imutável do worker publicada no ECR;
- conectividade ECS → Ollama comprovada antes da ativação;
- uma réplica do worker processa um evento real controlado;
- métricas e traces chegam ao Alloy na EC2;
- logs do worker aparecem no Grafana via CloudWatch;
- diagnóstico é persistido e nenhuma mensagem inesperada fica na DLQ;
- falha da telemetria não interrompe o processamento;
- rollback consiste em desabilitar o serviço do worker ou restaurar a task
  definition anterior, sem substituir a stack de observabilidade.

## 14. Sequência de entrega

```text
Etapa 1A: contrato e testes da telemetria
Etapa 1B: decorator e bootstrap
Etapa 1C: smoke test Ollama por túnel
Etapa 1D: dashboard e validação local
Etapa 2A: imagem, ECR, S3 e Terraform
Etapa 2B: gate de rede ECS → Ollama
Etapa 2C: ativação de uma réplica
Etapa 2D: validação Grafana/CloudWatch e rollback
```

As etapas AWS não podem ser usadas para declarar sucesso da integração enquanto
o gate de rede estiver pendente. A etapa local continua sendo uma entrega útil e
completa mesmo se a conectividade institucional exigir coordenação externa.
