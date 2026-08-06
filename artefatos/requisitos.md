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

<div align="center">

<sup>Tabela 1: Conjunto de Requisitos Funcionais (RF)</sup>

| ID | Descrição do Requisito | Alinhamento com a Elicitação (Globo) |
|:---|:---|:---|
| **RF01** | API única de ingestão de eventos: consumir dados de eventos de frontend do Globoplay em diferentes dispositivos (TVs, mobile, web etc.). | A solução deve contemplar plataformas distintas como iOS (celulares e tablets), Android (celulares e tablets), Android TV, webOS, Fire TV, tvOS e navegadores web (Chrome, Firefox), sendo que o frontend web é denominado Quicksilver. No caso das Smart TVs, o Globoplay possui suporte a modelos fabricados entre 2013 e 2026, incluindo aparelhos mais antigos. |
| **RF02** | Suporte a protocolos modernos e legados: o sistema deve suportar múltiplos protocolos de comunicação, permitindo a ingestão de dados de dispositivos que não suportam padrões atuais de coleta de telemetria. | Cada aplicativo na TV opera com memória reservada — instanciar um SDK de telemetria completo pode estourar esse limite em TVs antigas, com pouca memória e CPU disponíveis. O campo App Target das amostras enviadas confirma essa diversidade legada: dom-philco-netrange-2021 (NetRange), dom-samsung-tizen-2017 (Tizen antigo), dom-panasonic_s-linux-unknown e dom-tcl-linux-2018 (Linux embarcado), e dom-lg-webos-2017 (WebOS antigo). |
| **RF03** | Ingestão em alta escala sem perda de dados: o sistema deve receber e armazenar eventos em larga escala, sem perda de dados (lossless), inclusive em cenários de pico de acesso e de conectividade instável. | Eventos podem chegar duplicados, com pequenas diferenças de timestamp, exigindo regra de tolerância temporal no pipeline. É recomendavel consumir os dados via fila/camada intermediária, em quase tempo real, sem receber diretamente o volume bruto de pico.
| **RF04** | Normalização dos dados: o sistema deve normalizar os eventos recebidos, independentemente do protocolo/formato de origem, para um formato padronizado interno antes de armazená-los. | Cada área técnica da empresa tem seu próprio padrão de monitoração (Prometheus, NewRelic, Apollo GraphQL etc.), por isso é preciso entender a semântica de cada tabela/campo antes de normalizar. Os 6 exemplos de evento recebidos já compartilham um envelope comum (Timestamp, App Bucket, App Env, App Target, App Version, Device Id, Device Manufacturer, Device Model, Device Model Year, Device Os, Device Os Version, Event Name, Session Id — User Id em todos menos session), o que facilita essa normalização. |
| **RF05** | Cadastro e login restritos ao domínio Globo: o sistema deve permitir cadastro e login exclusivamente para usuários com e-mail corporativo do domínio da Globo. | Os dados analizados (eventos + fontes QoS/QoE) já chegam anonimizados, com identificador que não permite chegar ao cadastro do assinante. Contudo o cadastro garante que apenas usuários vinculados à organização tenham acesso à plataforma e aos dados nela armazenados, controlando quem consulta as informações e mantendo a restrição de não compartilhar os dados e os desafios do projeto com terceiros.  |
| **RF06** | Visualização de dados brutos e normalizados: o sistema deve permitir a visualização tanto dos dados injetados (brutos) quanto dos dados já normalizados. | "Bruto" é o evento como chegou pela API de ingestão, no formato/protocolo de origem; "normalizado" é o dado já no esquema padronizado (signal_point). Como cada fonte interna tem seu próprio padrão, visualizar o dado bruto ajuda a equipe a auditar se a normalização preservou o significado original de cada campo. |
| **RF07** | Cobertura mínima de eventos (MVP): o sistema deve coletar, no mínimo, request (status e latência), vitals (ANR), screen_view (carregamento de página e tempo), video_view (carregamento de mídia, status e tempo), session (início/app startup) e error (todo tipo de erro, incluindo falhas originadas nos demais eventos). | Confirmado com amostras reais recebidas (uma por tipo de evento), batendo exatamente com a lista mínima do MVP. Todos compartilham um envelope comum (Timestamp, App Bucket, App Env, App Target, App Version, Device Id, Device Manufacturer, Device Model, Device Model Year, Device Os, Device Os Version, Event Name, Session Id). Campos específicos: request traz Duration, Request Headers/Method/Status/Status Text/Url, Response Headers, Route Params/Path — inclusive uma chamada GraphQL correlacionável à tabela Apollo (operation_metrics) pelo operationName; vitals traz Action (ex.: "frozen"), Duration, Route Params/Path, confirmando que cobre travamento/freeze de reprodução e não só ANR clássico; screen_view traz Duration, Route Params/Path; video_view traz Action, Duration, Media Ads, Media Drm, Media Id, Media Kind (live/vod), Route Params/Path — Media Id é a chave de conteúdo; session traz Action, App Resolution, Capabilities (Audio Dolby Atmos, Cursor, Https, Motion, Video Hdr, Video Live Drm, Video Vod Drm), Device Resolution, Device User Agent, Duration; error traz Error Message, Error Name, Error Stack, Route Params/Path, incluindo erros de regra de negócio (ex.: limite de 4 dispositivos simultâneos por assinatura). Nenhuma amostra trouxe campo de região/UF/POP, e campos unknown aparecem de fato nos dados (Device Os Version, Device Model Year), confirmando a necessidade de tratar dado ausente/variável. |
| **RF08** | Dashboard de navegação em eventos: o sistema deve disponibilizar um dashboard para navegação e visualização gráfica dos eventos coletados. |Apontar o problema, a origem provável, as evidências e o recorte afetado, com aprofundamento progressivo. Evitar o uso de metricas brutas. O uso de filtros cumulativos com sugestão de valores recebidos é requisitado. |
| **RF09** | Métricas e alertas operacionais: o sistema deve disponibilizar métricas operacionais e alertas relacionados à qualidade de experiência e à ocorrência de falhas, para apoiar equipes de engenharia e observabilidade. | Um alerta deve conter, sem dado PII: modelo do dispositivo, versão do SO e do app, identificador anonimizado, conteúdo/série/episódio, região/POP, sinal, métricas de saúde dos componentes (ex.: p95/p99 de latência) e estimativa de usuários afetados, pois isso orienta a criticidade. |
| **RF10** | Consultas para análise de falhas críticas: o sistema deve disponibilizar consultas simples e filtradas voltadas à identificação e análise de falhas críticas nos eventos armazenados. | Evitando erros como freezing de TV, transição IPv4/IPv6 e falha de DNS em modelo específico. |
| **RF11** | Exportação de dados: o sistema deve permitir a exportação dos dados consultados/filtrados. |Seguindo o formatos planilha (CSV/XLSX) e PDF  |

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