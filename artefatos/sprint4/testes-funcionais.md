# Testes Funcionais — Planejamento

> **Status deste documento: PLANEJAMENTO.** Esta versão define **quais** serão os testes funcionais do projeto (identificador, objetivo, procedimento e resultado esperado), atendendo à issue de Messias Olivindo *"Definir quais vão ser os Testes Funcionais do Projeto"*. **Nenhum teste novo foi implementado ou executado como parte desta entrega.** Os campos "Resultado obtido" e "Situação" estão marcados como **a executar** em todos os itens; implementação, execução e evidências (capturas, brutos de `vitest`/`k6`) ficam para uma etapa futura da sprint.

## O que este documento é (e o que não é)

&emsp;Este artefato cobre os **requisitos funcionais (RF01–RF10)** definidos em [`sprint1/requisitos.md`](../sprint1/requisitos.md#2-requisitos-funcionais-rf): verifica se o sistema **faz** o que deveria — se uma função devolve o valor correto, se uma rota entrega o dado esperado, se um fluxo de negócio se comporta certo nos limites de entrada, e se isso continua verdadeiro sob carga.

&emsp;Ele **não** substitui nem duplica [`sprint3/testes-carga-inicial.md`](../sprint3/testes-carga-inicial.md), que cobre os **requisitos não funcionais (RNF01–RNF15)** — capacidade, latência (p95), disponibilidade, throughput. Onde a Seção 4 deste documento usa carga progressiva com a mesma ferramenta k6, o objetivo é **corretude da resposta sob concorrência** (dado certo, sem corrupção, sem efeito colateral), não desempenho; os números de capacidade da API atual (RNF09, RNF14) já estão medidos e classificados naquele artefato e são apenas referenciados aqui como contexto, sem repetir a análise.

## Sumário

1. [Testes Unitários](#1-testes-unitários)
2. [Testes de Integração](#2-testes-de-integração)
3. [Testes de Caso de Uso e Análise de Valor Limite](#3-testes-de-caso-de-uso-e-análise-de-valor-limite)
4. [Testes de Carga Funcional](#4-testes-de-carga-funcional)
5. [Convenção de evidências](#5-convenção-de-evidências)

---

## Objetivo geral

&emsp;Documentar o planejamento dos testes que verificarão os requisitos funcionais do sistema ARGUS/View Show — alvo `apps/backend/api` (monólito modular TypeScript, Express 5, DynamoDB), o mesmo escopo do artefato de RNF. A base de todo teste abaixo é código ou requisito que **já existe** no repositório: nenhum RF, caso de uso, rota ou métrica foi inventado para preencher a issue.

&emsp;A suíte atual (`npm test`, Vitest) tem 11 arquivos e roda **70 testes passando, 1 ignorado** (confirmado em [`sprint3/testes-carga-inicial.md`, RNF12](../sprint3/testes-carga-inicial.md#43-requisitos-validados-por-inspeção-ci-ou-execução-manual)). A Seção 1 e a Seção 2 apontam, teste a teste, o que já está coberto por essa suíte — para reaproveitar como evidência — e o que precisa ser escrito.
