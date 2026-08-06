# Especificação de Requisitos: Monitoramento de Frontend Globoplay

> Este documento descreve a **especificação de requisitos** do sistema de [descrever brevemente o sistema] desenhado para o parceiro **Globo**. O foco aqui é amarrar as necessidades de negócio levantadas na elicitação com os artefatos técnicos de engenharia de software: requisitos funcionais (RF), requisitos não funcionais (RNF) baseados na norma ISO/IEC 25010 e seus respectivos planos de teste.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Alinhamento com a elicitação do parceiro](#2-alinhamento-com-a-elicitação-do-parceiro)
3. [Requisitos Funcionais (RF)](#3-requisitos-funcionais-rf)
4. [Requisitos Não Funcionais (RNF) e Planos de Teste](#4-requisitos-não-funcionais-rnf-e-planos-de-teste)
5. [Procedimento de testes e validação](#5-procedimento-de-testes-e-validação)
6. [Itens avaliados](#6-itens-avaliados)

---

## 1. Visão geral

&emsp; [Descreva brevemente o que é o sistema, seu propósito principal e como ele se insere no contexto da Globo/Globoplay.]

```text
┌──────────────────────────┐
│  [Componente 1]          │   [Descrição do componente]
│  [Ex: Front-end]         │   - [Responsabilidade principal]
└──────────┬───────────────┘
           │ [Ação/Comunicação]
           ▼
┌──────────────────────────┐
│  [Componente 2]          │   [Descrição do componente]
│  [Ex: Back-end API]      │   - [Responsabilidade principal]
└──────────┬───────────────┘
           │ [Ação/Comunicação]
           ▼
┌──────────────────────────┐
│  [Componente 3]          │   [Descrição do componente]
│  [Ex: Modelo de ML]      │   - [Responsabilidade principal]
└──────────────────────────┘
```

&emsp; [Adicione um parágrafo explicando brevemente o fluxo de dados ou a interação entre os blocos ilustrados no diagrama acima.]

---

## 2. Alinhamento com a elicitação do parceiro

&emsp; [Descreva como os requisitos levantados se conectam com as dores e necessidades mapeadas durante as reuniões com os especialistas da Globo. Mencione os problemas atuais e como o sistema proposto visa resolvê-los.]

&emsp; [Detalhe os impactos esperados no negócio (ex: redução de tempo de triagem, automação) que justificam a construção da solução.]

---

## 3. Requisitos Funcionais (RF)

&emsp; [Breve texto introdutório explicando que a tabela a seguir lista as funcionalidades principais que o sistema deve executar para atender ao negócio.]

<div align="center">

<sup>Tabela 1: Conjunto de Requisitos Funcionais (RF)</sup>

| ID | Descrição do Requisito | Alinhamento com a Elicitação (Globo) |
|:---|:---|:---|
| **RF01** | [O que o sistema deve fazer. Ex: Prover endpoint para ingestão de logs...] | [Por que a Globo precisa disso.] |
| **RF02** | [O que o sistema deve fazer. Ex: Processar logs em um modelo de ML...] | [Por que a Globo precisa disso.] |
| **RF03** | [O que o sistema deve fazer. Ex: Exibir dashboard estilo Grafana...] | [Por que a Globo precisa disso.] |
| **RF04** | [O que o sistema deve fazer.] | [Por que a Globo precisa disso.] |
| **RF05** | [O que o sistema deve fazer.] | [Por que a Globo precisa disso.] |

<sup>Fonte: material produzido pelos autores (2026).</sup>

</div>

---

## 4. Requisitos Não Funcionais (RNF) e Planos de Teste

&emsp; [Breve texto introdutório explicando que os RNFs foram baseados na norma ISO/IEC 25010 e detalhando que cada um possui um plano de teste para validação contínua.]

<div align="center">

<sup>Tabela 2: Requisitos Não Funcionais e Planos de Teste (ISO 25010)</sup>

| ID | Categoria (ISO 25010) | Descrição do Requisito | Plano de Teste (Validação) |
|:---|:---|:---|:---|
| **RNF01** | **[Categoria]** *([Subcategoria])* | [Descrição técnica da restrição. Ex: Suportar X requisições/s...] | **[Nome do Teste]:** [Como validar de forma prática. O teste passa se...] |
| **RNF02** | **[Categoria]** *([Subcategoria])* | [Descrição técnica da restrição. Ex: F1-Score do ML superior a Y%...] | **[Nome do Teste]:** [Como validar de forma prática. O teste passa se...] |
| **RNF03** | **[Categoria]** *([Subcategoria])* | [Descrição técnica da restrição.] | **[Nome do Teste]:** [Como validar de forma prática. O teste passa se...] |
| **RNF04** | **[Categoria]** *([Subcategoria])* | [Descrição técnica da restrição.] | **[Nome do Teste]:** [Como validar de forma prática. O teste passa se...] |
| **RNF05** | **[Categoria]** *([Subcategoria])* | [Descrição técnica da restrição.] | **[Nome do Teste]:** [Como validar de forma prática. O teste passa se...] |

<sup>Fonte: material produzido pelos autores (2026).</sup>

</div>

---

## 5. Procedimento de testes e validação

&emsp; [Descreva de forma geral como e onde os testes listados na Seção 4 serão executados ao longo do projeto. Mencione possíveis ferramentas a serem utilizadas (ex: JMeter, K6, notebooks Jupyter para o ML, Lighthouse para o frontend).]

&emsp; [Adicione detalhes sobre quando essa validação será feita (ex: durante a pipeline de CI/CD, validação manual, etc).]

---

## 6. Itens avaliados

&emsp; [Texto opcional mapeando a entrega aos critérios da rubrica para facilitar a correção da faculdade. Exemplo:]
1. **(RF):** [Indique onde os requisitos funcionais estão e como estão numerados]
2. **(Elicitação):** [Indique como o alinhamento com a Globo foi garantido]
3. **(RNF / ISO 25010):** [Indique a tabela que mapeia as categorias da ISO 25010]
4. **(Planos de teste):** [Indique onde os planos textuais podem ser encontrados]