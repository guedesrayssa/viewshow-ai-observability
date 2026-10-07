# Revisão e integração do MR !99 — 07/10/2026

O MR !99 foi revisado junto da `develop` que já contém o MR !101
(`28bd5c4`), reunindo a telemetria de produção e os testes de carga.
O merge posterior `1b353cf` também foi incorporado; não trouxe diferenças
de conteúdo para a versão verificada. A pipeline do GitLab apresentou falha
sem jobs e sem erro YAML; o usuário autorizou seguir com o merge baseado nos
checks locais descritos abaixo, sem alterar as regras de aprovação do projeto.
As evidências históricas, os dashboards do laboratório, o Grafana retrospectivo
e o PDF foram preservados. A integração de código não reatribui medições
anteriores à imagem nova e não inclui novo provisionamento AWS.

## Problemas encontrados e corrigidos

| Achado | Correção | Verificação |
| --- | --- | --- |
| Conflito entre launcher monolítico ECS e wrapper Kubernetes | Entrada padrão Kubernetes preservada; alterações Windows/gates portadas ao módulo ECS histórico, cuja CLI continua recusando operações | Contratos de launcher e de aposentadoria ECS no Node/Linux |
| Terraform ainda apontava para tasks/log groups ECS inexistentes | Dashboard de ingestão e output de operação da análise adaptados ao EKS; log group atual do Fluent Bit | `terraform validate` e sete testes com providers mockados |
| CPU de ingestão usava `ECS/ContainerInsights` e família de task | `ContainerInsights/pod_cpu_utilization_over_pod_limit`, com ClusterName/Namespace/PodName e seletor de Pod | Renderização de JSON/bootstrap; sem alegar coleta AWS nova |
| Dashboard de análise passaria a consultar todos os workloads no grupo compartilhado | Filtro de `kubernetes.container_name = 'analysis-worker'` na query de logs | Template renderizado e política de observabilidade |
| Texto livre da mensagem do logger escapava à redação | `scrubText(message)` antes de stdout/Loki | Regressão com Bearer e code/state na mensagem principal, além de senha em campo |
| Runner de observabilidade local usava variáveis ECS removidas | Variáveis do bootstrap Kubernetes; checks HTTP não lançam Jobs nem alteram CronJobs | API iniciada e verificador LGTM real com 34/34 checks |
| Fixtures de ataques a arquivos simulavam usuário 1000 mesmo quando usavam arquivos do usuário real | Propriedade da fixture alinhada a `process.getuid()`, mantendo guardrails e os ataques de troca/symlink/hardlink | Suíte Linux sem falhas; nenhuma proteção da aplicação relaxada |
| CI Node não instalava Python exigido pelo harness de falhas S3 | Dependência Python adicionada e bateria k6 de contratos incluída | Testes de injeção/reversão aprovados na imagem de CI |

A semântica da CPU segue a
[referência AWS](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-metrics-EKS.html):
percentual do limite do Pod, incluindo containers/sidecar; o painel pode ficar
sem métrica quando um container não declara limite. A variável de descoberta
foi conferida no datasource CloudWatch distribuído com Grafana 13.2.1.
Ela não reutiliza o denominador por quantidade de scrapes saudáveis da captura
EKS antiga, que já estava identificado como substituído no artefato.

## Checks de integração

| Check | Resultado |
| --- | --- |
| API: lint, TypeScript, testes e build | 592 testes aprovados, 23 live/integration pulados |
| Agentic: build e testes | 164 aprovados, 2 pulados |
| Node/Linux: Kubernetes, scripts e contratos de carga | 352 aprovados, 3 pulados (inclui testes que exigem kernel Windows) |
| Políticas de CI da API em Linux | 41 aprovadas |
| Terraform | Configuração válida; 7 testes aprovados; providers mockados, sem recursos criados |
| Bootstrap AWS renderizado | Script e placeholders validados; gzip abaixo de 16.384 bytes |
| LGTM real em stack local isolada | 34/34 verificações, três datasources saudáveis e 41 queries sem erro |
| Integridade do artefato RNF | Referências/JSON/fontes e hashes verificados pelo auditor |

O teste de ponta a ponta usou portas dedicadas, DynamoDB Local e os containers
Grafana, Loki, Tempo e Prometheus da revisão integrada. Comprovou headers de
correlação, níveis de logs, templates de rotas, exemplar de trace, TraceQL por
request_id, falhas de login, silêncio das probes e ausência dos segredos
sintéticos em logs/traces. Não mede capacidade EKS nem o kernel Windows real.

No macOS, os testes que dependem de `/proc/self/fd` e Bash `mapfile` não têm
ambiente equivalente ao runner Linux; foram executados na imagem Linux do CI,
com sucesso. As correções Windows do MR estão preservadas para referência e
testes, sem reativar comandos ECS na CLI padrão atual.

## Relação com o artefato de carga

[Documento principal](../testes-carga-finais.md),
[inventário](testes-carga-inventario.md) e
[laboratório](../../apps/backend/api/loadtest/lab/README.md) mantêm seus cenários
e resultados. A nova telemetria fornece request/trace ID, exemplares, falhas
de login e saúde do transporte para investigar as próximas rodadas.
Não elimina as reprovações já medidas em PROJECTING, contrapressão pública
ou disponibilidade sob saturação.
