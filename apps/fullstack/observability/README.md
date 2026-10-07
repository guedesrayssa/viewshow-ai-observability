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
└── tempo/tempo.yml                                    receptores OTLP e metrics_generator
```

## Data sources provisionados

O dashboard **View Show — API (RED)** é provisionado automaticamente e exibe
latência p95, throughput, erros por segundo e uso de CPU a partir do Prometheus.

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
- **Log para trace:** o campo derivado `TraceID` transforma o `trace_id` da linha de log em link para o Tempo.
- **Métrica para trace:** exemplares do Prometheus apontam para o trace correspondente.
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

## Coletar as métricas da API

`apps/backend/api` já expõe `GET /metrics` no formato Prometheus quando
`METRICS_ENABLED=true` (o padrão), e o alvo `view-show-api` já está habilitado.
Para enviar traces da API rodando no host, aponte o exportador OTLP para
`http://localhost:4318` (HTTP) ou `localhost:4317` (gRPC).

## Coletar métricas dos workers Python

Os serviços de ingestão e análise usam OTLP/HTTP em vez de expor um servidor
Prometheus dentro de processos batch. Com a stack local no ar:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4320
export OTEL_SERVICE_NAME=view-show-ingestion # ou view-show-agentic
```

O Alloy preserva `service.name` como label `service_name`. Como esses dois
diretórios ainda não contêm lógica de negócio, painéis e alertas permanecem sem
séries até que um entrypoint real chame os hooks de observabilidade.

## Limites da implantação

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
