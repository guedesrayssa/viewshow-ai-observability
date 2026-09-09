# Status de implementação da arquitetura

- **Status:** acompanhamento contínuo
- **Versão:** 1.2
- **Última atualização:** 09/09/2026
- **Responsáveis:** equipe do projeto
- **Base auditada:** branch `refactor/backend` alinhada a `develop`

## 1. Finalidade

Este documento registra o que da arquitetura-alvo já existe no código. Ele não
redefine contratos; em caso de divergência, prevalecem os documentos normativos
desta pasta.

Estados utilizados: **Definido** para contrato ainda não iniciado, **Parcial**
para implementação incompleta, **Implementado** para código compatível e
**Testado** quando as verificações automatizadas correspondentes estão presentes.

## 2. Resumo executivo

| Área | Estado | Evidência atual | Pendência principal |
| --- | --- | --- | --- |
| Backend operacional | Testado | monólito modular TypeScript/Express em `apps/backend/api/src` | ampliar integrações históricas e assíncronas |
| Frontend operacional | Parcial | telas em `apps/frontend/app/(painel)` consomem a API operacional | upload, importação e SSO corporativo |
| Autenticação federada | Testado | rotas federadas, sessão assinada e provider fail-closed cobertos no E2E local | disponibilizar o adaptador Cognito/OIDC |
| Importação de dump | Testado | rotas e validação cobertas; adaptador S3/ingestão falha fechado | disponibilizar upload e tarefa de ingestão |
| Serviço de ingestão | Definido | placeholder em `apps/backend/ingestion-data` | implementar tarefa Python e projeções |
| Arquivo S3/Glue/Athena | Definido | contratos aprovados | provisionar e implementar roteamento histórico |
| SQS e Worker de Análise | Definido | contrato de publicação fail-closed testado e placeholder `apps/backend/agentic` | disponibilizar fila, DLQ, consumidor e modelos |
| Revisão de hipótese | Testado | atualização condicional e autorização no módulo `incidents` | integração com o Worker e conjunto real |
| Infraestrutura AWS | Parcial | API em ECS, DynamoDB, ingresso e CI/CD existentes | recursos de ingestão, análise, histórico e identidade |
| Observabilidade | Parcial | request ID, logs, métricas RED e OpenTelemetry na API | correlação ponta a ponta e alarmes dos workers |

## 3. Backend e API

A API é um único processo Express 5 cujo código fonte executável está em
TypeScript. Os módulos `auth`, `dashboard` e `incidents` ficam no mesmo processo
e preservam limites internos por portas e adaptadores. Não existem gateway
separado, APIs HTTP internas ou supervisor multiprocesso.

| Contrato-alvo | Implementação atual | Estado |
| --- | --- | --- |
| `GET /dashboard/overview` | KPIs, saúde da experiência e incidentes recentes na mesma janela | Testado |
| `GET /incidents` | filtros suportados, cursor opaco e famílias horária/diária | Testado |
| `GET /incidents/{id}/diagnosis` | incidente, evidências e hipóteses persistidas | Testado |
| revisão com `hypothesisId` e `expectedVersion` | autorização e atualização condicional | Testado |
| eventos correlacionados | agregado quando disponível; evento individual declara indisponibilidade | Parcial |
| `GET /monitoring/overview` | leitura de projeção com frescor e parcialidade | Testado |
| importação de dump | rotas registradas, entrada/autorização validadas e adaptador indisponível | Testado |
| reanálise assíncrona | rota validada e publicação SQS indisponível/fail-closed | Testado |
| autenticação Cognito/SSO | login, callback, sessão e logout federados; provider indisponível/fail-closed | Testado |

Os endpoints validam path, query e body, devolvem envelope público, preservam
`null` versus zero e não expõem `pk`, `sk`, TTL ou cursor físico. Filtros para
os quais ainda não existe projeção são rejeitados com 422; não são ignorados.
A paridade entre manifesto, OpenAPI e rotas Express é testada. O E2E vivo com
DynamoDB Local cobre a superfície HTTP, persistência de revisão e os limites
fail-closed sem credenciais AWS reais.

## 4. Frontend

A camada `apps/frontend/lib/data` centraliza as chamadas e diferencia dado
medido, parcial, indisponível e de exemplo. A Visão Geral usa somente
`GET /api/v1/dashboard/overview`: indicadores, gráfico e incidentes compartilham
a mesma janela e a mesma procedência. Os filtros dimensionais continuam
desabilitados enquanto o backend só publica a projeção global.

Não há dependência ativa da API Flask de telemetria na Visão Geral. Permanecem
pendentes o upload multipart, acompanhamento de `ImportJob`, o adaptador
Cognito/OIDC e integrações cuja fonte de dados ainda não foi publicada.

## 5. Ingestão, histórico e análise

`apps/backend/ingestion-data` e `apps/backend/agentic` são placeholders sem
servidor, worker, seed ou lógica executável. A implementação futura deve seguir
[Ingestão e dados](ingestao-e-dados.md) e
[Análise de dados e diagnóstico por IA](analise-e-ia.md): normalização,
projeções, watermark/outbox, arquivo Parquet, SQS, modelos e Bedrock pertencem a
esses componentes, não à API operacional.

O Terraform não semeia dados sintéticos no DynamoDB. A API lê projeções
publicadas pelo fluxo de ingestão e declara ausência de forma explícita.
Os contratos de importação e publicação de reanálise existem na API, mas seus
adaptadores permanecem indisponíveis e retornam `FEATURE_UNAVAILABLE`.

## 6. Infraestrutura e segurança

A branch preserva o pipeline, a imagem e a task da API existentes. Ainda
precisam ser provisionados ou confirmados: conectividade com o ARGUS, task e
Scheduler de ingestão, S3/Glue/Athena, SQS/DLQ, Worker de Análise, Cognito e os
alarmes ponta a ponta.

O job de validação do backend executa a suíte regular e o E2E vivo contra
DynamoDB Local por `DYNAMODB_ENDPOINT=http://dynamodb:8000`, usando somente
credenciais dummy. A variante local é `npm run test:e2e-local`; nenhuma delas
requer acesso a recursos AWS.

Nenhuma implementação depende de credencial compartilhada no código. A
atualização temporária do profile e das variáveis do Learner Lab é uma atividade
operacional posterior e não altera a arquitetura da aplicação.

## 7. Bloqueios externos

- conectividade autorizada e schema final do ARGUS;
- origem de eventos individuais;
- configuração do SSO corporativo no Cognito;
- política definitiva de retenção dos dumps;
- limiares aprovados de detecção, previsão e qualidade mínima;
- credenciais temporárias válidas do Learner Lab no momento do deploy.

Esses itens não impedem testes locais dos contratos, casos de uso e adaptadores.

## 8. Regra de atualização

Todo MR que implementar parte da arquitetura deve atualizar esta matriz,
apontar arquivos e testes como evidência e registrar bloqueios descobertos. Um
arquivo vazio ou placeholder não deve ser marcado como implementação.

## 9. Documentos relacionados

- [Visão geral da arquitetura](visao-geral.md)
- [Fluxos integrados](fluxos.md)
- [Ingestão e dados](ingestao-e-dados.md)
- [Análise de dados e diagnóstico por IA](analise-e-ia.md)
- [API do dashboard](api-dashboard.md)
