# Pilha de observabilidade Grafana

Ambiente de desenvolvimento com Grafana, Prometheus, Loki, Tempo e Alloy, subido por
`apps/fullstack/docker-compose.observability.yml`. Serve para instrumentar
a API do View Show localmente antes de levar métricas, logs e traces para a AWS.

A mesma stack também pode ser criada na AWS pelo Terraform de `apps/fullstack`.
Na AWS ela roda em uma EC2 única, com volumes Docker persistentes durante a vida
da instância, e acrescenta o CloudWatch como data source do Grafana. Assim as
métricas de EKS, ALB e DynamoDB e os logs atuais da API ficam disponíveis desde
o primeiro deploy, sem substituir Prometheus, Loki ou Tempo.

## Subir e derrubar

```bash
# a partir da raiz do repositório
docker compose -f apps/fullstack/docker-compose.observability.yml up -d
docker compose -f apps/fullstack/docker-compose.observability.yml ps
docker compose -f apps/fullstack/docker-compose.observability.yml logs -f grafana

docker compose -f apps/fullstack/docker-compose.observability.yml down      # preserva os volumes
docker compose -f apps/fullstack/docker-compose.observability.yml down -v   # apaga os dados
```

Grafana em <http://localhost:3002>, usuário `admin` e senha `admin` por padrão.
Para trocar, exporte `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD` antes de subir.

## Portas

| Porta | Serviço | Uso |
| --- | --- | --- |
| 3002 | Grafana | Interface web (3000 é a API e 3001 é o frontend) |
| 9090 | Prometheus | Interface web, API de consulta e recepção de remote write |
| 3100 | Loki | Ingestão e consulta de logs |
| 3200 | Tempo | API de consulta de traces, usada pelo Grafana |
| 4317 | Tempo | Recepção de traces via OTLP/gRPC |
| 4318 | Tempo | Recepção de traces via OTLP/HTTP |
| 4320 | Alloy | Recepção OTLP/HTTP de métricas e traces dos workers Python |

O Alloy descobre os containers pelo socket do Docker, persiste as posições de
leitura e envia os logs ao Loki. Em `:4320`, também recebe OTLP/HTTP dos workers,
converte métricas para remote write no Prometheus e encaminha traces ao Tempo.
A API também pode enviar JSON estruturado diretamente ao Loki. Os workers
escrevem somente em `stdout`, sem bloquear o processamento com chamadas ao Loki.

Todas as portas podem ser sobrescritas por variáveis de ambiente
(`GRAFANA_PORT`, `PROMETHEUS_PORT`, `LOKI_PORT`, `TEMPO_HTTP_PORT`,
`TEMPO_OTLP_GRPC_PORT`, `TEMPO_OTLP_HTTP_PORT`, `ALLOY_OTLP_HTTP_PORT`).

## Arquivos

```
apps/fullstack/observability/
├── alloy/config.alloy                                 logs e gateway OTLP dos workers
├── grafana/provisioning/datasources/datasources.yml   data sources automáticos
├── grafana/provisioning/dashboards/                   dashboards RED e de aplicação
├── loki/loki-config.yml                               Loki monolítico, disco local
├── prometheus/prometheus.yml                          alvos e intervalo de coleta
├── prometheus/rules/view-show.yml                     alertas (runbooks em docs/runbooks)
├── scripts/run-api-local.sh                           sobe a API local ligada à pilha
├── scripts/verify-api-observability.mjs               prova de ponta a ponta (34 verificações)
└── tempo/tempo.yml                                    receptores OTLP e metrics_generator
```

## Data sources provisionados

Dashboards provisionados automaticamente em **Dashboards → View Show**:

- **View Show — API (RED, logs e traces)** (`view-show-api`): disponibilidade,
  latência p95 e logins recusados; taxa, latência e status **por rota**; saturação
  (CPU e event loop); latência das dependências AWS (derivada dos traces); tabela
  de traces lentos ou com erro; logs `warn`/`error`; e uma caixa **Request ID ou
  Trace ID** que filtra os logs e os traces daquela requisição. A latência por rota
  mostra exemplares: clicar em um ponto abre o trace daquela amostra.
- **View Show — Application Observability** (`view-show-observability`): alertas
  disparando, frontend (Web Vitals e erros), memória da API e os workers de
  ingestão e análise (que só têm séries quando rodam).
- **View Show — Agentic LLM Observability** (`view-show-agentic`): desfechos e
  duração das análises, requisições e latência do LLM, taxa de tokens, traces e
  logs locais do worker de análise.

Na AWS, o dashboard **View Show — Ingestão** usa o data source CloudWatch para
mostrar os mesmos indicadores de RED no contexto batch, além de duração por
etapa, freshness, filas, DLQs, qualidade de dados e eventos operacionais. O
seletor `Operação` filtra as métricas EMF pelo comando. Selecione também
`Namespace` e `Pod da operação` para CPU e logs no EKS, na mesma janela da run.
A CPU é `pod_cpu_utilization_over_pod_limit` de `ContainerInsights`, em % do
limite do Pod (inclui o sidecar MySQL). A
[referência AWS](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-metrics-EKS.html)
define as dimensões ClusterName/Namespace/PodName; se algum container não tem
limite, a métrica pode faltar. As capturas ECS históricas conservam suas unidades.

O Grafana lê `grafana/provisioning/datasources/datasources.yml` a cada subida e
sincroniza os três data sources. Eles ficam marcados como somente leitura: para
alterar qualquer um, edite o YAML e reinicie o container, porque mudanças feitas
pela interface web são sobrescritas na próxima subida.

| Data source | UID | Endereço interno |
| --- | --- | --- |
| Prometheus (padrão) | `prometheus` | `http://prometheus:9090` |
| Loki | `loki` | `http://loki:3100` |
| Tempo | `tempo` | `http://tempo:3200` |

As correlações entre os três já vêm configuradas:

- **Trace para logs:** de um span no Tempo para as linhas do Loki com o mesmo `trace_id`.
- **Log para trace:** os campos derivados `TraceID` e `TraceIDJson` transformam o `trace_id` da linha de log em link para o Tempo.
- **Métrica para trace:** exemplares do histograma de latência apontam para o trace da amostra. Exigem `--enable-feature=exemplar-storage` no Prometheus e a API servindo OpenMetrics; antes nenhum dos dois existia e o salto nunca aparecia.
- **Trace para métricas:** os botões *Chamadas por segundo* e *Latência p95* do span abrem as métricas derivadas dos traces (`traces_spanmetrics_*`).
- **Mapa de serviços:** alimentado pelas métricas `traces_service_graph_*` que o `metrics_generator` do Tempo grava no Prometheus por remote write.

## Verificação rápida

```bash
curl http://localhost:9090/-/healthy    # Prometheus
curl http://localhost:3100/ready        # Loki, responde 503 nos primeiros 15s
curl http://localhost:3200/ready        # Tempo, responde 503 nos primeiros 15s

# saúde dos três data sources vista pelo Grafana
for uid in prometheus loki tempo; do
  curl -s -u admin:admin "http://localhost:3002/api/datasources/uid/$uid/health"; echo
done
```

## Subir na AWS

### Somente observabilidade no Learner Lab

Quando a aplicação completa ainda não estiver provisionada, use o script
isolado abaixo no AWS CloudShell. Ele cria apenas a EC2 com Grafana, Prometheus,
Loki, Tempo e Alloy; não cria EKS, ALB, DynamoDB ou Amplify.

```bash
cd apps/fullstack/observability/aws
export GRAFANA_CIDR_ACESSO="SEU_IP_PUBLICO/32"
chmod +x deploy-learner-lab.sh
./deploy-learner-lab.sh
```

A execução reaproveita uma instância existente chamada
`view-show-observabilidade`. A senha inicial fica em
`~/.view-show-grafana-admin-password`, com acesso restrito ao usuário do
CloudShell. O script só imprime a URL depois de validar a saúde do Grafana via
SSM.

O CI renderiza o mesmo bootstrap sem acessar a AWS. Para repetir essa validação
localmente, execute `./deploy-learner-lab.sh --validate-only` nesse diretório.

### Aplicação completa com Kubernetes

Siga o [runbook EKS](../../kubernetes/README.md). `observabilidade_habilitada=true` mantém Grafana, Prometheus, Loki, Tempo e Alloy na EC2 privada existente; a API em Pods envia logs e traces para os mesmos endpoints e Prometheus coleta `/metrics` pelo ALB. CloudWatch Agent/Fluent Bit no cluster coletam logs/EMF e métricas EKS. O dashboard AWS usa `ContainerInsights` com cluster, namespace e PodName. Os logs ECS históricos são preservados na migração, sem receber novos eventos.

### O que chega a cada data source na AWS

| Data source | Estado depois do apply |
| --- | --- |
| CloudWatch | EKS, ALB, DynamoDB e logs `/aws/containerinsights/<cluster>/application` após o deploy Kubernetes |
| Prometheus | Auto-observação da stack e scrape de `/metrics` da API pelo ALB |
| Loki | Logs dos containers da stack via Alloy e JSON correlacionado da API; CloudWatch permanece habilitado |
| Tempo | Receptor OTLP/HTTP privado em `:4318`, restrito ao security group da API |
| Alloy | Receptor OTLP/HTTP privado em `:4320` para métricas e traces dos workers |

A API recebe `OTEL_EXPORTER_OTLP_ENDPOINT` e `LOKI_PUSH_URL` quando a observabilidade está habilitada. Os logs JSON dos workers são coletados pelo Fluent Bit; a configuração mescla o JSON na raiz para preservar métricas EMF e filtros de log. A instrumentação e os alarmes de domínio continuam independentes do Loki. Use `kubectl logs` para inspeção imediata dos Jobs e CloudWatch para histórico.

### Operação e custo no Learner Lab

O fim da sessão do laboratório para a EC2. O Docker está habilitado no boot e
os containers usam `restart: unless-stopped`, então a stack volta junto quando
a instância for iniciada novamente. O EBS continua existindo e sendo cobrado
enquanto a EC2 estiver parada.

Para remover a stack inteira e seus dados:

```bash
terraform destroy \
  -var='deployment_namespace=view-show' \
  -var='observabilidade_habilitada=true'
```

Uma alteração nos arquivos de configuração recria a EC2 para reaplicar o
`cloud-init`; por isso, neste ambiente de laboratório, os dados históricos dos
volumes Docker são descartados nessa troca.

Na pilha local, os alvos de coleta ficam em
<http://localhost:9090/targets>. O Prometheus coleta a cada 15 segundos a própria
pilha e a API em `host.docker.internal:3000`. Inicie a API para manter esse alvo
saudável. Na AWS, o alvo `view-show-api` aponta para o ALB criado pelo Terraform.

## O que a API emite

| Sinal | Como sai | Configuração |
| --- | --- | --- |
| Métricas | `GET /metrics` em OpenMetrics (formato que carrega exemplares), coletado a cada 15 s | `METRICS_ENABLED` (padrão `true`) |
| Traces | OTLP/HTTP direto ao Tempo (`:4318`), instrumentando HTTP, Express, AWS SDK e `fetch` | `OTEL_EXPORTER_OTLP_ENDPOINT`; vazio desliga |
| Logs | JSON em `stdout`, Fluent Bit/CloudWatch no EKS **e** envio em lote ao Loki | `LOKI_PUSH_URL`; vazio desliga só o envio ao Loki |

Os três usam a mesma identidade (`service_name`, `environment`, `service_version`),
derivada de `OTEL_SERVICE_NAME`, `OTEL_DEPLOYMENT_ENVIRONMENT` e `OTEL_RESOURCE_ATTRIBUTES`.
É essa igualdade que faz os saltos entre Loki e Tempo funcionarem. Variáveis completas em
`apps/backend/api/.env.example`.

**Logs.** Uma linha de acesso por requisição (`event=http.request.completed`) com nível
conforme o status (2xx `info`, 4xx e lentas `warn`, 5xx `error`), `route` como template
(nunca o path com IDs), `duration_ms` e `error_code` de negócio. `/health` e `/metrics`
não geram linha. Falhas inesperadas geram uma segunda linha (`http.request.failed`) com
tipo, mensagem e pilha em campos próprios. Eventos de domínio: `auth.login.succeeded` e
`auth.login.failed` (com o motivo, sem o usuário digitado), `hypothesis.review.submitted`,
`reanalysis.requested`, `argus.live_sync.updated`, `dataset.active.absent` (limitado a uma
linha por 30 s, com `suppressed_count`) e `process.started`. Todo campo passa por redação
(senhas, tokens, cookies, JWT, chaves AWS, assinaturas de URL e e-mails mascarados).

**Traces.** O span `SERVER` se chama `GET /api/v1/incidents` (template da rota), carrega
`viewshow.request_id`, `viewshow.dataset_version` e `viewshow.error_code`, e a query string
sai redigida (`code`, `state`, tokens). Chamadas ao DynamoDB, SQS, S3 e Cognito viram
spans `CLIENT`. A reconciliação de importações roda em segundo plano e tem raiz própria
(`imports.reconcile`). Sondas `/health` e `/metrics` não geram trace. A API devolve
`X-Request-Id` e `X-Trace-Id` (expostos ao navegador via CORS) e aceita `traceparent`.

**Métricas.** As de RED (`http_requests_total`, `http_request_duration_seconds` com exemplar
de `trace_id`, `http_requests_failed_total`, `http_requests_in_flight`), Web Vitals do painel,
runtime do Node (`view_show_*`), `auth_login_attempts_total{outcome}`,
`view_show_build_info{version}` e a saúde do envio de logs (`log_shipping_*`).

## Investigar uma requisição

1. Parta de qualquer ponta: o `X-Request-Id`/`X-Trace-Id` da resposta, o `requestId` do
   envelope de erro, um ponto do gráfico de latência (exemplar) ou uma linha de log.
2. No dashboard da API, digite o ID em **Request ID ou Trace ID**: os painéis de baixo
   mostram os logs e os traces daquela requisição.
3. Do trace, o botão **Logs for this trace** abre o Loki filtrado; **Chamadas por segundo**
   e **Latência p95** abrem as métricas derivadas dos traces. De uma linha de log, o campo
   derivado **TraceIDJson** abre o trace.
4. Sem o ID, use TraceQL no Explore: `{ span.viewshow.error_code = "DATA_UNAVAILABLE" }`,
   `{ resource.service.name =~ ".*api" && duration > 1s }` ou
   `{ span.viewshow.request_id = "<id>" }`.

## Subir a API local e validar

```bash
docker compose -f apps/fullstack/docker-compose.observability.yml up -d
bash apps/fullstack/observability/scripts/run-api-local.sh      # terminal 1 (Ctrl+C encerra)

# terminal 2
AUTH_COOKIE_SECRET=local-obs-auth-cookie-secret-32-bytes-minimum \
  node apps/fullstack/observability/scripts/verify-api-observability.mjs
```

O script sobe um DynamoDB Local descartável com massa sintética (nada toca a AWS). O
verificador gera requisições com IDs conhecidos e confere nos backends reais: níveis de log,
nome do span, correlação nos dois sentidos, exemplar, ausência de segredos em log e trace e a
execução sem erro de **toda** query de **todo** painel. Sai com código 1 se algo falhar.

### Validar na AWS

Na AWS, Loki, Tempo e Prometheus são privados e a senha do Grafana é gerada pelo Terraform.
Rode o verificador **dentro da EC2** (SSM), em um contêiner na rede da stack, para a senha
nunca sair da instância. O `user_data` já deixa as credenciais em
`/opt/view-show-observability/.env`:

```bash
# envie verify-api-observability.mjs para /tmp/verify.mjs na EC2 (por exemplo em base64, via
# aws ssm send-command) e execute lá:
set -a; . /opt/view-show-observability/.env; set +a
docker run --rm --network view-show-observability -v /tmp/verify.mjs:/verify.mjs:ro \
  -e BASE_URL=http://<dns-do-alb> -e LOKI_URL=http://loki:3100 -e TEMPO_URL=http://tempo:3200 \
  -e PROMETHEUS_URL=http://prometheus:9090 -e GRAFANA_URL=http://grafana:3000 \
  -e DASHBOARD_UIDS=view-show-api,view-show-observability \
  -e GRAFANA_AUTH="admin:$GRAFANA_ADMIN_PASSWORD" node:22-alpine node /verify.mjs
```

Sem `AUTH_COOKIE_SECRET` o verificador não usa sessão (as rotas que ele exercita são públicas).
Para o verificador consultar Loki, Tempo e Prometheus pelo proxy do Grafana a partir de um
túnel SSM, em vez de rodar na EC2, use `LOKI_URL`, `TEMPO_URL` e `PROMETHEUS_URL` apontando para
`http://localhost:3002/api/datasources/proxy/uid/{loki,tempo,prometheus}` e `BACKEND_AUTH=admin:<senha>`.

A API só exporta traces e logs para a EC2 quando `observabilidade_api_exportacao_habilitada` é
`true`. O fluxo de criação da EC2 do Learner Lab a deixa `false` até o IP privado existir;
depois, planeje a alteração e execute o deploy Kubernetes para que os Pods
recebam `OTEL_EXPORTER_OTLP_ENDPOINT` e `LOKI_PUSH_URL`. Os comandos
`grafana`, `update` e `analysis-*` da antiga CLI ECS foram retirados da entrada
padrão; o [runbook EKS](../../kubernetes/README.md) é o fluxo atual.
Os helpers Windows e gates da MR foram preservados no módulo
`apps/scripts/aws-learner-lab-ecs-legacy.mjs`, sem reativar suas operações ECS.

## Coletar métricas dos workers Python

Os serviços de ingestão e análise usam OTLP/HTTP em vez de expor um servidor
Prometheus dentro de processos batch. Com a stack local no ar:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4320
export OTEL_SERVICE_NAME=view-show-ingestion # ou view-show-agentic
```

O Alloy preserva `service.name` como label `service_name`. Os workers Python
emitem os sinais durante suas execuções batch; sem worker ativo na janela,
os painéis podem não ter amostras. Logs/EMF no CloudWatch e métricas OTLP
são caminhos complementares, com unidades e intervalos identificados.

## Limites da implantação

- **Orçamento do `user_data` da EC2.** A EC2 recebe todas as configurações e dashboards no
  `user_data`, e a API EC2 limita o payload a 16 KiB. O Terraform envia o script inteiro
  comprimido (`user_data_base64 = base64gzip(...)`) e `aws/validate-user-data.sh` mede esse
  payload: hoje 15.305 B de 16.384, com o script bruto em ~21 KB. Dashboard, regra ou
  configuração nova precisa caber; o dashboard da API absorveu os painéis de API do overview
  em vez de somar, e o script de boot usa caminhos relativos para poupar bytes. Para crescer de
  verdade, publique os arquivos em um bucket e baixe-os no boot.
- **Coleta de `/metrics` na AWS.** O alvo `view-show-api` aponta para o ALB, que balanceia
  entre os Pods: com mais de uma réplica, cada coleta pode cair em um Pod diferente
  e os contadores parecem oscilar. Para métricas por réplica, use descoberta de
  Pods, como no laboratório EKS de testes de carga.

## Integração com os testes de carga

O [artefato consolidado](../../../artefatos/testes-carga-finais.md) liga as
medições históricas às decisões de arquitetura. O
[laboratório](../../../apps/backend/api/loadtest/lab/README.md) coleta métricas
de carga e o [Grafana retrospectivo](../../../apps/backend/api/loadtest/grafana-retroativo/README.md)
reabre os brutos sem nova carga. A telemetria deste MR complementa essas
medições com request_id/trace_id, exemplares e saúde do envio de logs.
A integração não reatribui os resultados coletados antes deste código à nova imagem.
- **Aviso do Tempo.** O Tempo 3.0 registra `ignoring unknown metrics-generator processor
  local-blocks` a cada 10 s: ele mesmo reinjeta esse processador. É inofensivo.
- **Amostragem.** Todo trace é gravado (`always_on`). Para reduzir volume, defina
  `OTEL_TRACES_SAMPLER=parentbased_traceidratio` e `OTEL_TRACES_SAMPLER_ARG=0.1`; os
  exemplares só são criados para traces amostrados.

As configurações local e AWS são destinadas a desenvolvimento, demonstração e
homologação, não a produção: Loki e Tempo rodam em modo monolítico gravando em
disco local, com anel de consistência em memória e fator de replicação 1, e o
Grafana usa a base SQLite embutida. A EC2 também é um ponto único de falha. A
retenção é de 7 dias para logs e traces e de 15 dias para métricas.

O acesso direto opcional usa HTTP porque o laboratório não possui domínio e
certificado. Para produção, mantenha a interface em rede privada ou publique-a
atrás de TLS, use armazenamento de objetos e uma topologia de alta
disponibilidade, e mova o segredo de administrador para um gerenciador de
segredos.

O `tempo.yml` segue o schema da linha 3.x, que reorganizou a configuração: o
ingester virou `live_store` e a compactação passou para `backend_scheduler`. Um
arquivo escrito para o Tempo 2.x não é aceito por esta versão.
