# Tarefas: especificação da observabilidade da ingestão

## Tarefa 1: Mapear RNFs e sinais atuais

**Descrição:** Relacionar os cenários de 10 mil eventos/min, fila cheia e timeout
com os sinais já emitidos pelo worker, CloudWatch, ECS, SQS e Scheduler. Separar
claramente o que já foi medido, o que apenas está configurado e o que ainda falta.

**Critérios de aceite:**

- [x] Cada cenário possui indicador, fonte, unidade e resultado esperado.
- [x] A matriz diferencia `existente`, `configurado sem evidência` e `lacuna`.
- [x] Nenhum resultado da arquitetura Flask é apresentado como evidência do worker atual.

**Verificação:**

- [x] Conferir a matriz contra o runtime, `ingestion-observability.tf` e o artefato da Sprint 3.
- [x] Revisar se todas as afirmações medidas apontam para um bruto ou captura existente.

**Dependências:** Nenhuma.

**Arquivos provavelmente alterados:**

- `artefatos/testes-carga-finais.md`
- `tasks/plan.md`

**Escopo estimado:** Pequeno (2 arquivos).

## Tarefa 2: Fechar o catálogo de métricas e logs

**Descrição:** Consolidar a lista P0/P1 de métricas, a interpretação batch dos
quatro indicadores obrigatórios e o contrato mínimo de logs. Definir somente
campos e sinais que respondam a uma pergunta operacional ou ao critério da entrega.

**Critérios de aceite:**

- [x] Latência, throughput, erros/s e CPU têm semântica, unidade e fonte inequívocas.
- [x] Frescor, qualidade e backlog aparecem como sinais complementares, sem poluir a visão principal.
- [x] Logs cobrem início, conclusão, parcial e falha sem payload ou log por registro.

**Verificação:**

- [x] Todos os nomes de métrica existem no adaptador EMF ou em namespace AWS nativo.
- [x] Todas as dimensões possuem cardinalidade limitada.
- [x] Campos sensíveis proibidos estão explicitamente documentados.

**Dependências:** Tarefa 1.

**Arquivos provavelmente alterados:**

- `artefatos/testes-carga-finais.md`
- `tasks/plan.md`

**Escopo estimado:** Pequeno (2 arquivos).

## Checkpoint: contrato de observabilidade

- [x] Os quatro indicadores da rubrica estão cobertos para a arquitetura batch.
- [x] O conjunto P0 cabe numa primeira tela legível do Grafana.
- [x] Nenhuma métrica nova foi inventada sem necessidade demonstrada.

## Tarefa 3: Definir o roteiro de evidências do Grafana

**Descrição:** Especificar os painéis que a tarefa seguinte construirá e, para
cada um, indicar data source CloudWatch, métrica, dimensões, estatística, período,
unidade, janela de teste, captura e bruto que deverão ser preservados.

**Critérios de aceite:**

- [x] Cada painel P0 possui uma consulta reproduzível e uma pergunta operacional clara.
- [x] Captura, bruto e intervalo temporal exigidos estão definidos antes da execução.
- [x] A tarefa do Grafana não depende de alterar a semântica do worker.

**Verificação:**

- [x] Conferir a configuração de provisionamento do data source CloudWatch na pilha Grafana AWS.
- [x] Validar consultas contra nomes e dimensões do Terraform; aceite funcional na AWS/API e no navegador registrado em 04/10/2026.
- [x] Revisar se os quatro indicadores obrigatórios aparecem na primeira visão.

**Dependências:** Tarefa 2.

**Arquivos provavelmente alterados:**

- `artefatos/testes-carga-finais.md`
- `tasks/plan.md`

**Escopo estimado:** Pequeno (2 arquivos).

## Tarefa 4: Redigir a seção no artefato final

**Descrição:** Criar a seção “Observabilidade da camada de ingestão” em
`artefatos/testes-carga-finais.md`, incorporando o contrato, o método de coleta,
o roteiro de evidências, as limitações e o impacto esperado nas decisões de
arquitetura. Resultados ainda não executados devem permanecer marcados como pendentes.

**Critérios de aceite:**

- [x] A seção cobre a contribuição da ingestão aos itens 1, 2 e 3 da especificação.
- [x] Configuração, resultado medido, inferência e limitação são distinguidos no texto.
- [x] A seção está pronta para receber capturas e números sem reescrever o método.

**Verificação:**

- [x] Todos os links relativos resolvem a partir de `/artefatos`.
- [x] Tabelas e cabeçalhos seguem o padrão do artefato da Sprint 3.
- [x] Revisão pela rubrica confirma cobertura explícita do item de observabilidade.

**Dependências:** Tarefas 1, 2 e 3.

**Arquivos provavelmente alterados:**

- `artefatos/testes-carga-finais.md`

**Escopo estimado:** Pequeno (1 arquivo).

## Checkpoint: entrega para o módulo Grafana

- [x] O artefato define métricas, logs, fontes, consultas e evidências esperadas.
- [x] Não há resultado futuro apresentado como medição concluída.
- [x] A tarefa seguinte pode implementar e capturar o módulo Grafana diretamente.

## Tarefa 5: Implementar e validar o módulo Grafana da ingestão

**Critérios de aceite:**

- [x] Dashboard renderiza JSON válido e usa `RecordsRead`/`RecordsWritten`.
- [x] Nenhuma expressão aplica `PERIOD()` a resultado de `SEARCH`.
- [x] Um seletor correlaciona os quatro comandos às quatro famílias ECS.
- [x] Bootstrap isolado inclui o dashboard e respeita 16 KiB comprimidos.
- [x] CloudWatch aceita as quatro expressões reparadas ([evidência sanitizada](../assets/testes-carga/2026-10-04-ingestao/cloudwatch-query-validation.json)).
- [x] Grafana provisionado está saudável e a [captura sanitizada](../assets/testes-carga/2026-10-04-ingestao/grafana-ingestion.png) foi versionada.
- [x] API e navegador executam as cinco expressões visíveis e interpolam corretamente as quatro operações ([validação de 04/10/2026](../assets/testes-carga/2026-10-04-ingestao/grafana-dashboard-validation.json)).
- [x] Logs validados em janela posterior à criação dos grupos; dados esparsos/ausentes não são apresentados como resultado de desempenho.
