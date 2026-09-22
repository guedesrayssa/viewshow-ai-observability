# Arquitetura do View Show

- **Status:** fonte oficial para desenvolvimento
- **Versão:** 1.1
- **Última atualização:** 10/09/2026
- **Responsáveis:** equipe do projeto

## Objetivo

Esta pasta reúne as decisões e os contratos técnicos que orientam a implementação do View Show. Documentos de sprint registram o processo acadêmico e podem resumir essas informações, mas a definição mantida para desenvolvimento fica aqui.

A regra editorial é **uma decisão, um único lugar oficial**. Quando um arquivo precisar mencionar uma regra pertencente a outro, ele deve resumir o contexto e apontar para o documento responsável, sem criar uma segunda definição.

## Ordem de leitura

1. [Visão geral](visao-geral.md): componentes, comunicação, AWS, segurança e decisões arquiteturais.
2. [Diagramas de sequência](../sprint3/modelagem.md#5-diagramas-de-sequência): representação acadêmica dos cenários de sucesso, alternativa e falha.
3. Documento específico da área em desenvolvimento.
4. [Implementação](implementacao/README.md): como cada componente foi construído, o que a verificação mostrou e como rodar.
5. [Status de implementação](status-implementacao.md): cobertura atual, responsáveis, evidências e bloqueios.

## Documentos

### [Visão geral da arquitetura](visao-geral.md)

Explica os limites do sistema, as responsabilidades dos componentes, os tipos de comunicação e as decisões que todas as equipes devem respeitar.

### [Fluxos integrados](fluxos.md)

Funciona como índice técnico dos diagramas de sequência e reúne as invariantes arquiteturais que atravessam mais de um fluxo. A representação canônica dos diagramas está na seção de modelagem da Sprint 3.

### [Ingestão e dados](ingestao-e-dados.md)

É a fonte normativa para ARGUS, dump, normalização, armazenamento quente no DynamoDB, arquivamento em Parquet no S3, catálogo Glue, consultas históricas pelo Athena, checkpoint, watermark, bloqueio temporário, outbox e publicação das solicitações de análise.

### [Análise de dados e diagnóstico por IA](analise-e-ia.md)

É a fonte normativa para SQS, Worker de Análise, modelos, versionamento de dataset, orquestrador, Bedrock, incidentes, hipóteses, repetição e DLQ.

### [API do dashboard](api-dashboard.md)

É a fonte normativa para autenticação, endpoints, parâmetros, requests, responses, paginação, erros, importação, reanálise e responsabilidades do frontend e do backend.

### [Implementação](implementacao/README.md)

Reúne o registro por componente do que está construído: estrutura do código, decisões tomadas na construção, resultado da verificação e instruções para rodar e validar. Não é fonte normativa — cada documento aponta para o contrato que o rege. Hoje cobre a [camada agêntica](implementacao/camada-agentica/camada-agentica.md).

### [Status de implementação](status-implementacao.md)

Registra somente o que está definido, implementado, testado ou pendente. Ele não redefine contratos.

## Estudos e propostas para revisão

- [Análise de arquiteturas agênticas — decisão por A′](analise-arquiteturas-agenticas.md): consolida o estudo, explica as notas e os erros críticos e registra a escolha atual de A′ com validações determinísticas. É o ponto de entrada para a decisão de desenvolvimento.
- [Plano de implementação de A′](estudos/plano-implementacao-a-prime.md): entregas para os desenvolvedores, componentes existentes, contratos propostos, dependências, responsáveis por área e critérios de aceite. Há uma cópia de entrega em Downloads.
- [Worker de Análise — visão consolidada e plano de desenvolvimento](estudos/worker-de-analise.md): explica as responsabilidades, a relação com o notebook, os fluxos de detecção e previsão, a construção de evidências, a integração agêntica e a persistência. Registra propostas, lacunas e critérios de aceite para discussão futura; não substitui os contratos normativos nem declara o worker implementado.
- [Opções para a camada analítica](estudos/opcoes-camada-analitica.md): amplia a investigação para modelos alternativos, contexto recuperado, agente investigador, supervisor com especialistas e debate. Compara ferramentas, limitações dos dados e do servidor e um plano de avaliação antes da escolha arquitetural.
- [Resultados das 72 investigações A/B](estudos/resultados/2026-09-21-ab-real-72/ANALISE.md): compara contexto fixo e escolha de consultas sobre 12 janelas reais de QoE. Expõe resultados operacionais, exemplos de interpretações incorretas, limitações e o próximo experimento necessário.
- [Conclusões das três premissas de investigação](estudos/conclusoes-premissas-agentes.md): fecha a análise de contexto fixo, agente com consultas e revisão/coordenação entre agentes. Distingue resultados A/B das alternativas ainda não testadas e registra a recomendação e os critérios da próxima comparação.
- [Protocolo da comparação prospectiva](estudos/protocolo-comparacao-final.md): define A′, B, C e autocorreção, dados reservados, revisão pelo usuário e critérios anteriores aos resultados para embasar a próxima escolha.
- [Comparação prospectiva — 96 resultados](estudos/resultados/2026-09-22-comparison-final-v1/README.md): registra execução, custos, auditoria e formulário humano preservado.
- [Avaliação pelo Sol e recomendação histórica](estudos/resultados/2026-09-22-comparison-final-v1/sol-evaluation/README.md): preserva a recomendação inicial de B, substituída pela decisão de desenvolver A′. Inclui notas individuais, erros materiais e correções do próprio avaliador.

## Roteiro por área

- **Frontend:** visão geral → API → fluxos de autenticação, importação, consulta e revisão → status.
- **Backend:** visão geral → API → ingestão e dados para padrões de consulta → fluxos → status.
- **Ingestão:** visão geral → ingestão e dados → fluxos DS-01A e DS-01B → análise e IA para o contrato da SQS → status.
- **Análise e IA:** visão geral → análise e IA → ingestão e dados para entradas materializadas → fluxos DS-03A a DS-03C → implementação da camada agêntica → status.
- **Infraestrutura:** visão geral → seções de implantação, segurança e observabilidade de cada componente → status.

## Como alterar uma decisão

1. Identificar qual documento é responsável pela regra.
2. Atualizar versão e data desse documento.
3. Explicar a decisão e suas consequências em linguagem direta.
4. Atualizar exemplos, fluxos e critérios de conformidade afetados.
5. Atualizar o status de implementação quando houver impacto no código.
6. Solicitar revisão das equipes consumidoras antes de integrar a mudança.

Alterações incompatíveis em mensagens, dados ou HTTP exigem uma nova versão do contrato. Alterações apenas editoriais não modificam a versão técnica.

## Glossário

- **Backfill:** processamento de um período histórico de dados.
- **Athena:** serviço de consulta SQL utilizado para ler o histórico em Parquet armazenado no S3.
- **Checkpoint:** posição persistida que permite retomar uma execução.
- **Dataset version:** identificação do conjunto de dados usado em uma análise.
- **DLQ:** fila que preserva mensagens não processadas após o limite de tentativas.
- **Golden set ou conjunto de referência:** diagnósticos confirmados por pessoas e utilizados como referência em análises futuras.
- **Glue Data Catalog:** catálogo que registra schemas e partições dos arquivos históricos consultados pelo Athena.
- **Armazenamento quente:** fatos e projeções dos últimos 30 dias mantidos no DynamoDB para consultas de baixa latência.
- **Armazenamento histórico:** fatos e projeções dos 11 meses anteriores mantidos em Parquet no S3.
- **Idempotência:** propriedade que permite repetir uma operação sem duplicar seu efeito.
- **Lease ou bloqueio temporário:** direito de uma execução processar uma fonte por um período limitado; outra execução pode assumir após a expiração.
- **Outbox:** registro persistido da intenção de publicar uma mensagem.
- **Polling:** consultas periódicas usadas para acompanhar um processamento assíncrono.
- **Projeção ou read model:** dado materializado no formato necessário para uma consulta específica.
- **Watermark:** limite da última janela completamente publicada.

## Formato dos documentos

Cada documento informa status, versão, data e responsáveis. O conteúdo combina explicações em parágrafos, exemplos concretos e diagramas quando a ordem das interações for relevante. Tabelas são reservadas a comparações, estados e mapeamentos.

As palavras **deve** e **não deve** indicam regras obrigatórias. **Pode** indica uma possibilidade compatível com o contrato. Termos técnicos são explicados antes ou no momento de seu primeiro uso.
