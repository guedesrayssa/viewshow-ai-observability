[Voltar ao artefato principal](../testes-carga-finais.md).

# Anexo técnico: arquivos dos testes não funcionais

Os caminhos de implementação são relativos à raiz. Fontes ECS substituídas
pela migração foram congeladas e linkadas com a revisão `eca9de4`; a seção A.2
identifica os arquivos Kubernetes atuais. O inventário explica conteúdo e
parâmetros, sem atribuir uma configuração nova à execução antiga.

| Arquivo | O que implementa / parâmetros relevantes | Componente e critério |
| --- | --- | --- |
| `apps/backend/api/loadtest/k6/front-api.js` | mistura de rotas, arrival-rate, timeout 8 s, contrato por rota, fases, descartes e thresholds | API; RNF09/14 |
| `apps/backend/api/loadtest/k6/ingestao-batch.js` | multipart, polling READY/FAILED, contadores, hash da massa, idempotência, disponibilidade e contrapressão | API + worker; RNF01/02/03/09 |
| `apps/backend/api/loadtest/k6/ingestao-falhas.sh` | resolve recursos pelo runbook; liga/desliga agenda, para tasks, injeta/restaura política S3, exporta métricas SQS; Python 3 portátil | falha e reversão; RNF03 |
| `apps/backend/api/loadtest/k6/lib/session.js` | login Cognito ou sessão HMAC; identificador de requisição | autenticação e correlação |
| `apps/backend/api/loadtest/lab/run-api.sh` | build/seed, mesmo processo durante falha/recuperação, massa 2.500, 137/s, controles e soak | execução local da API |
| `apps/backend/api/loadtest/lab/capacity-contract.mjs` | orçamento = eventos ×60/10.000; valida volume conhecido e override explícito | consistência do critério em 150/300/750 mil |
| `apps/backend/api/loadtest/lab/run-nominal-repetitions.mjs` | três massas independentes, prazo pré-definido, sampler e cleanup somente da task identificada pelo importId | repetibilidade de CG-02 |
| `apps/backend/api/loadtest/lab/run-aws-evidence.mjs` | valida conta e serviço, lê segredo em memória, executa cenário atual e salva metadata sem segredo | execução identificada AWS |
| `apps/backend/api/loadtest/lab/compose.yml` | destinos DynamoDB separados, Prometheus 19090 e Grafana 13002 em loopback; imagens fixadas | leito isolado; não altera stack AWS |
| `apps/backend/api/loadtest/lab/prometheus.yml` | scrape 5 s/timeout 4 s; API local, API AWS e exporter local | coleta de métricas |
| `apps/backend/api/loadtest/lab/provisioning/datasources/lab.yml` | UID rnf-local, proxy interno http://prometheus:9090 e intervalo 5 s | datasource Grafana |
| `apps/backend/api/loadtest/lab/provisioning/dashboards/lab.yml` | provider de arquivos, diretório e namespace de provisionamento | instalação dos dashboards |
| `apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-local.json` | quatro indicadores de API e ingestão local, backlog e carga oferecida; PromQL, unidade e layout por painel | visualização local |
| `apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-aws.json` | quatro indicadores API AWS e worker import-dump; Prometheus/CloudWatch | visualização da execução AWS |
| `apps/backend/api/loadtest/lab/provision-cloudwatch.mjs` | injeta credenciais temporárias no contêiner privado, renderiza template, rejeita variáveis não resolvidas | autenticação e dimensões corretas |
| `apps/backend/api/loadtest/lab/observability-contract.mjs` | exige amostras em cada query visível; não aprova expressão vazia pelos inputs ocultos | contrato de aceite visual |
| `apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-ingestion-aws.json` | rotas /imports e CPU reservada do worker na mesma conta/janela | quatro indicadores durante CG-05 |
| `apps/backend/api/loadtest/lab/lighthouse-authenticated.mjs` | 18 auditorias sequenciais em três telas, sessão sintética, Chrome isolado e redaction | RNF07 autenticado, sem login Cognito |
| `apps/backend/api/loadtest/lab/fingerprint-frontend.mjs` | MIME/bytes/ETag/SHA-256 dos recursos JS/CSS observados no deploy | proveniência do frontend servido |
| `apps/backend/api/loadtest/scripts/verify-rnf-artifact.py` | links, JSON, hashes de evidências e detecção de chave AWS exposta | consistência documental |
| `apps/backend/api/loadtest/scripts/build-rnf-executive-pdf.py` | ReportLab, fontes DejaVu incorporadas, valores lidos dos JSON e quatro gráficos nativos Grafana | síntese executiva verificável |
| `apps/backend/api/loadtest/lab/collect-aws-metrics.py` | exporta CPU, memória, etapas, escrita e throttling com queries completas e janela UTC | séries CloudWatch da carga e recuperação |
| `apps/backend/api/loadtest/lab/collect-evidence.mjs` | query de cada painel, exportação Prometheus e gate de amostras/erros por painel | aceite de observabilidade |
| `apps/backend/ingestion-data/scripts/verify_rnf_stream.py` | leitura limitada a 1.000, campos canônicos/payloadHash, identidades e replay do fluxo | verificação independente CT-01 |
| `apps/backend/ingestion-data/scripts/verify_rnf_aws_count.py` | valida conta, deriva versão pelo SHA do snapshot e reconta 23 datasets com COUNT consistente | integridade de CG-05 na AWS |
| `apps/backend/ingestion-data/scripts/rnf_local_evidence.py` | timeout real MySQL; produtor paced, writer real, query independente, replay e exporter de medições | CT-01/02 |
| `apps/backend/ingestion-data/tests/resilience/test_multidataset_fifo_contention.py` | dois grupos FIFO, lease ocupado e desvio de mensagens válidas; evidência opt-in | CT-03 |
| `apps/backend/ingestion-data/scripts/build_benchmark_snapshot.py` | dump GZIP determinístico e manifesto SHA-256; rows-per-window controla particionamento | massa reproduzível |
| `apps/backend/ingestion-data/scripts/benchmark_snapshot_reader.py` | restauração real MySQL, keyset, desconexão, retries, percentis e contagem | escala 150/300/750 mil da leitura |
| `apps/backend/ingestion-data/scripts/publish_incremental_batch.py` | Parquet + manifesto S3 versionado e envelope FIFO | RS-01/03/04/05 |
| `apps/backend/ingestion-data/application/visibility_heartbeat.py` | thread, janela de renovação e perda de posse | correção da drenagem |
| `apps/backend/ingestion-data/adapters/telemetry/cloudwatch_metrics.py` | contrato EMF, namespace, nomes/unidades e dimensões de baixa cardinalidade | worker → CloudWatch |
| `apps/fullstack/observability/aws/user-data.sh.tftpl` | cloud-init e instalação dos containers/datasources/dashboards a partir dos arquivos versionados | provisionamento LGTM na AWS |
| `apps/fullstack/observability/prometheus/prometheus.yml` | scrape e alvos da pilha de desenvolvimento; 15 s/timeout 10 s | coleta histórica da API |
| `apps/fullstack/observability/prometheus/rules/view-show.yml` | expressões, severidade, janela for e runbooks de cada alerta | políticas históricas e limites de detecção |
| `apps/fullstack/observability/grafana/provisioning/datasources/datasources.yml` | UIDs e conexões Prometheus/Loki/Tempo | conexão da pilha original, preservada |
| [`ingestion-observability.tf` (ECS, base eca9de4)](../../assets/testes-carga/2026-10-06-fechamento-aws/source-baseline-eca9de4/ingestion-observability.tf) | filtros, métricas, alarmes e períodos; distingue comandos e task families | detecção e RNF15 |
| `apps/fullstack/observability-aws.tf` | instância, rede/role e renderização dos dashboards no bootstrap | observabilidade AWS |
| `apps/fullstack/observability/aws/view-show-ingestion.json.tftpl` | oito consultas principais/expressões, seletor operação/família, período 300 s | latência/throughput/erros/CPU batch |
| [`ingestion-ecs.tf` (ECS, base eca9de4)](../../assets/testes-carga/2026-10-06-fechamento-aws/source-baseline-eca9de4/ingestion-ecs.tf) | tasks, recursos, volumes, sidecar MySQL, entrypoints e comandos | worker sob teste |
| [`ingestion-messaging.tf` (ECS, base eca9de4)](../../assets/testes-carga/2026-10-06-fechamento-aws/source-baseline-eca9de4/ingestion-messaging.tf) | FIFO, DLQs, visibility_timeout e maxReceiveCount | backlog/reentrega |
| [`ingestion-scheduler.tf` (ECS, base eca9de4)](../../assets/testes-carga/2026-10-06-fechamento-aws/source-baseline-eca9de4/ingestion-scheduler.tf) | agendas e alvo ECS; periodicidade e estado habilitado | produção/consumo incremental |
| [`autoscaling.tf` (ECS, base eca9de4)](../../assets/testes-carga/2026-10-06-fechamento-aws/source-baseline-eca9de4/autoscaling.tf) | min/max de tasks, alvo CPU e cooldowns | capacidade da API |
| [`ecs.tf` (ECS, base eca9de4)](../../assets/testes-carga/2026-10-06-fechamento-aws/source-baseline-eca9de4/ecs.tf) | task definition, serviço, recursos, container e variáveis da API | processo HTTP e imagem implantada |
| `apps/fullstack/alb.tf` | target group, listener e health check /health com intervalo, timeout e limiares | retirada/reposição da task saturada |
| `apps/fullstack/apigateway.tf` | integração HTTP, rotas e ligação com o ALB | entrada pública e latência da rede |

## A.1 Imagens, builds e filtros de contexto

| Dockerfile e contexto | Base, dependências e etapas | Cópias, inicialização, usuário e portas | Filtro de contexto |
| --- | --- | --- | --- |
| `apps/backend/api/Dockerfile`, contexto `apps/backend/api` | Node 22.22.0 bookworm-slim por digest; npm ci instala Express 5.2.1, SDK AWS 3.1128.0, prom-client 15.1.3 e Zod 4.5.4; build TypeScript e contracts; prune omit=dev; runtime separado com dumb-init 1.2.5-2 | build: package.json, package-lock.json, contracts/package.json, tsconfig.json, tsconfig.workspaces.json, tsconfig.base.json, src/ e contracts/; runtime: package/lock, node_modules/, dist/, contracts/package.json e contracts/dist/; USER node; ENTRYPOINT dumb-init --; CMD node dist/index.js; EXPOSE 3000 e health check /health | `apps/backend/api/.dockerignore`: exclui node_modules, dist, testes, scripts, cobertura, .env, cache e .git; permite .env.example |
| `apps/backend/ingestion-data/Dockerfile`, contexto `apps/backend/ingestion-data` | Python 3.12.11 slim-bookworm por digest; mysql-client 1.1.0; requirements com hashes: Boto3 1.40.0, PyMySQL 1.1.1, PyArrow 21.0.0 e jsonschema 4.25.1; uma etapa | requirements.txt, domain/application/ports/adapters/bootstrap/contracts/scripts; WORKDIR /app; UID 10001 ingestion; ENTRYPOINT python -m bootstrap; comando por task (import-dump, ingest-incremental etc.); /tmp gravável e rootfs read-only; sem porta HTTP | `apps/backend/ingestion-data/.dockerignore`: exclui env, venv, caches, testes, requisitos dev e dados temporários, SQLite, Parquet/spool; não exclui contracts/scripts do runtime |
| `apps/backend/agentic/Dockerfile`, contexto `apps/backend/agentic` | Node 20 bookworm-slim com digest multi-plataforma 2cf067cf… igual em build/runtime; npm ci instala SDK AWS (Bedrock/DynamoDB/S3/SQS) 3.1128.0 e OpenTelemetry; TypeScript, prune omit=dev; base fixada por digest após revisão da Sprint 4; não reatribuir às imagens históricas | build: package.json, package-lock.json, tsconfig.json e src/; runtime: package/lock, node_modules/ e dist/; WORKDIR /app; USER node; CMD node dist/src/bootstrap/analysis-worker.js; consumidor de fila, sem EXPOSE HTTP | `apps/backend/agentic/.dockerignore`: exclui node_modules, dist, testes, scripts, models, data e logs |

A imagem MySQL do sidecar é separada da imagem Python. O laboratório MySQL é
configurado em `apps/backend/ingestion-data/docker-compose.test.yml`, com porta
loopback 33077, schema/fixture montados e health check. A enumeração dessas bases
não prova que todas foram usadas na mesma coleta: metadata registra a imagem
real de cada execução AWS, e o laboratório declara execução da API compilada no host.

## A.2 Configurações Kubernetes e revisão medida (`d5339f3`)

A migração foi incorporada após as medições ECS começarem. O processamento Python,
os Dockerfiles e os cenários k6 mantêm seus arquivos; o mecanismo de lançamento,
agendamento e a unidade de CPU/escala mudaram. Os 17 testes de renderização e
14 testes dos adaptadores/configuração passaram nessa revisão, com build da API.
O [mapa individual de 34 recursos](../../assets/testes-carga/2026-10-06-fechamento-local/kubernetes-resource-map.md)
identifica cada recurso da fixture e seus parâmetros; o JSON correspondente é
uma saída offline de teste, com conta/imagens/segredos sintéticos. Não constitui
manifest de uma implantação real. O detalhamento de produção está também na
[aplicação final](../sprint5/aplicacao-final.md).

| Arquivo atual | Recursos, conteúdo e parâmetros relevantes | Componente |
| --- | --- | --- |
| `apps/fullstack/workloads.tf` | sete workloads: imagens, argumentos, ambiente, Secrets Manager, CPU e memória; snapshot com MySQL e Python | API, ingestão e análise |
| `apps/fullstack/kubernetes-outputs.tf` | output sensível kubernetes_deployment com namespaces, roles, imagens, ALB e escala; runbook não sensível | Terraform → renderer |
| `apps/kubernetes/render.mjs` | gera Namespaces, SA, Secrets, Deployments, cinco CronJobs, Service, TargetGroupBinding, HPA, PDB, NetworkPolicies, RBAC e admission policies | todos os workloads |
| `apps/kubernetes/chart/Chart.yaml` | chart view-show 1.0.0, Kubernetes ≥1.33 | empacotamento Helm |
| `apps/kubernetes/chart/values.yaml` | resources: [] preenchido pelo deploy; não armazena valores reais dos Secrets | entrada do chart |
| `apps/kubernetes/chart/templates/resources.yaml` | serializa cada recurso; lookup preserva suspend de sync e replicas administradas pelo HPA | agendamento e escala |
| `apps/kubernetes/deploy.mjs` | namespaces, charts dos controllers, aplicação do chart, rollout e targets ALB; segredos pela entrada padrão | instalação e validação |
| `apps/kubernetes/run-job.mjs` | Job manual, identidade de conta/cluster/S3, Secret MySQL por Job e limpeza | backfill |
| `apps/backend/api/src/modules/imports/adapters/kubernetes-import-worker-launcher.ts` | Job determinístico por importId; recupera 409; identidade k8s://namespace/jobs/name/uid | API → importação |
| `apps/backend/api/src/modules/argus/adapters/kubernetes-argus-scheduler.ts` | get/patch de spec.suspend no CronJob sync | painel → agenda |
| `apps/backend/api/src/platform/kubernetes-client.ts` | token projetado relido por request, CA do cluster, timeout 30 s e limite de resposta 4 MiB | acesso à API Kubernetes |
| `apps/fullstack/eks.tf` | EKS 1.35, nodes, access entries, OIDC/IRSA, CNI/CoreDNS/kube-proxy, descoberta de nós e Pod Identity CloudWatch | cluster e nós |
| `apps/fullstack/eks-existing-iam.tf` | guardrails para roles/profile Academy existentes e modo IAM; não presume poder criar IAM no lab | identidade |
| `apps/fullstack/kubernetes-iam.tf` | policies AWS dos workloads em modo gerenciado; compartilhamento LabRole documentado no modo Academy | acesso a dados/filas |
| `apps/fullstack/api-runtime.tf` | segredos de cookie/cursor gerados no Terraform; valores fora das evidências | sessão API |
| `apps/fullstack/ingestion-runtime.tf` | build/digest de ingestão, argumentos MySQL, ambiente e policies incrementais | Python/MySQL |
| `apps/fullstack/ingestion-messaging.tf` | FIFO/DLQs: visibility 300 s, long polling 20 s, maxReceiveCount=5; segredos MySQL | backlog e recuperação |
| `apps/fullstack/ingestion-imports.tf` | upload/importação, proteção de ACTIVE no modo gerenciado, alarmes de falha/retry/preflight/página | controle e alertas |
| `apps/fullstack/ingestion-observability.tf` | dimensões e alarmes adaptados a EKS; séries ECS antigas não demonstram cobertura Kubernetes | CloudWatch |
| `apps/kubernetes/cloudwatch-application.conf` | Fluent Bit incorpora JSON à raiz preservando EMF | logs/métricas dos Pods |
| `apps/kubernetes/load-balancer-policy.json` | permissões AWS do Load Balancer Controller | ALB → Pods |
| `apps/fullstack/migration.tf` | retenção dos logs/DLQ legados sem destroy | preservação da evidência |
| `apps/fullstack/eks-iam-moves.tf` | mudança de endereços IAM no estado sem recriação | continuidade IAM |

**Correspondência técnica dos recursos.** Deployment/api usa porta nomeada
http:3000, RollingUpdate maxUnavailable=0/maxSurge=1 e probes /health: startup
3 s ×30, readiness 5 s/timeout 3 s, liveness 15 s/timeout 3 s. Service/api
seleciona app.kubernetes.io/name=api, port=3000/targetPort=http. TargetGroupBinding
registra IPs de Pods e aceita TCP/3000 do SG do ALB. A rota externa permanece
ANY /{proxy+} no API Gateway e listener HTTP/80 no ALB; não há Ingress neste runtime.

HPA/api tem alvo Deployment/api, padrões de 1–4 réplicas, CPU 50% e redução
com estabilização de 300 s. PDB permite maxUnavailable=1. O Worker é opcional,
0–1 réplica, com encerramento de 120 s. Não há ScaledObject/TriggerAuthentication
KEDA nessa implementação; a profundidade SQS não escala o Worker automaticamente.

CronJobs usam Etc/UTC, Forbid, startingDeadlineSeconds=300, backoffLimit=0,
restartPolicy=Never e TTL=604800 s. Snapshots têm activeDeadlineSeconds=86400;
demais Jobs, 3600. Backfill/import são templates suspensos; sync/export executam
*/15 e ingest-incremental */5, com argumento --limit 20. O MySQL é sidecar
nativo com restartPolicy=Always e startup mysqladmin ping (5 s/timeout 3 s/60
falhas), volumes emptyDir temporários e isolamento do namespace de importação.
Forbid não resolve disputa de lease entre CronJobs diferentes; o defeito CT-03
continua relevante após a migração.

**Fechamento operacional EKS.** O cluster, nós, ALB, imagens por digest,
namespace/Job/UID, controles de admissão e armazenamento dedicado estão
registrados no índice nativo. Um Job válido e sete mutações negativas foram
submetidos em `dry-run=server`; todos os oito controles passaram. A bateria de
150.000 eventos teve a observação k6 encerrada como censurada quando excedeu o
orçamento; o job remoto continuava em processamento. O cenário de 1.000
comprovou o caminho `READY`. A bateria
local da API continua útil para comparar regressão; ela não é somada às métricas
EKS como se fosse a mesma amostra.

## A.3 Queries e unidades da coleta

| Indicador | Consulta/fonte | Unidade e limite de interpretação |
| --- | --- | --- |
| Latência API | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="rnf-api-aws"}[30s])))` | segundos; histograma do servidor; k6 mede também a rede |
| Throughput API | `sum(rate(http_requests_total{job="rnf-api-aws"}[30s]))` | req/s; incluir falhas e distinguir vazão útil no relatório k6 |
| Erros API | `sum(rate(http_requests_total{job="rnf-api-aws",status_code=~"5.."}[30s]))` | erros/s; 429 é contrapressão separada, e timeout do cliente é contado no k6 |
| CPU API | `100*rate(view_show_process_cpu_seconds_total{job="rnf-api-aws"}[30s])` | % de um núcleo por processo; pode exceder 100%; não é % da reserva ECS |
| Latência worker | `RunDurationMs` p95; `StageDurationMs` Maximum por comando/etapa | ms; amostras batch esparsas; percentil com uma run não prova distribuição |
| Throughput worker | `RecordsRead/300` e `RecordsWritten/300`, Sum em período 300 s | registros/s no bucket CloudWatch, não vazão instantânea; distinguir unchanged/rejected |
| Erros worker | `Runs{status=FAILED/PARTIAL}/300`, `RecordsRejected/300` | falhas/s e rejeições/s distintas; ausência de run terminal não vale zero |
| CPU worker | `100*CpuUtilized/CpuReserved`, `ECS/ContainerInsights`, família da task/cluster | % da CPU reservada; mesma janela/operação da carga |
| Laboratório contínuo | `rnf_records_offered_total`, `rnf_records_written_total`, histograma `rnf_batch_duration_seconds`, `rnf_failures_total`, `rnf_process_cpu_seconds_total`, `rnf_backlog_events` | métricas do experimento sobre componentes reais; não são métricas ECS nem um novo coletor de produção |

No EKS, as três queries HTTP substituem `job="rnf-api-aws"` por
`job="rnf-api-eks"`; CPU é
`100*sum(rate(container_cpu_usage_seconds_total{job="rnf-kubelet-cadvisor",namespace="view-show-rnf",container="api"}[30s]))`,
em percentual de um núcleo. A descoberta da API é por Pod e o cAdvisor via
API Kubernetes, com dois endpoints de nó coletados. Os gates finais preservam
expressão, janela e amostras por painel.

## A.4 Arquivos da revisão e visualização retrospectiva

| Arquivo | Conteúdo e relação com a entrega |
| --- | --- |
| `apps/backend/api/loadtest/grafana-retroativo/build.py` | Conversão dos brutos em séries e três dashboards; hashes e transformações por indicador |
| `apps/backend/api/loadtest/grafana-retroativo/replay.py` | Leitor HTTP somente de evidência; nomes exatos, sem PromQL arbitrário, sem preencher lacunas |
| `apps/backend/api/loadtest/grafana-retroativo/series.json` | Valores originais e derivados, timestamps e unidades; separa média por etapa de taxa instantânea |
| `apps/backend/api/loadtest/grafana-retroativo/compose.yml` | Python 3.12.11, Grafana 13.2.1 e renderer 3.12.9; loopback 19092/13003 e mounts read-only |
| `apps/backend/api/loadtest/grafana-retroativo/provisioning/datasources/replay.yml` | UID `rnf-retro`, leitor interno HTTP; sem credenciais AWS |
| `apps/backend/api/loadtest/grafana-retroativo/provisioning/dashboards/provider.yml` | Pasta de dashboards, provisionamento declarativo |
| `apps/backend/api/loadtest/grafana-retroativo/provisioning/dashboards/rnf-retro-api.json` | API EKS: quatro indicadores, CPU em % de um núcleo e janela fixa |
| `apps/backend/api/loadtest/grafana-retroativo/provisioning/dashboards/rnf-retro-ingestao.json` | ECS: duração/vazão de cada etapa, CPU e memória; não inventa série de erros |
| `apps/backend/api/loadtest/grafana-retroativo/provisioning/dashboards/rnf-retro-fila.json` | RS-01: profundidade, idade, confirmações e DLQ |
| `apps/backend/api/loadtest/grafana-retroativo/render.mjs` | Consulta cada expressão pela API Grafana, valida valores e exporta PNG nativo |
| `apps/backend/api/loadtest/lab/provision-rnf-eks.py` | Provisionamento de cluster/nós/ALB/dados dedicados, com checagem de conta e propriedade |
| `apps/backend/api/loadtest/lab/configure-rnf-eks.mjs` | Contrato privado da implantação, imagens por digest e workloads sem agendas ativas |
| `apps/backend/api/loadtest/lab/run-eks-evidence.mjs` | Runner nativo: secret de sessão Kubernetes em memória, ALB dedicado, metadata e k6 |
| `apps/backend/api/loadtest/lab/verify-eks-admission.mjs` | Um Job válido e sete mutações negativas em server dry-run com a identidade da API |
| `apps/backend/api/loadtest/lab/eks-prometheus.yml` | SA/RBAC, ConfigMap, Deployment e scrape da API por Pods e do cAdvisor via Kubernetes |
| `apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-eks.json` | Quatro queries originais do EKS; correção da CPU agregada |

Comandos, endpoints e limites do leitor estão no
[README retrospectivo](../../apps/backend/api/loadtest/grafana-retroativo/README.md).

## A.5 Telemetria de produção integrada pelo MR !99

| Arquivo | Conteúdo e relação com o diagnóstico de carga |
| --- | --- |
| `apps/backend/api/src/observability/http-observability.ts` | Contexto request_id, header trace_id, nível por status, log de abortos e exceções redigidas |
| `apps/backend/api/src/observability/metrics.ts` | OpenMetrics, exemplares de latência, tentativas de login, build info e saúde do envio de logs |
| `apps/backend/api/contracts/src/observability/logger.ts` | JSON de linha única, contexto/identidade dos sinais e redação de campos e mensagem principal |
| `apps/backend/api/contracts/src/observability/redaction.ts` | Redação por chave/valor, limites de tamanho/profundidade e serialização segura de erros |
| `apps/backend/api/contracts/src/observability/loki-transport.ts` | Envio em lote, buffer limitado, timeout e contadores de entrega/falha/descarte |
| `apps/backend/api/contracts/src/observability/telemetry.ts` | SDK OTel, instrumentações usadas pela API, exclusão de probes e parâmetros sensíveis |
| `apps/fullstack/observability/scripts/run-api-local.sh` | API e DynamoDB locais ligados à LGTM, usando configuração de bootstrap Kubernetes |
| `apps/fullstack/observability/scripts/verify-api-observability.mjs` | Verificação de correlação, redação, exemplares, datasources e queries dos dashboards |
| `apps/fullstack/observability/aws/validate-user-data.sh` | Renderização dos dashboards/bootstrap, validação de shell/placeholders e limite gzip de 16 KiB |
| `apps/scripts/aws-learner-lab-ecs-legacy.mjs` | Preserva helpers/gates Windows históricos; execução direta continua bloqueando operações ECS |

O [registro da revisão](revisao-integracao-observabilidade.md) relaciona os
achados às correções e identifica os limites dos checks locais.

A revisão dos pareceres acrescenta `apps/backend/api/loadtest/scripts/reconcile-evidence.py` para conferir números/checks contra os JSON e `apps/kubernetes/RECUPERACAO.md` para a contingência operacional. A mudança de digest do worker requer nova imagem; os resultados da revisão medida continuam vinculados aos digests originais.
