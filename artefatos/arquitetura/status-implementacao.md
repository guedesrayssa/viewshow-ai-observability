# Status de implementação da arquitetura

- **Status:** acompanhamento contínuo
- **Versão:** 2.4
- **Última atualização:** 17/09/2026
- **Responsáveis:** equipe do projeto
- **Base auditada:** integração em andamento entre a `develop` e a entrega de ingestão ARGUS 2.0

## 1. Finalidade

Este documento registra o que da arquitetura-alvo já existe no código. Ele não
redefine contratos; em caso de divergência, prevalecem os documentos normativos
desta pasta.

Estados utilizados: **Definido** para contrato ainda não iniciado, **Parcial**
para implementação incompleta, **Implementado** para código compatível,
**Testado** quando há verificações automatizadas e **Pendente AWS** quando a
conclusão depende de nova evidência operacional.

## 2. Resumo executivo

| Área | Estado | Evidência atual | Pendência principal |
| --- | --- | --- | --- |
| Backend operacional | Testado | monólito modular TypeScript/Express em `apps/backend/api/src` | concluir consumo das projeções versionadas por `ACTIVE` sem perder as consultas atuais |
| Frontend operacional | Parcial | telas em `apps/frontend/app/(painel)` consomem a API e emitem RUM | upload/importação e SSO corporativo |
| Autenticação | Testado | login direto no Cognito, sessão assinada e autorização; rotas federadas continuam fail-closed | federação Cognito ↔ SSO corporativo |
| Importação de dump | Parcial | uploader, launcher e backfill reduzido validados no Learner Lab; rotas HTTP preservam validação e fail-closed | integrar upload e `ImportJob` à API |
| Ingestão ARGUS 2.0 | Testado na AWS | worker Python batch-only, allowlist de 23 datasets, retomada idempotente e smoke reduzido concluído | executar prova de capacidade com dump representativo |
| S3, Glue e Athena | Testado na AWS | 23 archives Parquet reconciliados, 23 tabelas/partições Glue e consultas Athena validadas | validar volume, custo e retenção em escala representativa |
| DynamoDB e outbox | Implementado | manifesto, hot store, projeções, leases, GSI e recuperação idempotente | consumo completo das projeções pela API |
| SQS e análise | Parcial | fila/DLQ e publisher da outbox; camada agêntica implementada e testada localmente | executar o Worker de Análise integrado na AWS |
| Infraestrutura AWS | Testado na AWS | stack integrada aplicada no Learner Lab e plano posterior com 103 recursos `no-op` | prova de capacidade, alta disponibilidade e estratégia de produção |
| Observabilidade | Parcial | logs, RED, RUM, OpenTelemetry, dashboards, alertas e Flow Logs | correlação integrada dos workers na AWS |
| Sync live | Testado localmente | gate DynamoDB compartilhado, GET/PATCH autenticados, coordenação fail-closed do Scheduler e switch em Configurações | comprovar segredo, rede, permissões da `LabRole` e conectividade com o ARGUS na AWS |

## 3. Backend, API e frontend

A API continua sendo um único processo Express 5 em TypeScript, com os módulos
`auth`, `dashboard` e `incidents`. As consultas e mutações existentes da
`develop` devem ser preservadas. A autenticação operacional usa
`USER_PASSWORD_AUTH` no Cognito e cookie de sessão assinado; a federação com o
SSO corporativo permanece arquitetura-alvo, não funcionalidade já entregue.

A integração versionada com a ingestão ainda não pode ser marcada como completa.
Ela deve ler `CONTROL#DATASET / ACTIVE` consistentemente, fixar
`datasetVersion` em cursores e consultar somente chaves dessa versão. Ausência
ou incompatibilidade do manifesto falha fechada, mas um `ACTIVE` válido não
pode tornar indisponíveis as consultas que a `develop` já atende.

O frontend mantém as telas operacionais, o cliente de dados e a instrumentação
RUM. Upload multipart, acompanhamento de `ImportJob` e federação corporativa
continuam pendentes.

## 4. Ingestão e dados

`apps/backend/ingestion-data` contém um worker Python batch-only, sem Flask,
endpoint HTTP ou ECS Service. O backfill restaura o snapshot S3 em um MySQL
sidecar efêmero, valida o contrato físico ARGUS 2.0, normaliza 23 datasets e
materializa DynamoDB, Parquet, Glue/Athena e outbox sob uma
`datasetVersion` determinística.

A promoção para `ACTIVE` é condicional e ocorre somente depois das validações.
Falha anterior preserva o ativo; falha de publicação posterior mantém a outbox
pendente e termina como `PARTIAL`. O controle live já é implementado: o item
`CONTROL#ARGUS`/`LIVE_SYNC` autoriza `sync` e `reprocess`, e a API coordena o
estado do Scheduler em ordem fail-closed. A seed e a origem live continuam
desligadas até conectividade e prova específicas; isso é pendência de evidência
AWS, não ausência do controle no código.

O dump reduzido concatena schema e fixture cobrindo as 23 tabelas e produz gzip
determinístico. Ele é smoke funcional, não teste de capacidade, orçamento de
disco, particionamento em volume ou escala Athena. A execução reduzida na AWS
foi concluída em 12/09/2026; a prova com volume representativo continua
separada e pendente.

## 5. Camada agêntica

`apps/backend/agentic` preserva a implementação da `develop`: contratos de
evento, investigação, quality gate, providers Bedrock/Ollama/fake, prompts e
testes, além dos hooks Python de observabilidade. Isso não equivale a um Worker
de Análise implantado; consumo SQS, persistência integrada e operação AWS ainda
precisam de evidência.

## 6. Infraestrutura, segurança e observabilidade

A stack `apps/fullstack` declara VPC dedicada em duas AZs, sub-redes públicas e
privadas, NAT/endpoints, API Fargate privada, ALB, bastion, Flow Logs, Cognito,
DynamoDB, autoscaling e observabilidade. A ingestão acrescenta tasks Fargate,
bucket S3, Glue/Athena, SQS/DLQs, segredos e alarmes; o Scheduler nasce
`DISABLED`.

Não há conta literal como requisito da stack: o operador deve confirmar a
identidade do Learner Lab e preservar o state correspondente. Produção continua
exigindo rede privada, roles próprias, segredos externos e imagens por digest.

Além do ciclo anterior de `apply` e `destroy`, a stack integrada está novamente
provisionada no Learner Lab para inspeção. O plano executado foi revisado antes
do `apply`; após a correção e o smoke, um novo plano confirmou 103 recursos
`no-op`. O bucket versionado preservou os objetos anteriores como previsto pelo
runbook.

A observabilidade preserva métricas RED da API, RUM do frontend, OpenTelemetry,
dashboards e alertas, além de logs e métricas da ingestão. A stack LGTM em EC2 é
opcional e acessada por túnel SSM.

## 7. Evidência AWS registrada

Em 12/09/2026, a cadeia reduzida foi validada na região `us-east-1` com a role
temporária `voclabs`, sem gravar número de conta ou credenciais no repositório:

1. o dump de 4.906 bytes, SHA-256
   `ef9fa79df18511a4046fc88b5bffdedc981502f1262429a96d5933ef3d815c2d`
   e data de extração `2026-09-01` gerou a versão
   `dsv_25b48847e57d40bd106f3bb74b697bade5076885d4127336fc9e6ba0780cc9cd`;
2. a task `39c135c80d184840a4ead6f6bc10648c`, na revisão `:7` e imagem
   `sha256:c715bbd2ecc4f1f03e659991ca242dc0facc8cbf5821255d18f2db6733c14748`,
   terminou com exit code zero nos contêineres de ingestão e MySQL;
3. o run `backfill-81c053c1cac37e90ee5061df81e462561f41b7ce` terminou em
   `SUCCEEDED`; seus contadores são zero porque os 29 registros foram
   recuperados de checkpoints de tentativas anteriores, enquanto o manifesto
   reconciliado registra 29 persistidos e zero rejeitados em 23 datasets;
4. 23 archives ficaram `AVAILABLE`, com 23 objetos staging, 23 objetos
   canônicos, 23 tabelas/partições Glue e 23 validações Athena bem-sucedidas;
5. o manifesto `CANDIDATE` foi criado com cinco validações `PASSED`, mas
   `ACTIVE`, projection fence e outbox permaneceram ausentes; a fila ficou
   vazia e o Scheduler continuou `DISABLED`;
6. a API respondeu `200` em `/health` e `/metrics`, o target do ALB permaneceu
   saudável, o painel respondeu `200` e seu proxy devolveu o `401` esperado sem
   sessão;
7. um plano posterior ao deploy informou 103 recursos `no-op` e nenhuma
   mudança, comprovando reconciliação entre código, state e AWS.

As falhas intermediárias foram preservadas como runs `FAILED` e revelaram
divergências reais de caixa no Glue, round-trip decimal no DynamoDB e paginação
de fronteira no Athena. Cada causa recebeu teste regressivo antes da correção;
a retomada reutilizou checkpoints e objetos já publicados sem limpeza manual.
A evidência ainda não cobre capacidade, custo ou tempo de execução com o dump
completo/representativo, nem autoriza a promoção da candidata.

## 8. Bloqueios externos

- conectividade autorizada com o ARGUS live;
- origem de eventos individuais;
- configuração do SSO corporativo no Cognito;
- execução integrada do Worker de Análise;
- limiares aprovados de detecção, previsão e qualidade;
- credenciais temporárias válidas do Learner Lab para novas operações ou para
  destruir a stack atualmente provisionada.

## 9. Regra de atualização

Todo MR que implementar parte da arquitetura deve atualizar esta matriz,
apontar arquivos e testes como evidência e registrar bloqueios descobertos.
Teste local, smoke reduzido e prova de capacidade devem permanecer categorias
distintas.

## 10. Documentos relacionados

- [Visão geral da arquitetura](visao-geral.md)
- [Fluxos integrados](fluxos.md)
- [Ingestão e dados](ingestao-e-dados.md)
- [Análise de dados e diagnóstico por IA](analise-e-ia.md)
- [API do dashboard](api-dashboard.md)
- [Runbook operacional da ingestão](../../apps/backend/ingestion-data/README.md)
- [Infraestrutura integrada](../sprint3/infraestrutura-integracao.md)
