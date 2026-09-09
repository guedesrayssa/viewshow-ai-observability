# Status de implementação da arquitetura

- **Status:** acompanhamento contínuo
- **Versão:** 1.1
- **Última atualização:** 07/09/2026
- **Responsáveis:** equipe do projeto
- **Base auditada:** branch `docs/sequencia-uml`, estado anterior ao ajuste arquitetural `8f55706`

## 1. Finalidade

Este documento registra quanto da arquitetura-alvo já está presente no código. Ele não redefine contratos. Em caso de divergência, prevalecem os documentos normativos desta pasta.

Estados utilizados:

- **Definido:** contrato aprovado, mas implementação ainda não iniciada nesta branch.
- **Parcial:** existe uma base funcional, porém faltam requisitos do contrato.
- **Implementado:** código presente e compatível com o contrato.
- **Testado:** implementação compatível e coberta pelas verificações previstas.
- **Bloqueado:** depende de informação, acesso ou decisão externa.

## 2. Resumo executivo

| Área | Estado | Evidência atual | Próximo resultado esperado |
| --- | --- | --- | --- |
| Documentação arquitetural | Implementado | documentos em `artefatos/arquitetura` | revisão da equipe |
| Backend operacional | Parcial | `apps/backend/api` | adequar endpoints e DTOs ao contrato |
| Frontend operacional | Parcial | telas em `apps/frontend/app/(painel)` | consumir somente a API operacional-alvo |
| Autenticação federada | Parcial | sessão local, middleware e rota SSO iniciais | Cognito federado, callback e cookie seguro |
| Serviço de ingestão | Definido | contrato e arquitetura aprovados | criar `apps/backend/ingestion-data` |
| Arquivo histórico S3/Glue/Athena | Definido | retenção e roteamento especificados | provisionar bucket, catálogo, workgroup e compactação Parquet |
| Importação de dump | Definido | fluxo, API e persistência documentados | upload multipart e tarefa Fargate |
| SQS e outbox de análise | Definido | contratos de dados e eventos aprovados | provisionar fila, DLQ e publisher |
| Worker de Análise | Definido | contrato de análise aprovado | implementar consumidor, detector e previsão |
| Diagnóstico com Bedrock | Parcial | módulos iniciais no backend | mover responsabilidade para o Worker e aplicar o contrato |
| Revisão e conjunto de referência | Parcial | rota, serviço e tabela iniciais | concorrência otimista e promoção transacional |
| Infraestrutura AWS | Parcial | CI/CD e task definition do backend | provisionar recursos restantes e permissões |
| Observabilidade ponta a ponta | Definido | métricas e alarmes especificados | instrumentar `traceId`, runs, fila e DLQ |

O estado **Implementado** da documentação significa que os arquivos foram criados, não que todos os componentes descritos já existam. Cada linha deve ser atualizada no mesmo MR que entregar sua implementação.

## 3. Backend e API

### 3.1 O que existe

A API Node/Express possui rotas de saúde, autenticação inicial, incidentes, evidência, hipótese, revisão, diagnóstico, dashboard resumido, golden set e ML. Também existem middleware de sessão, clientes DynamoDB e módulos iniciais para orquestração e Bedrock.

### 3.2 Diferenças para o contrato-alvo

| Contrato-alvo | Implementação observada | Estado |
| --- | --- | --- |
| `GET /dashboard/overview` | `GET /dashboard/summary` | Parcial |
| `GET /incidents` com cursor e facetas | listagem básica | Parcial |
| `GET /incidents/{id}/diagnosis` | leituras separadas de incidente, evidência e hipótese | Parcial |
| revisão por `hypothesisId` e `expectedVersion` | revisão de uma hipótese sem versão | Parcial |
| eventos correlacionados | rota ausente | Definido |
| monitoramento operacional | rota ausente | Definido |
| importação de dump | rotas ausentes | Definido |
| reanálise assíncrona | diagnóstico síncrono inicial | Definido |
| autenticação Cognito/SSO | login local e rota SSO inicial | Parcial |

Antes de declarar conformidade, o Backend deve validar path, query e body; produzir o envelope público; ocultar `pk`, `sk`, TTL e identificadores físicos; preservar `null` versus zero; implementar cursores opacos; e devolver estados de parcialidade e frescor.

As rotas públicas de golden set e ML pertencem à implementação inicial e não devem receber novos consumidores. No desenho-alvo, elas são responsabilidades internas do Backend e do Worker de Análise.

## 4. Frontend

### 4.1 O que existe

Existem páginas de visão geral, incidentes, evidências, eventos e monitoramento. A camada `apps/frontend/lib/data` centraliza chamadas e já diferencia dado medido, parcial, indisponível e de exemplo.

### 4.2 Diferenças para o contrato-alvo

O frontend atual ainda conhece duas APIs: a operacional Node/Express e a telemetria Flask. A arquitetura-alvo oferece uma API operacional única, que lê as projeções produzidas pela ingestão. A migração deve ocorrer por recurso, mantendo dados de exemplo somente em desenvolvimento e demonstração.

Também faltam o fluxo de upload multipart, o acompanhamento de `ImportJob`, a sessão federada pelo Cognito e a integração completa da revisão concorrente.

## 5. Ingestão e dados

O diretório `apps/backend/ingestion-data` ainda não existe nesta branch. Antes da implementação, a equipe deve usar [Ingestão e dados](ingestao-e-dados.md) como contrato para:

1. criar domínio, portas e adaptadores;
2. validar os schemas do ARGUS;
3. implementar IDs e hashes determinísticos;
4. persistir no DynamoDB os fatos e as projeções dos últimos 30 dias;
5. arquivar os 11 meses anteriores em Parquet no S3 e registrar as partições no Glue;
6. implementar checkpoint e bloqueio temporário;
7. construir as projeções sem `Scan` e o roteamento histórico pelo Athena;
8. implementar outbox e publicação da análise;
9. adicionar tarefas ECS, Scheduler e observabilidade.

A implementação só avança para a janela seguinte depois que fatos, projeções e watermark da janela atual estiverem consistentes.

## 6. Análise e IA

O consumidor da SQS, o detector e o modelo de previsão ainda não existem nesta branch. Os módulos `src/orchestrator`, `src/agent` e `bedrockService` da API são uma base experimental; eles não comprovam conformidade com o Worker definido em [Análise e diagnóstico por IA](analise-e-ia.md).

Ordem recomendada:

1. contrato e validação das mensagens;
2. `AnalysisRun` e idempotência;
3. leitura das janelas materializadas;
4. detector e persistência de evidências;
5. previsão e avaliação posterior;
6. orquestrador e qualidade mínima;
7. agente diagnóstico e Bedrock;
8. conjunto de referência somente para leitura;
9. tentativas, DLQ, métricas e alarmes.

## 7. Infraestrutura e segurança

A branch possui pipeline e definição de tarefa para o Backend. Ainda precisam ser verificados ou provisionados:

- conectividade privada com o ARGUS;
- task de ingestão e EventBridge Scheduler;
- bucket e políticas para importação multipart;
- prefixos Parquet, Glue Data Catalog e workgroup do Athena para o arquivo histórico;
- tabelas operacionais e de referência com permissões separadas;
- fila de análise e DLQ;
- ECS Service do Worker de Análise;
- Cognito federado ao SSO;
- alarmes e painéis do CloudWatch;
- permissões do Bedrock e sanitização dos contextos.

Nenhuma atividade de implementação deve depender de credencial compartilhada. Cada componente utiliza role IAM própria e de menor privilégio.

## 8. Bloqueios e confirmações externas

- Endereço, porta e mecanismo de conectividade autorizados para o MySQL vivo do ARGUS.
- Schema físico final e SLA de cada dataset.
- Origem de eventos individuais que não podem ser derivados de agregados.
- Configuração do SSO corporativo no Cognito.
- Política de retenção definitiva dos dumps no S3.
- Limiares aprovados para detecção, previsão e qualidade mínima.

Esses itens não impedem testes locais com contratos e adaptadores. Eles impedem somente declarar a integração produtiva como concluída.

## 9. Regra de atualização

Todo MR que implementar uma parte da arquitetura deve:

1. atualizar o estado da linha correspondente;
2. apontar arquivos e testes como evidência;
3. registrar bloqueios descobertos;
4. atualizar o contrato quando houver uma decisão aprovada;
5. evitar marcar **Implementado** apenas porque existe um arquivo ou protótipo.

## 10. Documentos relacionados

- [Visão geral da arquitetura](visao-geral.md)
- [Fluxos integrados](fluxos.md)
- [Ingestão e dados](ingestao-e-dados.md)
- [Análise de dados e diagnóstico por IA](analise-e-ia.md)
- [API do dashboard](api-dashboard.md)
