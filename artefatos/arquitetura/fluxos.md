# Fluxos integrados do View Show

- **Status:** aprovado para implementação
- **Versão:** 1.1
- **Última atualização:** 07/09/2026
- **Responsáveis:** equipe de arquitetura

## 1. Objetivo

Este documento funciona como índice técnico dos fluxos integrados do View Show. A representação canônica dos diagramas de sequência, com participantes, mensagens, alternativas e justificativas acadêmicas, está na [Seção 5 da modelagem](../modelagem.md#5-diagramas-de-sequência).

Os contratos desta pasta definem as regras técnicas citadas nos diagramas. Manter os desenhos em uma única fonte evita divergências entre a modelagem acadêmica e a arquitetura utilizada no desenvolvimento.

## 2. Catálogo dos fluxos

| ID | Cenário | Casos de uso | Seção canônica | Contratos principais |
| --- | --- | --- | --- | --- |
| DS-01A | Sincronização com o MySQL vivo | UC-01, UC-03, UC-04, UC-06, UC-07 | [Sincronização](../modelagem.md#531-ds-01a--sincronização-com-o-mysql-vivo) | ingestão, dados e análise |
| DS-01B | Importação de snapshot pela interface | UC-01, UC-03, UC-04, UC-06, UC-07 | [Importação](../modelagem.md#532-ds-01b--importação-de-snapshot-pela-interface) | API, ingestão e dados |
| DS-02A | Autenticação federada e consulta | UC-01, UC-02 | [Autenticação e consulta](../modelagem.md#541-ds-02a--autenticação-federada-e-consulta) | API e identidade |
| DS-02B | Revisão concorrente de hipótese | UC-03, UC-04 | [Revisão de hipótese](../modelagem.md#542-ds-02b--revisão-concorrente-e-promoção-ao-conjunto-de-referência) | API, auditoria e conjunto de referência |
| DS-02C | Avaliação da recuperação após correção | UC-05 | [Avaliação da recuperação](../modelagem.md#543-ds-02c--avaliação-da-recuperação-após-correção) | API e consultas temporais |
| DS-03A | Previsão preventiva e validação posterior | UC-06 | [Previsão preventiva](../modelagem.md#551-ds-03a--previsão-preventiva-e-validação-posterior) | análise, dados e SQS |
| DS-03B | Detecção reativa e diagnóstico por IA | UC-03, UC-04, UC-06 | [Detecção e diagnóstico](../modelagem.md#552-ds-03b--detecção-reativa-e-diagnóstico-por-ia) | análise, Bedrock e conjunto de referência |
| DS-03C | Recuperação de falhas e reanálise | UC-04, UC-07 | [Recuperação e reanálise](../modelagem.md#553-ds-03c--recuperação-de-falhas-mensagens-não-processadas-e-reanálise) | análise, SQS, DLQ e API |
| DS-04 | Visão geral ponta a ponta | UC-01, UC-02, UC-03, UC-04, UC-06 | [Fluxo ponta a ponta](../modelagem.md#56-visão-geral-ponta-a-ponta) | todos os contratos arquiteturais |

## 3. Invariantes transversais

Os nove fluxos obedecem às seguintes regras:

- o Backend é a única interface pública para consultas e comandos do dashboard;
- a autenticação corporativa ocorre pelo Cognito federado ao SSO da Globo;
- o DynamoDB mantém até 30 dias de fatos e projeções para consultas de baixa latência;
- o S3 mantém em Parquet os 11 meses anteriores, o Glue Data Catalog registra schemas e partições e o Athena executa consultas históricas;
- uma consulta que atravessa a fronteira temporal combina as duas camadas sob o mesmo `datasetVersion` e elimina duplicatas pelo identificador canônico;
- a ingestão publica na SQS somente depois de materializar a janela e registrar a intenção na outbox;
- o Worker trata mensagens duplicadas e fora de ordem por `eventId`, `idempotencyKey` e estado persistido;
- o Bedrock produz hipóteses candidatas, nunca decisões definitivas;
- somente uma hipótese confirmada por uma pessoa cria um `GoldenCase`;
- hipóteses refutadas podem registrar a causa alternativa informada, e hipóteses inconclusivas permanecem revisáveis;
- falhas preservam o último dataset ativo, os resultados intermediários e as mensagens recuperáveis.

## 4. Responsabilidade de cada contrato

| Assunto | Fonte normativa |
| --- | --- |
| Componentes, limites, comunicação e decisões gerais | [Visão geral](visao-geral.md) |
| Normalização, identidades, armazenamento quente, arquivo histórico, projeções e outbox | [Ingestão e dados](ingestao-e-dados.md) |
| SQS, modelos, diagnóstico, revisão humana e recuperação de falhas | [Análise de dados e diagnóstico por IA](analise-e-ia.md) |
| Endpoints, DTOs, autenticação, paginação, importação e comandos | [API do dashboard](api-dashboard.md) |
| Participantes e ordem das interações | [Diagramas de sequência](../modelagem.md#5-diagramas-de-sequência) |
| Diferença entre arquitetura-alvo e código disponível | [Status de implementação](status-implementacao.md) |

## 5. Regra de manutenção

Uma alteração na ordem das interações deve ser realizada na modelagem e refletida, quando necessário, no catálogo e nas invariantes deste índice. Uma alteração de contrato deve ser feita no documento normativo responsável e conferida nos diagramas afetados. Este arquivo não deve reproduzir diagramas completos.
