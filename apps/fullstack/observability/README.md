# Pilha de observabilidade Grafana

Ambiente de desenvolvimento com Grafana, Prometheus, Loki, Tempo e Alloy, subido por
`apps/fullstack/docker-compose.observability.yml`. Serve para instrumentar
a API do View Show localmente antes de levar métricas, logs e traces para a AWS.

A mesma stack também pode ser criada na AWS pelo Terraform de `apps/fullstack`.
Na AWS ela roda em uma EC2 única, com volumes Docker persistentes durante a vida
da instância, e acrescenta o CloudWatch como data source do Grafana. Assim as
métricas de ECS, ALB e DynamoDB e os logs atuais da API ficam disponíveis desde
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
Na AWS, o dashboard **View Show — Ingestão** usa o data source CloudWatch para
mostrar esses mesmos quatro indicadores no contexto batch, além de duração por
etapa, freshness, filas, DLQs, qualidade de dados e eventos operacionais. Os
filtros `Comando` e `Task ECS` mantêm a comparação na mesma carga executada.

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
Loki, Tempo e Alloy; não cria ECS, ALB, DynamoDB ou Amplify.

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

### Aplicação completa com Terraform

Pré-requisitos: Terraform, Docker, Node, AWS CLI, Session Manager plugin e uma
sessão válida do AWS Academy. As credenciais temporárias são as mesmas usadas
pela infraestrutura fullstack.

```bash
cd apps/fullstack
aws sts get-caller-identity
terraform init
terraform plan \
  -var='deployment_namespace=view-show' \
  -var='observabilidade_habilitada=true' \
  -out=view-show-observabilidade.tfplan
terraform apply view-show-observabilidade.tfplan
```

Sem o opt-in explícito, o Terraform não cria nenhum recurso de observabilidade
na AWS. O plano acima cria uma EC2 `view-show-observabilidade` do tipo `t3.medium`
com 30 GiB de gp3 criptografado, instala o Docker Compose e inicia os cinco
componentes. Não é necessário clonar o
repositório na instância: os arquivos versionados são compactados e enviados
pelo `user_data`. O bootstrap leva alguns minutos depois que a EC2 aparece como
`running`.

Por padrão nenhuma porta administrativa fica aberta à internet. Abra o túnel
SSM que o output entrega:

```bash
terraform output grafana_acesso
terraform output -raw grafana_senha

aws ssm start-session \
  --target "$(terraform output -raw observabilidade_instancia_id)" \
  --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=3000,localPortNumber=3002 \
  --region us-east-1
```

Enquanto a sessão estiver aberta, acesse <http://localhost:3002> com o usuário
`admin` e a senha impressa pelo segundo comando. Os dashboards provisionados
ficam em **Dashboards → View Show**: **View Show — AWS** cobre os serviços
gerenciados e **View Show — Application Observability** cobre RED, Web Vitals,
logs correlacionados e alertas da aplicação. **View Show — Ingestão** cobre a
saúde e o diagnóstico do pipeline batch diretamente no CloudWatch.

Para acompanhar o primeiro boot, abra outra sessão SSM e rode:

```bash
sudo tail -f /var/log/cloud-init-output.log
sudo docker compose -f /opt/view-show-observability/docker-compose.yml ps
```

Se SSM não estiver disponível na conta, restrinja o acesso direto ao seu IP;
jamais use `0.0.0.0/0` para o Grafana:

```bash
terraform apply -var='grafana_cidr_acesso=203.0.113.10/32'
terraform output grafana_acesso
```

O IP público comum muda depois de parar e iniciar a EC2. Rode
`terraform apply -refresh-only` para atualizar o output. Não foi criado Elastic
IP porque ele adiciona custo contínuo e o acesso SSM não depende de endereço
estável.

### O que chega a cada data source na AWS

| Data source | Estado depois do apply |
| --- | --- |
| CloudWatch | ECS, ALB, DynamoDB e logs `/ecs/view-show-api` disponíveis imediatamente |
| Prometheus | Auto-observação da stack e scrape de `/metrics` da API pelo ALB |
| Loki | Logs dos containers da stack via Alloy e JSON correlacionado da API; CloudWatch permanece habilitado |
| Tempo | Receptor OTLP/HTTP privado em `:4318`, restrito ao security group da API |
| Alloy | Receptor OTLP/HTTP privado em `:4320` para métricas e traces dos workers |

O Terraform injeta `OTEL_SERVICE_NAME=view-show-api` e o endereço privado do Tempo
na task ECS somente quando o opt-in está ativo. A API TypeScript inicializa o
SDK OpenTelemetry quando esse endpoint existe.

Os futuros tasks de ingestão e análise devem reutilizar o security group da
aplicação e definir `OTEL_EXPORTER_OTLP_ENDPOINT` com o valor de
`terraform output -raw observabilidade_otlp_workers_endpoint`. Os pacotes em
`apps/backend/ingestion-data` e `apps/backend/agentic` já implementam o contrato,
mas não existem tasks ou entrypoints desses workers nesta entrega.
Os workers escrevem logs JSON em `stdout`; em ECS, mantenha o driver `awslogs`
para enviá-los ao CloudWatch sem acoplar o processamento à disponibilidade do
Loki.

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
