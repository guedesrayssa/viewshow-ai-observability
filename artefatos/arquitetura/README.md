# Arquitetura do View Show

- **Status:** fonte oficial para desenvolvimento
- **Versão:** 1.0
- **Última atualização:** 06/09/2026
- **Responsáveis:** equipe do projeto

## Objetivo

Esta pasta reúne as decisões e os contratos técnicos que orientam a
implementação do View Show. Documentos de sprint registram o processo acadêmico
e podem resumir essas informações, mas a definição mantida para desenvolvimento
fica aqui.

A regra editorial é **uma decisão, um único lugar oficial**. Quando um arquivo
precisar mencionar uma regra pertencente a outro, ele deve resumir o contexto e
apontar para o documento responsável, sem criar uma segunda definição.

## Ordem de leitura

1. [Visão geral](visao-geral.md): componentes, comunicação, AWS, segurança e
   decisões arquiteturais.
2. [Fluxos integrados](fluxos.md): comportamento do sistema em cenários de
   sucesso, alternativa e falha.
3. Documento específico da área em desenvolvimento.
4. [Status de implementação](status-implementacao.md): cobertura atual,
   responsáveis, evidências e bloqueios.

## Documentos

### [Visão geral da arquitetura](visao-geral.md)

Explica os limites do sistema, as responsabilidades dos componentes, os tipos
de comunicação e as decisões que todas as equipes devem respeitar.

### [Fluxos integrados](fluxos.md)

Contém os diagramas Mermaid de ingestão, importação, autenticação, consulta,
análise, diagnóstico, revisão e recuperação.

### [Ingestão e dados](ingestao-e-dados.md)

É a fonte normativa para ARGUS, dump, normalização, DynamoDB, padrões de
`Query`, projeções, checkpoint, watermark, bloqueio temporário, outbox e
publicação das solicitações de análise.

### [Análise de dados e diagnóstico por IA](analise-e-ia.md)

É a fonte normativa para SQS, Worker de Análise, modelos, versionamento de
dataset, orquestrador, Bedrock, incidentes, hipóteses, repetição e DLQ.

### [API do dashboard](api-dashboard.md)

É a fonte normativa para autenticação, endpoints, parâmetros, requests,
responses, paginação, erros, importação, reanálise e responsabilidades do
frontend e do backend.

### [Status de implementação](status-implementacao.md)

Registra somente o que está definido, implementado, testado ou pendente. Ele
não redefine contratos.

## Roteiro por área

- **Frontend:** visão geral → API → fluxos de autenticação, importação, consulta
  e revisão → status.
- **Backend:** visão geral → API → ingestão e dados para padrões de consulta →
  fluxos → status.
- **Ingestão:** visão geral → ingestão e dados → fluxos DS-01A e DS-01B →
  análise e IA para o contrato da SQS → status.
- **Análise e IA:** visão geral → análise e IA → ingestão e dados para entradas
  materializadas → fluxos DS-03A a DS-03C → status.
- **Infraestrutura:** visão geral → seções de implantação, segurança e
  observabilidade de cada componente → status.

## Como alterar uma decisão

1. Identificar qual documento é responsável pela regra.
2. Atualizar versão e data desse documento.
3. Explicar a decisão e suas consequências em linguagem direta.
4. Atualizar exemplos, fluxos e critérios de conformidade afetados.
5. Atualizar o status de implementação quando houver impacto no código.
6. Solicitar revisão das equipes consumidoras antes de integrar a mudança.

Alterações incompatíveis em mensagens, dados ou HTTP exigem uma nova versão do
contrato. Alterações apenas editoriais não modificam a versão técnica.

## Glossário

- **Backfill:** processamento de um período histórico de dados.
- **Checkpoint:** posição persistida que permite retomar uma execução.
- **Dataset version:** identificação do conjunto de dados usado em uma análise.
- **DLQ:** fila que preserva mensagens não processadas após o limite de
  tentativas.
- **Golden set ou conjunto de referência:** diagnósticos confirmados por pessoas
  e utilizados como referência em análises futuras.
- **Idempotência:** propriedade que permite repetir uma operação sem duplicar
  seu efeito.
- **Lease ou bloqueio temporário:** direito de uma execução processar uma fonte
  por um período limitado; outra execução pode assumir após a expiração.
- **Outbox:** registro persistido da intenção de publicar uma mensagem.
- **Polling:** consultas periódicas usadas para acompanhar um processamento
  assíncrono.
- **Projeção ou read model:** dado materializado no formato necessário para uma
  consulta específica.
- **Watermark:** limite da última janela completamente publicada.

## Formato dos documentos

Cada documento informa status, versão, data e responsáveis. O conteúdo combina
explicações em parágrafos, exemplos concretos e diagramas quando a ordem das
interações for relevante. Tabelas são reservadas a comparações, estados e
mapeamentos.

As palavras **deve** e **não deve** indicam regras obrigatórias. **Pode** indica
uma possibilidade compatível com o contrato. Termos técnicos são explicados
antes ou no momento de seu primeiro uso.
