# Fechamento AWS dos testes não funcionais — 06/10/2026

Conta `239162056821`, região `us-east-1`. A linha de base ECS usou o cluster
`view-show-iac-cluster`; o fechamento complementar criou o cluster EKS isolado
`view-show-rnf-eks` com dois nós `i3.large` e ALB dedicado.
A coleta começou na revisão base `eca9de4` com scripts complementares. Durante
as repetições, `develop` avançou para `d5339f3` (migração Kubernetes), incorporada
à branch do artefato. Os cenários k6 e o core Python não mudaram nessa migração;
a imagem ECS implantada é registrada separadamente. A terceira repetição usa
runner no checkout novo, mantendo o mesmo perfil e ambiente ECS. O EKS foi
provisionado depois, com papéis pré-existentes do laboratório, dados e filas
próprios e imagens pinadas por digest. As conclusões separam explicitamente os
dois ambientes.
[Registro da atualização](develop-update.json).
[Análise consolidada](../../../artefatos/testes-carga-finais.md).

## Ambiente identificado

| Componente | Configuração efetivamente observada |
| --- | --- |
| API | `view-show-iac-api-task:1`, imagem `view-show-iac-api:ab0f99a3c385`; 0,25 vCPU / 512 MiB; uma task inicialmente |
| Ingestão | `view-show-ingestion-import:1`, imagem por digest `sha256:0c1e1b2e8689f3ab9e040acebec7b095b5fa433fea141ec11f0da3d4c39ed665`; 2 vCPU / 8 GiB, sidecar MySQL |
| HTTP | API Gateway → ALB → ECS; gerador fora da região; internet incluída na latência k6 |
| Autenticação da carga | sessão assinada de operador sintético em memória; login Cognito não medido |
| Observabilidade | API /metrics coletada por Prometheus a cada 5 s; worker via CloudWatch/Container Insights; Grafana local consulta a conta do teste |
| Massa | 750.000 registros determinísticos, 150.000 por janela de 15 min, variante fechamento, data de extração 06/10/2026 |
| Ativação | o teste não ativa automaticamente a versão candidata |

## Arquivos

| Caminho | Conteúdo e regra de interpretação |
| --- | --- |
| `source-baseline-eca9de4/` | arquivos Terraform ECS congelados antes da migração; permitem conferir configuração, fontes de alarmes e parâmetros originais |
| `develop-update.json` | revisão nova, ausência de cluster EKS e distinção entre testes estáticos/locais e carga ECS |
| `cg05-750000/metadata.json` | conta, região, URL, início/fim, recursos, imagem e exit code; início 06/10 23:10:21 UTC |
| `cg05-750000/resumo-ingestao-cg05-750000.json` | métricas/checks/thresholds do cenário atual; somente existe após terminar a execução |
| `observability/grafana-panel-*.json` | respostas reais do Grafana para cada query e janela; não inferir zero de frame vazio |
| `observability/prometheus-panel-*.json` | séries temporais da API e PromQL efetivamente usada |
| `observability/prometheus-targets.json` | saúde e configuração dos scrapes |
| `observability/observability-validation.json` | status HTTP, amostras numéricas e erros por painel; gate rejeita ausência de amostras |
| `eks-native/` | cluster, nós, ALB, contrato redigido, imagens, Jobs e evidências Prometheus da implantação Kubernetes dedicada |

A primeira validação autenticou incorretamente o datasource como par estático;
isso não carrega o session token do laboratório. A versão final usa AWS SDK
Default com credenciais temporárias em arquivo privado do contêiner. A correção
não muda permissões IAM e os segredos não são versionados. Queries inválidas e
frames vazios não são apresentados como aceite visual.

## Observabilidade na mesma execução

![Grafana da ingestão AWS](grafana-ingestion-aws.png)

O dashboard rnf-ingestion-aws-control seleciona somente as rotas /imports para
latência HTTP, throughput de controle e 5xx/s, e utiliza a CPU reservada da task
import-dump. Janela 23:10–23:42 UTC. O gate em
[observability-ingestion/observability-validation.json](observability-ingestion/observability-validation.json)
comprovou amostras numéricas em todos os quatro painéis. Zero erros é derivado
de um contador de requisições realmente coletado; não se preenche ausência de
coleta como sucesso. O dashboard complementar batch conserva os frames vazios
e suas limitações enquanto as métricas terminais não forem emitidas.

## Resultado e limites

A rodada de 750 mil chegou a INGESTING completo (750.000 escritos, zero rejeitados),
mas não chegou a READY. Em 07/10 00:36:21 UTC, após 5.159,619 s desde o início
do runner, sua task foi interrompida por esgotamento do orçamento proporcional
de 4.500 s. A intervenção ocorreu após observar o prazo excedido e é registrada
como desvio do poll original de 10.800 s, sem reescrever os brutos. O estado
final foi FAILED/WORKER_STOPPED, exitCode 137 no worker e 99 no k6. Isso é
observação censurada de capacidade, não conclusão de projeção/arquivamento.
O tempo k6 até FAILED foi 5.250,877 s; throughput 0 no resumo significa zero
versões READY, não zero dados persistidos.

A [recontagem independente](independent-count-750000.json) confirmou 750.000
registros nos 23 datasets em 126,965 s. O
[resumo analítico](cg05-750000/analysis-summary.json) separa contagem, timeout,
limite de vazão e ausência de conclusão. O limite superior aproximado de vazão
completa no instante da censura é 8.722 eventos/min, abaixo da meta.

A primeira recuperação falhou por LeaseBusy (INTERNAL_ERROR público, causa
segura nos logs). Após expirar a posse anterior, outra importação chegou a READY
com 1.000/1.000, sem reiniciar a API. Brutos em `recovery-1000/` e
`recovery-after-lease/`. O alerta observável disparou em 18,448 s; essa amostra
não demonstra cobertura do cancelamento externo.

A execução preserva seu resultado terminal e as limitações da observação.
A etapa e as contagens foram acompanhadas pela API, pelo log do run e pelas métricas,
sem confundir progresso INGESTING com READY. O namespace e o comando observados
são `view-show/Ingestion` e `import-dump`; CPU utiliza a família correta da task,
que difere de backfill apesar de compartilhar o grupo de logs.

[Reprodução do laboratório](../../../apps/backend/api/loadtest/lab/README.md).
Os quatro indicadores da API têm séries numéricas verificadas; painéis batch
continuam sujeitos à emissão das métricas de etapas/runs. A ausência de estado
terminal deve ser documentada como falha operacional, não como disponibilidade.

## Execuções EKS nativas

| Cenário | Resultado observado | Evidência |
| --- | --- | --- |
| API smoke + recovery | `/health` 200 antes da carga e smoke 200 após a recuperação | [`api-smoke/`](eks-native/api-smoke/) e [`api-recovery/`](eks-native/api-recovery/) |
| API-137 | ~43 mil requisições; ~1.003 descartes/erros; 503/timeouts; HPA 1→4; reinícios por liveness | [`api-load-137/`](eks-native/api-load-137/) |
| Ingestão válida, 1.000 | `READY`, 1.000 escritos, 0 rejeitados, 120,65 s | [`ingestion-valid/`](eks-native/ingestion-valid/) |
| Nominal, 150.000 | multipart e `complete` aceitos; `PROCESSING` excedeu 900 s; `exitCode=99` | [`nominal-150000/`](eks-native/nominal-150000/) |
| Admissão | 1 Job válido + 7 controles negativos aprovados em `dry-run=server` | [`admission-negative-controls.json`](eks-native/admission-negative-controls.json) |
| Prometheus EKS | quatro painéis, 73 amostras numéricas por painel, `passed=true` | [`observability-load137-final/`](eks-native/observability-load137-final/) |

O nominal de 150 mil não é convertido em aprovação. O worker permaneceu em
`INGESTING/PROCESSING` além da janela e a investigação encontrou um ponteiro
ACTIVE de fixture que não cumpria o contrato completo do repositório de
manifestos. A entrada sintética foi removida condicionalmente da tabela EKS
dedicada; a tabela ECS histórica permaneceu intocada. O cenário de 1.000 é a
evidência positiva de caminho, e o de 150 mil é a evidência negativa de
resiliência/capacidade que orienta a decisão de otimizar a etapa posterior à
ingestão antes de aumentar recursos.
