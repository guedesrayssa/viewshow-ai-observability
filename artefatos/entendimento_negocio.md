# Entendimento de Negócio

O objetivo deste artefato é estruturar o entendimento do modelo de negócio, proposta de valor e riscos associados ao projeto, utilizando ferramentas de análise estratégica: a Matriz de Avaliação de Valor do Oceano Azul, a Matriz de Risco e Oportunidades, o Canvas de Proposta de Valor, a Análise Financeira e a Análise de Impacto nos ODS da ONU.

**Grupo:** G05 · **Parceiro:** Grupo Globo (Globoplay) — Projeto (CCMD7)

## Sumário

1. [Matriz de Avaliação de Valor – Estratégia do Oceano Azul](#1-matriz-de-avaliação-de-valor-estratégia-do-oceano-azul)
2. [Matriz de Risco e Oportunidades](#2-matriz-de-risco-e-oportunidades)
3. [Canvas de Proposta de Valor](#3-canvas-de-proposta-de-valor)
4. [Análise Financeira](#4-análise-financeira)
5. [Análise de Impacto nos ODS (Objetivos de Desenvolvimento Sustentável)](#5-análise-de-impacto-nos-ods-objetivos-de-desenvolvimento-sustentável)
6. [Referências](#referências)

---

## 1. Matriz de Avaliação de Valor – Estratégia do Oceano Azul

&nbsp;&nbsp;&nbsp;&nbsp;A Matriz de Avaliação de Valor do Oceano Azul é uma ferramenta estratégica que permite comparar, de forma estruturada, a proposta de valor de um projeto em relação às soluções existentes no mercado. A partir da identificação de atributos relevantes para o cliente, a matriz orienta decisões sobre quais fatores devem ser **Reduzidos**, **Eliminados**, **Aumentados** ou **Criados** (framework ERRC), com o objetivo de reduzir custos e elevar o valor percebido pelo cliente (KIM; MAUBORGNE, 2005).

&nbsp;&nbsp;&nbsp;&nbsp;No contexto deste projeto, a matriz foi construída considerando a realidade operacional do Globoplay, serviço de streaming que atende à totalidade do território brasileiro, um país de dimensões continentais, e o cenário competitivo de ferramentas de monitoramento/telemetria de frontend disponíveis no mercado (por exemplo, soluções de RUM/APM voltadas a aplicações web e mobile). A análise toma como referência um conjunto de oito atributos considerados críticos para os times de engenharia, SRE e produto, permitindo visualizar como a plataforma proprietária proposta se diferencia das alternativas tradicionais.

<figure>
  <img src="../assets/negocios/Matriz_oceano.png" alt="Matriz Do Oceano Azul" width="500">
  <figcaption>
  </figcaption>
</figure>
<strong>Figura 1:</strong> Matriz Do Oceano Azul. <br>
    <em>Fonte: Grupo 05 (2026).</em>

---

### 1.1. Atributos considerados

&nbsp;&nbsp;&nbsp;&nbsp;Foram definidos oito atributos de valor que sintetizam as principais preocupações e expectativas do cliente em relação a uma plataforma de telemetria para frontends multiplataforma:

1. **Custo total de telemetria** – gastos anuais com coleta, processamento e visualização de dados, incluindo licenças de ferramentas externas.
2. **Cobertura de dispositivos legados** – capacidade de coletar telemetria de TVs e dispositivos antigos, com protocolos ou limitações não atendidos por soluções modernas.
3. **Granularidade de segmentação** – nível de detalhe disponível para análise por device family, modelo, versão de app, OS, região, CDN, tipo de playback, entre outros.
4. **Velocidade de diagnóstico e resolução de incidentes (MTTD/MTTR)** – rapidez para identificar e resolver a causa raiz de incidentes.
5. **Customização de schema e eventos** – flexibilidade para definir modelos de dados e eventos alinhados às necessidades específicas de streaming.
6. **Integração com ecossistema interno** – facilidade de integração com data lakes, sistemas de alerta, ferramentas de ticket e dashboards já utilizados pelo Globoplay.
7. **Qualidade de métricas de QoE** – adequação e precisão das métricas de qualidade de experiência do usuário (TTFF, falha de playback, rebuffer, etc.).
8. **Dependência de fornecedor externo** – grau de exposição estratégica a ferramentas de terceiros para capacidade crítica de observabilidade.

&nbsp;&nbsp;&nbsp;&nbsp;Com base nesses atributos, a estratégia do projeto foi desenhada utilizando as quatro ações do Oceano Azul: Reduzir, Eliminar, Aumentar e Criar. A seguir, é detalhado, com exemplos de pontuação comparativa e justificativas.

---

### 1.2. Sobre a pontuação comparativa e as ferramentas de referência

&nbsp;&nbsp;&nbsp;&nbsp;Em cada atributo analisado a seguir, é apresentado um **exemplo de pontuação comparativa**: uma nota de 0 a 10, atribuída de forma qualitativa pelo grupo, que estima o desempenho relativo de cada solução naquele atributo específico. O objetivo dessa pontuação não é fornecer uma medição técnica precisa, e sim ilustrar de forma visual e comparativa como a plataforma proposta se posiciona frente às alternativas de mercado, servindo de base para a construção da curva de valor do Oceano Azul.

&nbsp;&nbsp;&nbsp;&nbsp;As ferramentas usadas como referência de mercado são o **New Relic** e o **Datadog RUM (Real User Monitoring)**, duas plataformas comerciais amplamente adotadas para observabilidade de aplicações web e mobile. Ambas oferecem monitoramento de performance de aplicações (APM) e de experiência real do usuário (RUM), com coleta de métricas como tempo de carregamento, erros e disponibilidade. Foram escolhidas como termo de comparação por representarem o padrão de mercado ao qual a solução proprietária proposta se contrapõe.

---

### 1.3. Reduzir

#### Custo total de telemetria

**Ação:** Reduzir  
**Atributo:** Custo total de telemetria  

**Motivação**  
&nbsp;&nbsp;&nbsp;&nbsp;O custo associado a ferramentas de observabilidade de mercado é diretamente proporcional ao volume de eventos e sessões monitoradas. Em um serviço de streaming de grande porte, que precisa acompanhar milhões de sessões diárias com nível de detalhe alto, o modelo tradicional de cobrança por volume gera um custo anual muito alto. Em resposta, a solução proposta busca **reduzir esse custo total**, substituindo parte do stack de ferramentas externas por uma plataforma proprietária otimizada para a realidade do Globoplay.

**Exemplo de pontuação comparativa (0 a 10, menor = menor custo):**

- Nossa solução (plataforma proprietária): **3**  
- New Relic: **9**  
- Datadog RUM: **8**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Ao internalizar coleta e processamento de telemetria, a empresa passa a ter um custo mais associado à infraestrutura e operação, com **custo marginal decrescente conforme a escala aumenta**. Isso diferencia com soluções de mercado, em que o custo cresce linearmente com o volume monitorado. Reduzir esse atributo não diminui o valor percebido pelo cliente; pelo contrário, libera orçamento para outras frentes de melhoria do produto.

---

### 1.4. Eliminar

#### Dependência de fornecedor externo

**Ação:** Eliminar  
**Atributo:** Dependência de fornecedor externo  

**Motivação**   
&nbsp;&nbsp;&nbsp;&nbsp;Grande parte da capacidade de observabilidade de frontend depende de ferramentas de terceiros. Essa dependência exige adaptação contínua a contratos, modelos de preço, roadmaps e limitações técnicas definidos por outros. A proposta da plataforma é **eliminar, na medida do possível, essa dependência estratégica**, reduzindo o risco de vendor lock-in em um componente crítico da operação.

**Exemplo de pontuação comparativa (0 a 10, menor = menor dependência):**

- Nossa solução: **0**  
- New Relic: **8**  
- Datadog RUM: **8**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Ao eliminar a dependência de fornecedor externo como elemento central da telemetria, o Globoplay ganha **autonomia sobre dados, arquitetura e evolução da plataforma**, podendo priorizar o que faz sentido para o produto e não apenas o que está disponível no catálogo de um vendor. Essa eliminação reduz riscos de aumento de preços, descontinuações e restrições técnicas impostas por terceiros.

---

### 1.5. Aumentar

#### Granularidade de segmentação

**Ação:** Aumentar  
**Atributo:** Granularidade de segmentação  

**Motivação**   
&nbsp;&nbsp;&nbsp;&nbsp;As soluções de mercado geralmente oferecem segmentações genéricas (por exemplo, por tipo de browser ou país). Para o contexto de streaming, isso é insuficiente: é necessário diferenciar comportamento por modelo de TV, firmware, versão de app, sistema operacional, rota de CDN e tipo de conteúdo. A plataforma proposta busca **aumentar significativamente esse nível de granularidade**, oferecendo filtros alinhados à realidade operacional do Globoplay.

**Exemplo de pontuação comparativa (0 a 10, maior = maior granularidade):**

- Nossa solução: **9**  
- New Relic: **6**  
- Datadog RUM: **6**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Elevar a granularidade de segmentação permite que as equipes de engenharia e SRE passem de uma visão agregada para uma **análise de causa muito mais precisa**, identificando rapidamente quais combinações de device, versão e região estão sofrendo degradação. Isso aumenta o valor percebido sem necessariamente elevar os custos operacionais de forma proporcional.

---

#### Velocidade de diagnóstico e resolução de incidentes (MTTD/MTTR)

**Ação:** Aumentar  
**Atributo:** Velocidade de diagnóstico e resolução de incidentes (MTTD/MTTR)  

**Motivação**  
&nbsp;&nbsp;&nbsp;&nbsp;A velocidade com que um incidente é detectado e diagnosticado é crucial para a qualidade de experiência percebida pelo usuário. Ao criar uma plataforma integrada, com correlação por sessão e filtros cumulativos, o objetivo é **aumentar a capacidade de diagnóstico rápido**, reduzindo tanto o tempo para detectar (MTTD) quanto o tempo para resolver (MTTR).

**Exemplo de pontuação comparativa (0 a 10, maior = melhor desempenho de diagnóstico):**

- Nossa solução: **9**  
- New Relic: **6**  
- Datadog RUM: **6**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Ao elevar esse atributo, a plataforma torna o processo de investigação mais eficiente, reduzindo a dependência de múltiplas ferramentas e cruzamentos manuais. O ganho é percebido diretamente na operação (menos tempo em incidentes) e indiretamente pelo usuário final (menos tempo de degradação de serviço).

---

#### Integração com ecossistema interno

**Ação:** Aumentar  
**Atributo:** Integração com ecossistema interno  

**Motivação**    
&nbsp;&nbsp;&nbsp;&nbsp;Ferramentas externas frequentemente exigem conectores adicionais, exportações e ajustes específicos para integrar com data lakes, ferramentas de alerta, Jira, sistemas internos de monitoramento, entre outros. A plataforma proprietária é desenhada desde o início para **se integrar profundamente ao ecossistema existente do Globoplay**, aumentando este atributo acima do padrão de mercado.

**Exemplo de pontuação comparativa (0 a 10, maior = melhor integração):**

- Nossa solução: **8**  
- New Relic: **6**  
- Datadog RUM: **6**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Ao aumentar a integração, a solução reduz retrabalho e barreiras técnicas entre equipes, facilitando automações, criação de alertas customizados e análises avançadas em data lakes. Isso gera valor operacional sem impactar negativamente o custo total.

---

#### Qualidade de métricas de QoE

**Ação:** Aumentar  
**Atributo:** Qualidade de métricas de QoE  

**Motivação**   
&nbsp;&nbsp;&nbsp;&nbsp;Métricas genéricas de RUM (como tempo de carregamento de página ou erro de JavaScript) não são suficientes para gerenciar um serviço de streaming. A plataforma proposta eleva a qualidade das métricas de QoE ao incluir indicadores específicos como **tempo até o início do vídeo (TTFF), taxa de falha de playback, rebuffer ratio e variação de bitrate**, sempre associados ao contexto do dispositivo e da rota de entrega.

**Exemplo de pontuação comparativa (0 a 10, maior = melhor qualidade de QoE):**

- Nossa solução: **9**  
- New Relic: **6**  
- Datadog RUM: **6**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Ao aumentar esse atributo, o projeto fornece **informações mais diretamente acionáveis** para times de vídeo, engenharia e produto, alinhando a telemetria aos objetivos reais do serviço (qualidade de reprodução e satisfação do usuário).

---

### 1.6. Criar

#### Cobertura de dispositivos legados

**Ação:** Criar  
**Atributo:** Cobertura de dispositivos legados  

**Motivação**   
&nbsp;&nbsp;&nbsp;&nbsp;A maioria das soluções de mercado assume um conjunto de capacidades modernas nos dispositivos (bibliotecas atualizadas, suporte a SDKs recentes, protocolos padronizados). Isso deixa uma parcela significativa da base, especialmente TVs e set-top boxes mais antigos, sem telemetria útil. A plataforma proposta **cria um atributo que praticamente não existe no mercado hoje**: cobertura sistemática e observável de dispositivos legados, por meio de APIs unificadas e adaptadores de protocolo.

**Exemplo de pontuação comparativa (0 a 10, maior = maior cobertura de legados):**

- Nossa solução: **9**  
- New Relic: **3**  
- Datadog RUM: **4**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Criar esse atributo permite que o Globoplay deixe de tratar uma parcela importante da audiência como “invisível”. A capacidade de monitorar legados amplia o campo de visão operacional e reduz o risco de incidentes concentrados em segmentos que antes não eram detectados.

---

#### Customização de schema e eventos

**Ação:** Criar  
**Atributo:** Customização de schema e eventos  

**Motivação**  
&nbsp;&nbsp;&nbsp;&nbsp;Ferramentas externas oferecem schemas de eventos pré-definidos, com certo grau de customização, mas normalmente limitados pelo modelo de dados e pelo foco do produto. O projeto cria a possibilidade de **definir um schema canônico próprio**, orientado às necessidades de streaming do Globoplay, bem como eventos específicos (por exemplo, `video_view` com campos ricos de QoE e contexto de conteúdo).

**Exemplo de pontuação comparativa (0 a 10, maior = maior nível de customização):**

- Nossa solução: **9**  
- New Relic: **5**  
- Datadog RUM: **5**

**Justificativa**  
&nbsp;&nbsp;&nbsp;&nbsp;Ao criar esse atributo, a plataforma permite que a telemetria evolua junto com o produto, sem ficar limitada à taxonomia de eventos de um vendor. Isso gera **um salto de valor** em termos de relevância dos dados coletados e de aderência às perguntas que a operação e o negócio realmente precisam responder.

---

### 1.7. Conclusão

&nbsp;&nbsp;&nbsp;&nbsp;A Matriz de Avaliação de Valor do Oceano Azul mostra que a plataforma de telemetria proposta não busca apenas ser uma ferramenta de monitoramento, mas reconstruir o espaço de valor desse tipo de solução para o contexto específico do Globoplay. Ao **reduzir** o custo total de telemetria e **eliminar** a dependência estratégica de fornecedores externos, o projeto ataca diretamente as limitações econômicas e de governança da abordagem atual.  

&nbsp;&nbsp;&nbsp;&nbsp;Simultaneamente, ao **aumentar** granularidade de segmentação, capacidade de diagnóstico, integração com o ecossistema interno e qualidade das métricas de QoE, a solução eleva o nível de serviço entregue às equipes técnicas. Ao **criar** cobertura estruturada para dispositivos legados e um modelo de dados customizável, a plataforma oferece atributos que o mercado praticamente não disponibiliza, gerando uma nova curva de valor alinhada às necessidades reais da operação de streaming em um país continental.  

&nbsp;&nbsp;&nbsp;&nbsp;Dessa forma, a matriz demonstra que a estratégia do projeto está em linha com os princípios do Oceano Azul: **reduzir e eliminar fatores que aumentam custo sem agregar valor proporcional** e, ao mesmo tempo, **aumentar e criar fatores que ampliam significativamente o valor percebido pelos clientes internos e, indiretamente, pelos usuários finais do serviço de streaming**.

---

## 2. Matriz de Risco e Oportunidades

Este documento identifica, avalia e prioriza os riscos (ameaças) e as oportunidades do projeto de monitoramento de frontend do Globoplay (codinome interno do parceiro: **Argus**). Além do artefato de [requisitos](requisitos.md) e da [análise financeira](#4-análise-financeira) apresentada neste documento, este levantamento usa como fonte primária o Termo de Abertura de Projeto (TAPI), o anexo de fontes de dados e a documentação técnica do dataset entregues pelo parceiro - os dois últimos contêm um capítulo de "armadilhas conhecidas" e uma seção chamada literalmente "a oportunidade real", que fundamentam boa parte dos itens abaixo. Cada item recebe um código único (**R0X** para riscos, **O0X** para oportunidades) que serve de ponte entre este documento e a matriz visual de probabilidade × impacto.

---

### 2.1. Visão geral e metodologia

&emsp; Este documento identifica, avalia e prioriza os riscos (eventos que podem prejudicar o projeto) e as oportunidades (eventos que podem beneficiá-lo além do planejado) do projeto de monitoramento de frontend do Globoplay. A abordagem segue a lógica de gestão de riscos do PMBOK (PROJECT MANAGEMENT INSTITUTE, 2021) e da ISO 31000 (INTERNATIONAL ORGANIZATION FOR STANDARDIZATION, 2018): cada item é avaliado em duas dimensões independentes, probabilidade e impacto (Seção 2.2), classificado em um nível objetivo e associado a uma estratégia de resposta (Seção 2.2.3), em vez de depender apenas de percepção qualitativa.

&emsp; Cada risco recebe o código **RXX** e cada oportunidade o código **OXX**, numerados sequencialmente nas Tabelas 6 e 7. Esse código é a unidade de transporte entre este documento e a matriz visual a ser construída no Figma (reproduzida também como imagem mais adiante neste documento): a descrição completa, a categoria e a estratégia de resposta permanecem neste documento como fonte da verdade, enquanto o Figma recebe apenas o código posicionado na célula de probabilidade × impacto correspondente.

&emsp; A maior parte dos itens abaixo não é uma suposição genérica de projeto de software: é extraída diretamente da documentação técnica que o parceiro entregou junto com o dataset (o correlator **Argus** e seu anexo de fontes de dados), que já documenta explicitamente armadilhas conhecidas do problema (Seção 7 daquele documento) e aponta, em uma seção própria, onde está "a oportunidade real" (Seção 8.3 daquele documento) - ambas citadas nas Tabelas 6 e 7 abaixo. Este é um documento vivo: novos riscos e oportunidades identificados ao longo do módulo devem ser adicionados seguindo o processo descrito na Seção 2.5.

---

### 2.2. Escala de Probabilidade, Impacto e Estratégias de Resposta

#### 2.2.1. Probabilidade

&emsp; A probabilidade estima a chance de o evento (risco ou oportunidade) ocorrer - ou, quando já é um fato documentado sobre os dados/sistema atuais, a chance de ele afetar o projeto caso a equipe não trate o ponto conscientemente - durante as 10 semanas do módulo, em uma escala de 1 (rara) a 5 (quase certa).

<div align="center">

<sup>Tabela 1: Escala de Probabilidade</sup>

| Nível | Classificação | Descrição | Chance estimada ao longo do módulo |
|:---|:---|:---|:---|
| **1** | Rara | Não há indício de que o evento ocorra; depende de uma combinação improvável de fatores. | < 10% |
| **2** | Improvável | Pode ocorrer em situação excepcional, mas não há sinal atual de que vá acontecer. | 10% – 30% |
| **3** | Possível | Pode ocorrer em algum momento do módulo; já há indício ou precedente semelhante. | 30% – 50% |
| **4** | Provável | Há forte indício de que o evento vai ocorrer, ou já é um fato documentado sobre os dados/sistema atuais. | 50% – 70% |
| **5** | Quase certa | O evento já está ocorrendo ou é esperado com alta confiança dado o contexto atual. | > 70% |

<sup>Fonte: Material produzido pelos autores (2026), com base no PMBOK (PROJECT MANAGEMENT INSTITUTE, 2021).</sup>

</div>

#### 2.2.2. Impacto e Nível de Risco (Probabilidade × Impacto)

&emsp; O impacto estima o efeito do evento sobre prazo, custo, escopo/qualidade ou a relação com a Globo, caso ele se concretize, também em uma escala de 1 (insignificante) a 5 (catastrófico).

<div align="center">

<sup>Tabela 2: Escala de Impacto</sup>

| Nível | Classificação | Descrição |
|:---|:---|:---|
| **1** | Insignificante | Desvio mínimo em prazo, custo ou escopo; absorvido sem ajuste no planejamento; nenhum efeito perceptível para a Globo. |
| **2** | Menor | Pequeno desvio, corrigido com ajuste de rotina da equipe; não compromete nenhuma entrega do módulo. |
| **3** | Moderado | Atraso, retrabalho ou custo adicional perceptível em uma entrega parcial, ainda recuperável dentro das 10 semanas do módulo. |
| **4** | Maior | Compromete uma entrega significativa (ex.: um RNF crítico ou parte do MVP) ou reduz a confiança da Globo no andamento do projeto. |
| **5** | Catastrófico | Inviabiliza a entrega do MVP ao parceiro dentro do módulo ou compromete a parceria/confidencialidade acordada com a Globo. |

<sup>Fonte: Material produzido pelos autores (2026), com base no PMBOK (PROJECT MANAGEMENT INSTITUTE, 2021).</sup>

</div>

&emsp; O nível de cada item é obtido multiplicando sua Probabilidade pelo seu Impacto (Probabilidade × Impacto), resultando em uma pontuação de 1 a 25, classificada conforme a Tabela 3. Para oportunidades, a mesma pontuação é lida como prioridade de ação - quanto maior, maior o benefício potencial a capturar - e não como severidade a mitigar.

<div align="center">

<sup>Tabela 3: Faixas de Pontuação e Nível</sup>

| Pontuação (P × I) | Nível | Cor de referência (Figma) |
|:---|:---|:---|
| 1 – 4 | **Baixo** | Verde |
| 5 – 9 | **Médio** | Amarelo |
| 10 – 14 | **Alto** | Laranja |
| 15 – 25 | **Crítico** | Vermelho |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

#### 2.2.3. Estratégias de Resposta

&emsp; Cada risco ou oportunidade recebe uma estratégia de resposta alinhada ao seu nível e ao grau de controle do grupo sobre sua causa, seguindo o vocabulário padrão do PMBOK (PROJECT MANAGEMENT INSTITUTE, 2021).

<div align="center">

<sup>Tabela 4: Estratégias de Resposta a Riscos (Ameaças)</sup>

| Estratégia | Descrição | Quando usar |
|:---|:---|:---|
| **Evitar** | Eliminar a causa do risco, mudando o plano para que a ameaça deixe de existir. | Riscos Críticos/Altos com causa controlável pelo grupo. |
| **Mitigar** | Reduzir a probabilidade e/ou o impacto a um nível aceitável, sem eliminar totalmente o risco. | Riscos Altos/Médios com causa parcialmente controlável. |
| **Transferir** | Repassar a responsabilidade (ou parte do impacto) a terceiros ou ao parceiro. | Riscos ligados a sistemas/decisões fora do controle do grupo (ex.: SSO da Globo). |
| **Aceitar** | Reconhecer o risco sem ação proativa, apenas monitorando sua evolução. | Riscos Baixos/Médios ou fora do controle do grupo dentro do prazo do módulo. |

<sup>Fonte: Material produzido pelos autores (2026), com base no PMBOK (PROJECT MANAGEMENT INSTITUTE, 2021).</sup>

</div>

<div align="center">

<sup>Tabela 5: Estratégias de Resposta a Oportunidades</sup>

| Estratégia | Descrição | Quando usar |
|:---|:---|:---|
| **Explorar** | Agir para garantir que a oportunidade se concretize. | Oportunidades Altas/Críticas com alto controle do grupo. |
| **Melhorar** | Aumentar a probabilidade e/ou o impacto positivo da oportunidade. | Oportunidades Médias com ação viável dentro do prazo do módulo. |
| **Compartilhar** | Unir forças com o parceiro (Globo) ou terceiros para viabilizar a oportunidade. | Oportunidades que dependem de decisão ou recurso do parceiro. |
| **Aceitar** | Aproveitar a oportunidade apenas se ela ocorrer naturalmente, sem ação proativa. | Oportunidades Baixas ou de baixo controle do grupo. |

<sup>Fonte: Material produzido pelos autores (2026), com base no PMBOK (PROJECT MANAGEMENT INSTITUTE, 2021).</sup>

</div>

---

### 2.3. Riscos (Ameaças)

&emsp; A Tabela 6 relaciona os riscos identificados. Os itens R01 a R06 vêm da documentação técnica do dataset (Argus) e do anexo de fontes de dados - material que o próprio parceiro já testou em produção e documentou como fonte real de erro; os itens R07 a R12 vêm dos artefatos de requisitos, do TAPI e da análise financeira.

<div align="center">

<sup>Tabela 6: Riscos (Ameaças) Identificados</sup>

| ID | Descrição | Categoria | P | I | Nível (P × I) | Estratégia | Responsável |
|:---|:---|:---|:---|:---|:---|:---|:---|
| **R01** | O golden set de rótulos de causa-raiz (`incident_label`) tem apenas 53 registros no total, dos quais só 4 (nível 3/ITSM, com timestamp impreciso) têm telemetria correspondente dentro da janela de retenção de 30 dias; os rótulos de melhor qualidade (`rca-confirmed`, `team-confirmed`) descrevem incidentes anteriores à janela e servem só como estudo de caso, e os rótulos `detector-derived` são circulares - medem concordância com o Argus atual, não acurácia real, penalizando um modelo que encontre incidentes que o Argus perdeu. Isso inviabiliza, dentro do prazo do módulo, o cálculo de Precision/Recall/F1-Score com confiança estatística exigido pelo RNF08. | **Dados/ML** *(Ground Truth e Avaliação)* | 4 | 5 | 20 - Crítico | Mitigar | Squad ML/Dados (G05) |
| **R02** | As fontes de qualidade de experiência percebida (NPAW/Youbora) têm latência estrutural de ~28 horas no pipeline batch via BigQuery - as últimas ~28h dessas tabelas chegam vazias ou parciais por desenho, não por falha -, o que conflita com o requisito de latência ponta a ponta de até 2 minutos do RNF02 sempre que o diagnóstico ou alerta depender de sinais de QoE (buffering, tempo de início de vídeo, quedas de sessão) para o instante presente. | **Técnico** *(Arquitetura/Latência)* | 4 | 4 | 16 - Crítico | Mitigar | Squad Backend/Arquitetura (G05) |
| **R03** | Armadilhas de semântica documentadas nos dados brutos - picos de memória que na verdade são o limite do cgroup e não uso real (caso `gg-gateway-rpaas-be`, falso pico de 33×), o campo `latency_2xx` que é contagem de requisições e não latência, zeros forçados nas séries de CDN abaixo do volume mínimo, e granularidade mista de 5 min/1h numa mesma tabela do New Relic sem coluna que distinga - geram conclusões erradas se o pipeline de normalização não tratar cada exceção já mapeada pela fonte original. | **Técnico** *(Qualidade e Semântica dos Dados)* | 4 | 3 | 12 - Alto | Mitigar | Squad Backend/Dados (G05) |
| **R04** | A lógica padrão de detecção (`positive_only: true`) ignora degradações representadas por queda de métrica - sessões caindo (player travou), Apdex caindo (pior satisfação) ou regressão silenciosa de QoE sem aumento de erro (caso Roku documentado) -, e a ausência de correlação com eventos de bloqueio do Cloud Armor pode atribuir a bugs internos picos de tráfego/CPU causados por ataques ou rate-limiting mitigado. | **Produto/ML** *(Lógica de Detecção)* | 3 | 4 | 12 - Alto | Mitigar | Squad ML/Dados (G05) |
| **R05** | O dataset e sua documentação técnica são classificados como uso interno, com liberação condicionada à aprovação prévia de Segurança da Informação e Jurídico da Globo; a contrapartida exigida (uso restrito à finalidade acadêmica do convênio, não redistribuição fora da turma, revisão prévia da Globo antes de qualquer publicação/apresentação, descarte das cópias locais ao fim do semestre) pode ser descumprida por descuido operacional da equipe. | **Contratual/Segurança** *(Confidencialidade)* | 2 | 5 | 10 - Alto | Evitar | Liderança de projeto (G05); ponto focal Globo |
| **R06** | Os arquivos de referência do parceiro (pasta `ref/`, com topologia de infraestrutura de produção e dados de uso interno) não estavam versionados nem ignorados pelo Git; um `git add` amplo os incluiria no repositório compartilhado do GitLab, violando a cláusula de não redistribuição do dataset e a restrição contratual de não compartilhar dados com terceiros (RESTR01). **Mitigado nesta versão** com a adição de `ref/` ao `.gitignore` - reavaliar se a pasta for movida ou renomeada. | **Processo** *(Governança de Repositório)* | 2 | 5 | 10 - Alto | Evitar | Liderança de projeto (G05) |
| **R07** | Um pico de tráfego equivalente a grandes eventos ao vivo (ex.: final do BBB, ~50 milhões de eventos simultâneos) supera a capacidade de auto-scaling do worker de normalização, gerando acúmulo crítico de mensagens na fila e perda de dados (RNF01, RNF03). | **Técnico** *(Capacidade)* | 3 | 5 | 15 - Crítico | Mitigar | Squad Backend/Infra (G05) |
| **R08** | A alta heterogeneidade de Smart TVs legadas (fabricadas entre 2013 e 2017, com schemas próprios e pouca capacidade de processamento) causa falhas ou perda de campos na normalização de um subconjunto de dispositivos, comprometendo a cobertura mínima de eventos do MVP (RF01, RF03, RNF11). | **Técnico** *(Compatibilidade)* | 4 | 3 | 12 - Alto | Mitigar | Squad Backend/Dados (G05) |
| **R09** | Uma indisponibilidade ou mudança de contrato na API do serviço corporativo de autenticação da Globo (SSO, RIE01) bloqueia o acesso de todos os usuários ao dashboard e às APIs de consulta, mesmo com o restante do sistema operacional. | **Integração** *(Dependência Externa)* | 2 | 4 | 8 - Médio | Transferir | Squad Backend (G05); ponto focal técnico Globo |
| **R10** | O dataset é entregue como um snapshot único (não um feed contínuo): qualquer recorte novo precisa ser pedido e regerado pelo parceiro. Combinado ao tempo já investido nas fases de elicitação e discovery, isso cria uma dependência externa que pode atrasar a conclusão do escopo mínimo do MVP dentro das 10 semanas do módulo. | **Cronograma** *(Escopo do MVP e Dependência de Dataset)* | 3 | 4 | 12 - Alto | Mitigar | Liderança de projeto (G05) |
| **R11** | As estimativas de CAPEX, OPEX e valor gerado ([análise financeira, Seções 2 a 4](#42-investimentos-iniciais-capex)) baseiam-se em benchmarking de mercado, não em dados reais de contrato da Globo - o que o próprio TAPI confirma ao não trazer orçamento algum -, e podem estar subdimensionadas frente ao custo real do parceiro. | **Financeiro** *(Estimativas)* | 4 | 2 | 8 - Médio | Mitigar | Liderança de projeto (G05) |
| **R12** | Os times internos da Globo (engenharia, observabilidade e produto) adotam a plataforma mais lentamente do que a curva premissada (10/20/30/40% trimestral), adiando o ponto de equilíbrio do Ano 1 ([análise financeira, Seções 5 e 6](#45-projeção-financeira-consolidada-ano-1-trimestral)). | **Negócio** *(Adoção)* | 3 | 3 | 9 - Médio | Aceitar | Liderança de projeto (G05) |

<sup>Fonte: Material produzido pelos autores (2026), com base na documentação do dataset Argus, no anexo de fontes de dados, no TAPI e nos artefatos de requisitos e de análise financeira do projeto.</sup>

</div>

---

### 2.4. Oportunidades

&emsp; A Tabela 7 relaciona as oportunidades identificadas - catorze ao todo, para dar à equipe um leque real de opções ao montar a matriz no Figma. As seis primeiras (O01–O06) reproduzem, quase literalmente, a lista que o próprio material do parceiro chama de "onde há mais espaço para ganho" em relação ao baseline atual do Argus - incluindo a seção que o documento intitula "a oportunidade real". As demais (O07–O14) vêm de outras partes do mesmo material (dicionário de dados, apêndices de tabelas, TAPI): mecanismos já desenhados mas ainda vazios ou não usados, e regras de baixo esforço com limiar já documentado pelo próprio parceiro.

<div align="center">

<sup>Tabela 7: Oportunidades Identificadas</sup>

| ID | Descrição | Categoria | P | I | Nível (P × I) | Estratégia | Responsável |
|:---|:---|:---|:---|:---|:---|:---|:---|
| **O01** | O próprio material do parceiro afirma que o gargalo do sistema atual não é o algoritmo de detecção, e sim a quantidade de ground truth disponível: expandir e curar o golden set de rótulos (`incident_label`) a partir da telemetria e dos tickets históricos, com critério documentado e revisão cruzada, produz um ativo que a Globo hoje não possui - e que tem valor mesmo sem superar o baseline estatisticamente. | **Dados/ML** *(Ground Truth e Avaliação)* | 4 | 5 | 20 - Crítico | Explorar | Squad ML/Dados (G05) |
| **O02** | O calendário de transmissões ao vivo (`live_event`, com horário, time e competição) está disponível desde a revisão mais recente do dataset, mas ainda não é usado pelo detector em produção; é apontado como a maior fonte remanescente de falso positivo (picos de audiência de grandes jogos/eventos confundidos com anomalia) - ou seja, "ganho disponível, ganho não capturado". | **Produto/ML** *(Sazonalidade)* | 4 | 4 | 16 - Crítico | Explorar | Squad ML/Dados (G05) |
| **O03** | Hoje a detecção agrupa anomalias que coincidem no tempo, sem inferir direção de causa e efeito; um grafo de dependência entre serviços já existe no repositório do parceiro e está subutilizado, abrindo espaço para diagnósticos de causa raiz mais precisos do que correlação puramente temporal. | **Produto/ML** *(Causalidade)* | 2 | 4 | 8 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O04** | O gate de corroboração (exigir anomalia em ≥2 fontes distintas) esconde colapsos reais de fonte única - caso documentado da Globoplay Search API, com taxa de erro de 11% contra baseline de 0,02%, só detectada uma hora depois; propor um critério melhor sem reintroduzir o ruído que levou a Globo a desligar o modo `single_source` é indicado pelo próprio parceiro como bom alvo de pesquisa. | **Produto/ML** *(Sensibilidade de Detecção)* | 3 | 3 | 9 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O05** | Cada série é avaliada isoladamente hoje, com a correlação entre fontes vindo somente depois da detecção; um modelo que observe o vetor de estado completo pode capturar padrões que nenhuma série individual denuncia sozinha. | **Produto/ML** *(Detecção Multivariada)* | 2 | 4 | 8 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O06** | O score de anomalia em produção é heurístico (soma ponderada do z-score pelo número de fontes corroborantes), não uma probabilidade calibrada; introduzir calibração (ex.: Platt scaling) aumentaria a interpretabilidade do ranking de alertas para o operador (RF08, RNF10). | **Produto/ML** *(Calibração)* | 3 | 2 | 6 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O07** | Os resultados do MVP entregue ao final do módulo, incluindo o ganho documentado sobre o baseline do Argus, demonstram valor suficiente para justificar a continuidade da parceria Inteli–Globo em uma fase seguinte - alinhado à dimensão de Parcerias do TAPI, que já aponta potencial de evolução para integração com outros sistemas internos da Globo. | **Negócio** *(Continuidade da Parceria)* | 3 | 4 | 12 - Alto | Compartilhar | Liderança de projeto (G05) |
| **O08** | O peso de audiência por canal/PoP (`cdn_entity_tier`: tier 1 ≥100 req/s, tier 2 ≥10 req/s, tier 3 o resto) já existe e é indicado pelo próprio parceiro como "um bom peso para função de custo"; usá-lo para descontar alertas em entidades de baixo tráfego reduz fadiga de alerta sem exigir novo modelo. | **Produto/ML** *(Priorização de Alertas)* | 3 | 3 | 9 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O09** | A tabela `investigation_feedback` (voto humano - agree/partial/disagree, causa corrigida) existe no schema mas está vazia neste snapshot; pilotar esse fluxo desde o MVP cria, desde já, uma fonte contínua de rótulos de qualidade para alimentar o golden set (O01), em vez de depender só de rotulagem retroativa. | **Dados/ML** *(Retroalimentação Humana)* | 3 | 3 | 9 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O10** | O parceiro já documentou o limiar de anomalia nos quatro vhosts de playback (baseline ~5% de 4xx, surto para 37% = falha real de autorização de token) - uma regra de alerta pronta, escopada e de baixo esforço, em contraste com a maioria dos vhosts, onde 4xx é comportamento normal do cliente e geraria ruído se tratado como sinal. | **Produto/ML** *(Alerta de Alta Precisão)* | 4 | 3 | 12 - Alto | Explorar | Squad ML/Dados (G05) |
| **O11** | `dashboard_artifact` já contém a saída pré-computada do Argus atual para o mesmo período do snapshot; construir uma comparação lado a lado (baseline vs. sistema do grupo) como funcionalidade nativa do dashboard (RF07) entrega, de forma visual e imediata, evidência do ganho sobre o baseline exigido pelo RNF08. | **Produto** *(Benchmarking)* | 4 | 3 | 12 - Alto | Explorar | Squad Backend/ML (G05) |
| **O12** | O NPAW já classifica erros de player em 5 categorias acionáveis e auditáveis (entrega, origem, acesso, player, outros), com regra determinística e versionada; adotar essa taxonomia pronta em vez de construir uma nova do zero economiza esforço de modelagem sem perder rigor. | **Produto/ML** *(Reuso de Taxonomia)* | 4 | 2 | 8 - Médio | Melhorar | Squad ML/Dados (G05) |
| **O13** | O anexo de fontes de dados cita Amplitude (jornada/cliques no app) e métricas de Redis (saturação de cache, `rejected_rate`, `evicted_rate`) como fontes existentes mas ainda fora do escopo do MVP; integrá-las em uma fase seguinte ampliaria a cobertura de diagnóstico para jornada do usuário e causas-raiz na camada de cache. | **Produto** *(Extensão de Escopo)* | 2 | 4 | 8 - Médio | Aceitar | Squad Backend/Dados (G05) |
| **O14** | O ODS de Parcerias do TAPI já enquadra o projeto como "inovação em infraestrutura tecnológica nacional" num mercado dominado por sistemas de monitoração multinacionais; reforçar esse posicionamento (propriedade intelectual nacional, não apenas substituição de custo) fortalece o argumento estratégico do projeto para além da economia já quantificada ([análise financeira, Seção 4](#44-valor-gerado-economia-de-custos-ano-1)). | **Negócio** *(Posicionamento Estratégico)* | 2 | 3 | 6 - Médio | Compartilhar | Liderança de projeto (G05) |

<sup>Fonte: Material produzido pelos autores (2026), com base na documentação do dataset Argus (Seções 5, 8.3, 10 e Apêndice A) e no TAPI do projeto.</sup>

</div>

---

<div align="center">

<sup>Figura 2: Matriz de Probabilidade × Impacto - Riscos e Oportunidades</sup>

![Matriz de risco e oportunidades](../assets/matriz-risco-oportunidade.png)

<sup>Fonte: elaborado pelo grupo G05 (2026), a partir dos riscos e oportunidades detalhados nas Tabelas 6 e 7.</sup>

</div>

---

### 2.5. Processo de revisão e atualização

&emsp; Esta matriz deve ser revisada a cada entrega do módulo, ou sempre que um novo risco ou oportunidade relevante for identificado, seguindo os passos abaixo:

1. Descrever o evento e enquadrá-lo como risco (ameaça) ou oportunidade.
2. Atribuir o próximo código sequencial disponível (RXX ou OXX) e a categoria mais próxima das já usadas nas Tabelas 6 e 7.
3. Classificar Probabilidade (Tabela 1) e Impacto (Tabela 2) e calcular o Nível pela Tabela 3.
4. Definir a estratégia de resposta (Tabela 4 ou 5) e o responsável.
5. Posicionar o código na célula correspondente da matriz visual e manter a imagem deste documento e o quadro no Figma atualizados.

&emsp; Riscos e oportunidades classificados como Alto ou Crítico - em particular a insuficiência do golden set para o RNF08 (R01/O01) e a latência estrutural do NPAW frente ao RNF02 (R02) - devem ter sua reavaliação compartilhada com os pontos focais da Globo (Igor Thurow - líder técnico; Carlos Papani - líder do projeto; Thiago Frensch - ponto focal backup), na mesma lógica de validação já adotada para as premissas financeiras (ver [análise financeira, Seção 1](#41-premissas-e-contexto)). R01 e R02 em particular indicam que o plano de testes do RNF08 e do RNF02 pode precisar de ajuste fino de escopo - uma conversa a ter com o professor orientador (Tomaz Mikio Sasaki) e com a Globo antes de travar os critérios de aceite finais.

---

## 3. Canvas de Proposta de Valor

&nbsp;&nbsp;&nbsp;&nbsp;A Proposta de Valor (Value Proposition Canvas) é um modelo estratégico de posicionamento de mercado que define o conjunto de benefícios tangíveis e intangíveis que uma organização se compromete a entregar aos seus segmentos de clientes (OSTERWALDER et al., 2014). Ela atua como o núcleo de diferenciação competitiva, alinhando as capacidades operacionais da empresa com as necessidades específicas do mercado-alvo.

<figure>
  <img src="../assets/negocios/Canvas_prop.png" alt="Canvas De Proposta de Valor" width="500">
  <figcaption>
  </figcaption>
</figure>
<strong>Figura 3:</strong> Canvas de Proposta de Valor<br>
    <em>Fonte: Grupo 05 (2026).</em>

---

### 3.1. Perfil do Cliente

&nbsp;&nbsp;&nbsp;&nbsp;O cliente deste projeto é o conjunto de times internos responsáveis pela operação do serviço de streaming da Globo (GloboPlay): times de Engenharia de Aplicativos (mobile, web, TV), Engenharia de Plataforma de Vídeo, SRE/Observabilidade e Produto. Esses times atuam em um contexto de alta escala e alta heterogeneidade de dispositivos, onde coexistem Smart TVs modernas, TVs com firmware antigo, set-top boxes, dispositivos móveis com diversas versões de sistema operacional e navegadores com capacidades distintas.

Internamente, esses times são cobrados por manter a qualidade de experiência (QoE) do usuário final, cumprir SLAs de disponibilidade e desempenho e controlar custos operacionais ligados à observabilidade e monitoramento. Externamente, o serviço é avaliado por milhões de usuários que esperam que o conteúdo esteja disponível rapidamente, sem travamentos e com qualidade consistente, independentemente do dispositivo.

O cliente, portanto, não é um usuário final individual, mas uma organização técnica que depende de telemetria confiável para operar o produto de streaming com segurança. A solução proposta precisa dialogar diretamente com essa realidade: alta escala, ambiente heterogêneo, necessidade de diagnóstico rápido e forte pressão por eficiência operacional e econômica.

---

### 3.2. Tarefas do Cliente

As tarefas do cliente podem ser divididas em funcionais, sociais e emocionais, cada uma respresentando a responsabilidade da equipe em concluir a operaçao em diferentes níveis. Na proposta de valor, as tarefas funcionais são as ações práticas e objetivas que o cliente precisa realizar (como resolver um problema técnico), as tarefas sociais envolvem a busca por status, reconhecimento e como ele deseja ser visto pelo ecossistema ao seu redor, e as tarefas emocionais referem-se ao estado psicológico que ele deseja alcançar ou evitar, como a busca por segurança, paz ou alívio do estresse. Essas três dimensões revelam as reais motivações do consumidor, permitindo que o grupo Globo crie soluções que atendam tanto às necessidades utilitárias quanto aos desejos subjetivos de seu público.

#### Tarefas funcionais

Funcionalmente, os times precisam:

- Monitorar a saúde do aplicativo e do player em múltiplas plataformas (mobile, web, TVs, dispositivos legados), acompanhando eventos como screen_view, video_view, request, session e error.

- Detectar rapidamente degradações de qualidade de experiência (QoE), como aumento de tempo de carregamento de vídeo, falhas de início de playback, aumento de erros de requisição ou ANRs em dispositivos específicos.

- Investigar a causa raiz de incidentes, correlacionando eventos de frontend com backend, CDN e plataforma de vídeo para responder perguntas como “o problema está no app, na API, na CDN ou na infraestrutura do dispositivo?”.

- Cumprir SLAs e metas internas, garantindo que indicadores como taxa de playback bem-sucedido, latência de startup e estabilidade por dispositivo/região se mantenham dentro de limites aceitáveis.

- Reduzir custos de observabilidade, buscando alternativas a ferramentas externas de RUM/APM que se tornam muito caras em ambientes com grande volume de sessões.

- Integrar telemetria com o ecossistema interno, exportando dados para data lakes, ferramentas de alerta, sistemas de ticket e dashboards já utilizados pela empresa.

#### Tarefas sociais

No plano social, esses times precisam:

- Demonstrar para a liderança técnica e de negócios que possuem controle sobre a saúde do produto, apresentando dados claros sobre estabilidade e qualidade de experiência.

- Construir credibilidade com outras áreas, como Produto e Conteúdo, mostrando que problemas técnicos são detectados e mitigados com rapidez.

- Sustentar a imagem da empresa como uma plataforma de streaming confiável, que funciona bem nos principais eventos (jogos, finais de reality, estreias de novelas e séries).

- Coordernar resposta a incidentes entre múltiplos times, o que exige uma fonte de verdade única sobre o que está acontecendo nos dispositivos dos usuários.

#### Tarefas emocionais

Em termos emocionais, há várias pressões importantes:

- Reduzir a ansiedade e o estresse durante grandes eventos, evitando a sensação de “voo às cegas” quando a audiência dispara.

- Ter segurança de que, ao lançar uma nova versão de app, os times conseguirão detectar rapidamente qualquer regressão de QoE ou estabilidade.

- Sentir autonomia técnica, sem depender totalmente de decisões de fornecedores externos para algo tão crítico quanto a observabilidade do produto.

- Orgulho profissional de operar uma plataforma de streaming com um nível de monitoramento sofisticado e adequado à realidade da base de dispositivos.

&nbsp;&nbsp;&nbsp;&nbsp;Contudo, abstraindo a responsabilidade de tarefas do cliente, é concluído que o projeto tem a responsabiliade de funcionar em todas as frentes descritas, detalhando o propósito de cada solução de arquitetura em relação as decisões estratégicas utilizadas pelo grupo Globo. 

---

### 3.3. Dores do Cliente

&nbsp;&nbsp;&nbsp;&nbsp;As dores a seguir são delimitadas em relação ao projeto e descrevem problemas concretos que a solução se propõe a solucionar. Os relatos foram levantados junto ao parceiro Globoplay, com base em entrevistas e reuniões de levantamento de requisitos com as equipes de Engenharia, SRE e Produto (GRUPO GLOBO, 2026), e cada dor é classificada quanto à sua **severidade** (Extrema ou Moderada), conforme o nível de impacto na operação e na experiência do usuário.

#### Pontos cegos em dispositivos legados

**Severidade:** Extrema

&nbsp;&nbsp;&nbsp;&nbsp;Parte relevante da audiência usa TVs e dispositivos legados que não suportam padrões modernos de telemetria. Hoje, esses clientes praticamente “somem” dos dashboards (GRUPO GLOBO, 2026), o que significa que incidentes concentrados nessa base só são percebidos quando chegam em suporte, redes sociais ou indicadores indiretos. Essa falta de visibilidade compromete o controle operacional e aumenta o risco de crises em segmentos específicos.

#### Métricas agregadas e baixa segmentação escondem problemas locais

**Severidade:** Extrema

&nbsp;&nbsp;&nbsp;&nbsp;Os sistemas atuais tendem a apresentar métricas agregadas por aplicação ou região ampla, e a falta de filtros por device family, device model, OS version, app version, CDN e tipo de playback limita a investigação. Problemas que atingem um conjunto específico de devices, versões de app ou combinações de OS e CDNs podem passar despercebidos, pois se diluem na média global, o que dificulta responder perguntas operacionais como “acontece só na versão X?”, “só em tal marca de TV?” ou “só em live?”. Isso leva a uma detecção tardia de incidentes e dificulta justificar que “o problema está em X e não no serviço inteiro”.

#### Diagnóstico lento e fragmentado de incidentes

**Severidade:** Extrema

&nbsp;&nbsp;&nbsp;&nbsp;Quando um problema é detectado, o caminho até a causa raiz é longo. Muitas vezes é necessário cruzar manualmente dados de diferentes ferramentas (RUM, logs, APM, ferramentas de player), sem uma visão contínua da sessão do usuário. Isso resulta em MTTR elevado, maior duração dos incidentes e maior impacto na experiência do usuário.

#### Custo elevado com ferramentas externas de observabilidade

**Severidade:** Moderada

&nbsp;&nbsp;&nbsp;&nbsp;Como as ferramentas de mercado cobram por volume de eventos/sessões, a combinação de alta audiência com necessidade de detalhamento gera custos anuais muito altos. Em alguns casos, a solução é reduzir o nível de detalhe ou o volume coletado, o que volta a piorar a visibilidade. Essa dor é tanto técnica (limitação de uso) quanto financeira.

#### Dependência estratégica de fornecedores (vendor lock-in)

**Severidade:** Moderada

&nbsp;&nbsp;&nbsp;&nbsp;A empresa depende de ferramentas externas para uma capacidade crítica: enxergar o que está acontecendo na ponta. Mudanças de preço, de contrato, de roadmap de produto ou até a descontinuação de integrações podem impactar diretamente a operação. Isso gera risco estratégico e reduz a capacidade de planejar a longo prazo.

#### Dificuldade de lidar com protocolos heterogêneos e legados

**Severidade:** Moderada

&nbsp;&nbsp;&nbsp;&nbsp;A diversidade de dispositivos implica múltiplos padrões e limitações de comunicação. Protocolos antigos, payloads limitados, falta de suporte a bibliotecas modernas de observabilidade: tudo isso torna difícil usar soluções “one size fits all”. Parte dos devices simplesmente não consegue falar com os sistemas atuais de telemetria.

#### Correlação limitada entre frontend, player e backend

**Severidade:** Extrema

&nbsp;&nbsp;&nbsp;&nbsp;Em diversas situações, é difícil saber se uma reclamação do usuário está ligada a um problema no app, na API, na CDN ou na infraestrutura local. Falta um identificador consistente de sessão e uma telemetria que conecte os vários pontos da jornada, o que leva a discussões subjetivas entre times em vez de decisões guiadas por dados.

---

### 3.4. Ganhos do Cliente

&nbsp;&nbsp;&nbsp;&nbsp;Os ganhos abaixo descrevem vantagens internas e externas que o cliente terá com a implementação da plataforma de telemetria proposta. Cada ganho é classificado quanto à sua **relevância** para o cliente (Essencial ou Bom ter), conforme o quanto impacta diretamente a operação e as metas do parceiro.

#### Visibilidade completa da base de dispositivos

**Relevância:** Essencial

&nbsp;&nbsp;&nbsp;&nbsp;Com a criação de uma plataforma capaz de receber, normalizar e processar dados de dispositivos modernos e legados, o cliente passa a enxergar o comportamento de praticamente toda a audiência. Isso elimina pontos cegos em segmentos importantes e permite que decisões sejam tomadas com uma visão mais fiel da realidade.

#### Detecção precoce de degradações e incidentes

**Relevância:** Essencial

&nbsp;&nbsp;&nbsp;&nbsp;A combinação de coleta em tempo quase real, segmentação rica e métricas específicas de QoE permite identificar degradações ainda em estágio inicial, muitas vezes antes de gerarem picos em suporte ou repercussão externa. Internamente, isso se traduz em uma operação mais proativa; externamente, em menos impacto percebido pelo usuário final.

#### Redução do tempo de diagnóstico e resolução (MTTD/MTTR)

**Relevância:** Essencial

&nbsp;&nbsp;&nbsp;&nbsp;Ao fornecer dashboards com filtros cumulativos, correlação por sessão e visões segmentadas, a plataforma encurta o caminho entre “algo está errado” e “o problema está exatamente aqui”. Isso reduz MTTD (tempo para detectar) e MTTR (tempo para resolver), o que é crítico tanto para operação quanto para percepção do usuário.

#### Redução de custos com ferramentas de observabilidade

**Relevância:** Essencial

&nbsp;&nbsp;&nbsp;&nbsp;Ao internalizar parte importante da telemetria e usar a plataforma própria como fonte principal, a empresa pode reduzir o uso intensivo de ferramentas externas caras. Isso diminui o custo total de observabilidade, libera orçamento para outras iniciativas e reduz a pressão para fazer trade-offs entre custo e nível de detalhamento. 

#### Autonomia e flexibilidade técnica

**Relevância:** Bom ter

&nbsp;&nbsp;&nbsp;&nbsp;Com schema próprio, adaptadores por protocolo e APIs unificadas, a empresa ganha autonomia para evoluir a plataforma conforme surgem novas necessidades, novos tipos de dispositivos ou novas métricas de interesse. Isso diminui a dependência de roadmaps de terceiros e permite que a telemetria acompanhe mais de perto a evolução do produto.

#### Métricas de QoE mais relevantes e acionáveis

**Relevância:** Essencial

&nbsp;&nbsp;&nbsp;&nbsp;A nova plataforma permite definir métricas alinhadas ao negócio de streaming, como tempo até início do vídeo, taxa de falha de playback, rebuffer ratio e impacto de certos dispositivos ou rotas de entrega. Essas métricas são mais diretamente relacionadas à experiência do usuário e às metas de produto, aumentando a qualidade das decisões internas.

#### Melhor cumprimento de SLAs e metas internas

**Relevância:** Essencial

&nbsp;&nbsp;&nbsp;&nbsp;Com monitoramento mais preciso por segmento, alertas configuráveis e análises históricas, fica mais fácil acompanhar e garantir o cumprimento de SLAs de qualidade e disponibilidade. Internamente, isso reduz risco de multas e de conflitos entre áreas; externamente, reforça a imagem de confiabilidade para parceiros comerciais e para o público.

#### Melhoria da experiência do usuário final e vantagem competitiva

**Relevância:** Bom ter

&nbsp;&nbsp;&nbsp;&nbsp;No fim da cadeia, uma telemetria mais rica e uma operação mais eficiente se traduzem em menos travamentos, início de vídeo mais rápido e menos frustração para o usuário. Em um mercado competitivo de streaming, essa melhoria consistente de experiência é um ganho externo importante, que contribui para retenção e diferencial competitivo.

&nbsp;&nbsp;&nbsp;&nbsp;Esses benefícios estão claramente alinhados às expectativas dos clientes internos (engenharia, SRE, produto, gestão) e também refletem efeitos externos desejáveis (melhor percepção do usuário, vantagem competitiva), atendendo ao nível máximo esperado pelo grupo Globo. 

---

### 3.5. Mapa de Valor

&nbsp;&nbsp;&nbsp;&nbsp;Enquanto o Perfil do Cliente descreve o lado direito da Figura 3 (tarefas, dores e ganhos), o **Mapa de Valor** representa o lado esquerdo do Canvas de Proposta de Valor: o conjunto de produtos e serviços que a plataforma proposta entrega, e como cada um deles alivia as dores e amplifica os ganhos mapeados anteriormente.

#### Produtos e Serviços

- Plataforma proprietária de telemetria multiplataforma, cobrindo mobile, web, Smart TVs e dispositivos legados.
- APIs unificadas e adaptadores de protocolo para coleta de eventos em dispositivos com padrões antigos de comunicação.
- Schema canônico de eventos (`screen_view`, `video_view`, `request`, `session`, `error`), com campos customizáveis de contexto e QoE.
- Dashboards com filtros cumulativos e segmentação por device family, modelo, OS, versão de app, CDN e tipo de playback.
- Identificador de sessão único, que permite correlacionar eventos entre frontend, player e backend.
- Integrações nativas com data lakes, sistemas de alerta, ferramentas de ticket e dashboards já usados internamente pelo Globoplay.

#### Analgésicos (Pain Relievers)

&nbsp;&nbsp;&nbsp;&nbsp;Os analgésicos descrevem como os produtos e serviços acima aliviam, especificamente, as dores mapeadas no Perfil do Cliente:

- Os adaptadores de protocolo e as APIs unificadas eliminam os **pontos cegos em dispositivos legados**.
- A segmentação rica por device, OS, versão de app e CDN resolve o problema de **métricas agregadas e baixa segmentação**.
- O identificador de sessão único elimina a **correlação limitada entre frontend, player e backend**, substituindo discussões subjetivas por dados.
- Os dashboards com correlação por sessão e filtros cumulativos atacam diretamente o **diagnóstico lento e fragmentado de incidentes**.
- A arquitetura proprietária, com custo marginal decrescente, reduz o **custo elevado com ferramentas externas de observabilidade**.
- O schema próprio e as APIs unificadas eliminam a **dependência estratégica de fornecedores (vendor lock-in)** e a **dificuldade de lidar com protocolos heterogêneos e legados**.

#### Criadores de Ganho (Gain Creators)

&nbsp;&nbsp;&nbsp;&nbsp;Os criadores de ganho descrevem como os produtos e serviços amplificam os ganhos mapeados no Perfil do Cliente:

- A normalização de dados de toda a base de dispositivos gera a **visibilidade completa da base de dispositivos**.
- A coleta em tempo quase real, combinada a métricas específicas de QoE, viabiliza a **detecção precoce de degradações e incidentes**.
- Os dashboards com correlação por sessão reduzem diretamente o **MTTD/MTTR**.
- O modelo de custo marginal decrescente da plataforma proprietária sustenta a **redução de custos com ferramentas de observabilidade**.
- O schema customizável e as APIs unificadas garantem **autonomia e flexibilidade técnica**.
- As métricas de QoE alinhadas ao negócio de streaming entregam **métricas mais relevantes e acionáveis**.

---

### 3.6. Conclusão

&nbsp;&nbsp;&nbsp;&nbsp;A análise do Canvas de Proposta de Valor evidencia que o projeto responde de forma direta e consistente às necessidades específicas do parceiro no contexto de streaming multiplataforma. O perfil do cliente, composto por times de engenharia de aplicativos, plataforma de vídeo, SRE/observabilidade e produto, opera em um ambiente de alta escala e grande heterogeneidade de dispositivos, no qual visibilidade operacional não é um opcional, mas um pré‑requisito para manter a qualidade de experiência e cumprir SLAs.

&nbsp;&nbsp;&nbsp;&nbsp;Do ponto de vista das tarefas do cliente, a solução se posiciona como um habilitador central para monitorar a saúde do frontend, detectar degradações de QoE, investigar causa raiz de incidentes, integrar dados ao ecossistema interno e, ao mesmo tempo, controlar custos de observabilidade. As dores identificadas, especialmente os pontos cegos em dispositivos legados, a dependência de métricas agregadas, o diagnóstico lento e o custo elevado de ferramentas externas, são diretamente endereçadas pela proposta de valor por meio de APIs unificadas, suporte a protocolos legados, normalização de eventos, segmentação rica e correlação por sessão.

&nbsp;&nbsp;&nbsp;&nbsp;Em contrapartida, os ganhos mapeados, como visibilidade completa por dispositivo e plataforma, detecção precoce de problemas, redução de MTTD/MTTR, diminuição do gasto com soluções de mercado e maior autonomia técnica, derivam de capacidades concretas da solução. Internamente, isso se traduz em operação mais eficiente, menor exposição a riscos de SLA e melhor uso de recursos financeiros. Externamente, contribui para uma experiência de streaming mais estável e consistente, reforçando a percepção de confiabilidade da plataforma perante os usuários e o mercado.

---

## 4. Análise Financeira

Estimativas construídas a partir das demandas levantadas junto ao parceiro para o horizonte de 1 ano (investimentos, custos e receitas). Todos os valores devem ser tratados como estimativas e revisados conforme o projeto evolui.

---

### 4.1. Premissas e contexto

| Premissa | Descrição |
|---|---|
| Escopo considerado | MVP definido no termo de parceria: API única de ingestão de eventos, suporte a protocolos legados (dispositivos antigos), pipeline de ingestão/armazenamento em alta escala sem perdas, normalização mínima, consultas para análise de falhas críticas e dashboard com filtros cumulativos. Cobre a transição do MVP acadêmico para uma operação assistida no Ano 1. |
| Horizonte temporal | 12 meses (set/2026 a ago/2027, a partir da entrega do MVP ao final do módulo) |
| Demandas do parceiro consideradas | Ingestão multiplataforma (7 plataformas — iOS, Android, Android TV, Fire TV, tvOS, Web, Smart TVs), suporte a protocolos modernos e legados, absorção de picos de até 4,1 milhões de sessões simultâneas em eventos ao vivo, normalização de 13+ fontes de dados na camada unificada (`signal_point`), e restrição contratual de não compartilhar dados/desafios com terceiros — o que exige operação em infraestrutura própria, sem terceirizar o dado sensível a SaaS externos. |
| Moeda | BRL (R$) |
| Metodologia de estimativa | O termo de parceria e o anexo de fontes de dados fornecidos pelo parceiro não disponibilizam orçamento real da Globo. Os valores abaixo foram estimados por **benchmarking de mercado** (custo de infraestrutura cloud equivalente ao volume de dados descrito no anexo — ex.: ~68 milhões de pontos no Prometheus, ~35,8 milhões de linhas na tabela unificada `signal_point`, 13+ fontes distintas) e por **valor/hora médio de squads** de engenharia de backend/dados no mercado brasileiro. Devem ser validados com os pontos focais do parceiro (Igor Thurow — líder técnico; Carlos Papani — líder do projeto) antes de qualquer decisão de investimento real. |

---

### 4.2. Investimentos iniciais (CAPEX)

| Item | Descrição | Valor estimado (R$) | Justificativa |
|---|---|---|---|
| Infraestrutura cloud inicial | Provisionamento de cluster (GKE), feature store/BigQuery, Cloud Armor e ambientes de staging | 40.000 | Réplica, em ambiente próprio, das bases já usadas pelo correlator (NewRelic, Prometheus, Apollo, RPaaS-fe, Tsuru, Cloud Armor, Youbora) listadas no anexo de fontes de dados |
| Ferramentas e licenças de desenvolvimento | Observabilidade do próprio backend, CI/CD, ferramentas de teste de carga | 12.000 | Necessário para validar o requisito de ingestão "sem perdas" sob alta escala exigido no MVP |
| Ambiente de testes multiplataforma | Dispositivos/emuladores para os 7 sistemas suportados (incluindo legados) | 18.000 | Exigido para validar suporte a protocolos legados e normalização mínima em dispositivos mais antigos, conforme escopo macro do termo |
| Discovery e levantamento de requisitos | Entrevistas com stakeholders da Globo, mapeamento das 13+ fontes de dados, protótipos de dashboard | 15.000 | Horas da equipe (Inteli + pontos focais Globo: Carlos Papani, Thiago Frensch, Igor Thurow) já investidas na fase de elicitação do projeto |
| **Total CAPEX** | | **85.000** | |

---

### 4.3. Custos operacionais (OPEX) — Ano 1

| Categoria | Custo mensal (R$) | Custo anual (R$) | Justificativa |
|---|---|---|---|
| Pessoal / equipe | 30.000 | 360.000 | Squad de continuidade pós-MVP (2 devs backend/dados sênior + 1 SRE, alocação ~50%) dimensionado para o volume de 13+ fontes e ~35,8M linhas na camada unificada |
| Infraestrutura (cloud, hospedagem) | 18.000 | 216.000 | Estimado pelo volume de dados do anexo (Prometheus a cada 5 min, ~68M pontos) e por picos de até 4,1M sessões simultâneas em eventos ao vivo, operando em infraestrutura própria (restrição de não usar dados de terceiros) |
| Ferramentas e licenças | 2.500 | 30.000 | Observabilidade complementar, segurança e qualidade de código |
| Marketing / aquisição de clientes | 0 | 0 | Não aplicável — solução de uso interno (times de engenharia, observabilidade e produto do Globoplay), sem comercialização externa |
| Manutenção e suporte | 6.000 | 72.000 | Ajustes de normalização para novos protocolos/dispositivos legados e suporte a incidentes |
| Outros (contingência ~10%) | 5.650 | 67.800 | Margem para variações de escopo e picos de uso não previstos |
| **Total OPEX** | **62.150** | **745.800** | |

---

### 4.4. Valor gerado / economia de custos — Ano 1

**Adaptação de escopo:** este é um projeto de ferramenta interna entregue a um parceiro corporativo, não um produto comercializado com receita direta. Por isso, a seção "Receitas" do modelo padrão foi substituída por **valor gerado / economia de custos** para a Globo, coerente com a proposta do termo de parceria (redução de custo com ferramentas externas de monitoração e redução do tempo de diagnóstico de incidentes).

| Fonte de valor | Modelo | Premissa de volume/impacto | Valor estimado Ano 1 (R$) | Justificativa |
|---|---|---|---|---|
| Redução de custo com ferramentas de observabilidade externas | Substituição parcial de contratos de terceiros | Parte do gasto hoje distribuído entre múltiplas ferramentas por componente (13+ fontes monitoradas separadamente, conforme anexo de fontes de dados) passa a ser coberta pela camada unificada própria | 400.000 | Benchmarking de mercado para contratos enterprise de observabilidade (ex.: New Relic, Datadog) em plataformas do porte do Globoplay; premissa conservadora de substituição parcial (não total) no primeiro ano |
| Redução do custo de diagnóstico manual (MTTR) | Ganho de eficiência operacional | Hoje a correlação de causa raiz exige "reunião de especialistas" por componente (player, CDN, backend, identidade, catálogo), conforme material do parceiro; a correlação automatizada reduz horas de especialista por incidente | 300.000 | Estimativa de horas de especialista evitadas por incidente × custo-hora médio de squads sênior × volume mensal de incidentes reportado como relevante pelo parceiro |
| Redução de perdas por degradação em eventos de alta audiência | Cost avoidance | Menor tempo até a causa provável reduz a janela de degradação em picos de audiência (até 4,1 milhões de sessões simultâneas em eventos ao vivo) | 200.000 | Estimativa conservadora de impacto evitado em SLA/experiência do usuário durante eventos críticos, sem dado de penalidade contratual real disponibilizado pelo parceiro |
| **Total de valor gerado** | | | **900.000** | |

---

### 4.5. Projeção financeira consolidada — Ano 1 (trimestral)

Assume-se adoção gradual do valor gerado (rollout dos times internos usando a plataforma) e CAPEX concentrado no Q1.

| | Q1 | Q2 | Q3 | Q4 | Total Ano 1 |
|---|---|---|---|---|---|
| Valor gerado / economia | 90.000 | 180.000 | 270.000 | 360.000 | 900.000 |
| Custos (OPEX) | 186.450 | 186.450 | 186.450 | 186.450 | 745.800 |
| Investimentos (CAPEX) | 85.000 | 0 | 0 | 0 | 85.000 |
| Resultado do período | -181.450 | -6.450 | 83.550 | 173.550 | 69.200 |
| Fluxo de caixa acumulado | -181.450 | -187.900 | -104.350 | 69.200 | 69.200 (final) |

---

### 4.6. Ponto de equilíbrio (break-even)

Considerando a curva de adoção premissada (10% / 20% / 30% / 40% do valor gerado ao longo dos trimestres), o fluxo de caixa acumulado torna-se positivo dentro do **Q4**, por volta do **11º mês**, quando a economia acumulada supera CAPEX + OPEX acumulados. Essa estimativa depende fortemente de dois fatores não confirmados com o parceiro: (i) a velocidade real de adoção da plataforma pelos times de engenharia/observabilidade/produto da Globo, e (ii) o percentual efetivo de substituição de ferramentas externas de monitoração — nenhum dos dois consta no anexo de fontes de dados ou no termo de parceria.

---

### 4.7. Riscos financeiros e sensibilidade

- **Adoção mais lenta que a premissada**: se os times internos da Globo levarem mais tempo para migrar da monitoração por silo para a camada unificada, o break-even se desloca para além do Ano 1.
- **Ausência de dados reais de custo**: as estimativas de economia dependem de valores de contrato com ferramentas externas (New Relic, Datadog etc.) que não foram disponibilizados — o anexo de fontes de dados lista as fontes técnicas, não seus custos de licenciamento.
- **Volume de dados acima do estimado**: picos de audiência maiores que os 4,1 milhões de sessões simultâneas observados, ou o avanço do requisito de novas fontes/protocolos, podem elevar o OPEX de infraestrutura além do projetado.
- **Restrição de não compartilhar dados com terceiros**: impede o uso de serviços gerenciados de terceiros para reduzir custo de infraestrutura, mantendo a dependência de operação própria (Pessoal + Infraestrutura concentram ~77% do OPEX).
- **Escalonamento de suporte a dispositivos legados**: cada novo protocolo/dispositivo legado suportado tende a aumentar o custo de manutenção acima do premissado.
- Estes riscos financeiros estão consolidados, com estratégia de resposta e responsável, na [Matriz de Risco e Oportunidades](#2-matriz-de-risco-e-oportunidades) (itens R11 e R12).

---

## 5. Análise de Impacto nos ODS (Objetivos de Desenvolvimento Sustentável)

Avaliação de como o projeto se relaciona com os 17 Objetivos de Desenvolvimento Sustentável da ONU, identificando impactos diretos, indiretos e oportunidades de contribuição.

**Contexto do projeto:** o projeto é uma plataforma distribuída, desenvolvida para o Grupo Globo (Globoplay), para coleta, normalização e correlação de telemetria (QoS técnico + QoE percebida) de aplicações frontend rodando em dispositivos extremamente heterogêneos (TVs antigas, celulares de baixo custo, redes instáveis) em todo o território nacional — incluindo suporte a protocolos legados não atendidos por ferramentas de monitoração de mercado. As classificações abaixo seguem o checklist de impacto ODS já validado no termo de parceria com o Inteli (`TAPI - Turma 15 - Ciência da Computação - Módulo 7.pdf`), detalhado com base no escopo técnico do projeto e nas fontes de dados apresentadas pelo parceiro.

### 5.1. Mapeamento geral

| ODS | Relação com o projeto (Direta / Indireta / Não se aplica) | Descrição do impacto | Indicador ou meta relacionada |
|---|---|---|---|
| ODS 1 — Erradicação da Pobreza | Não se aplica | O projeto não atua sobre renda ou condições de pobreza; é um backend de observabilidade B2B interno ao Grupo Globo. | — |
| ODS 2 — Fome Zero e Agricultura Sustentável | Não se aplica | Sem relação com segurança alimentar ou agricultura. | — |
| ODS 3 — Saúde e Bem-Estar | Não se aplica | Não há relação com saúde física/mental; o "bem-estar" endereçado é o de experiência digital, não de saúde. | — |
| ODS 4 — Educação de Qualidade | Indireta | Promove capacitação técnica das equipes envolvidas em arquitetura de sistemas distribuídos, integração via APIs e tratamento de heterogeneidade de protocolos (modernos e legados), alinhado a boas práticas de engenharia de software. | Nº de práticas/competências de engenharia de sistemas distribuídos aplicadas pela equipe durante o projeto |
| ODS 5 — Igualdade de Gênero | Não se aplica | Sem relação com igualdade de gênero. | — |
| ODS 6 — Água Potável e Saneamento | Não se aplica | Sem relação com gestão de recursos hídricos. | — |
| ODS 7 — Energia Limpa e Acessível | Não se aplica | Fora do escopo do projeto (não trata matriz energética). | — |
| ODS 8 — Trabalho Decente e Crescimento Econômico | Não se aplica | O projeto não gera diretamente postos de trabalho ou crescimento econômico mensurável fora da operação interna da Globo. | — |
| ODS 9 — Indústria, Inovação e Infraestrutura | **Direta** | Constrói infraestrutura tecnológica proprietária de ingestão/normalização de telemetria multiplataforma (protocolos modernos e legados via API unificada), em um mercado hoje dominado por soluções de monitoração multinacionais — representa inovação em infraestrutura tecnológica nacional. | Nº de protocolos/dispositivos legados suportados; taxa de ingestão sem perdas (pipeline de alta escala); redução do MTTR de incidentes (base ServiceNow/`incidents.db`) |
| ODS 10 — Redução das Desigualdades | Não se aplica | Apesar de o problema de negócio nascer da desigualdade regional de renda, infraestrutura de rede e parque de dispositivos no Brasil (país continental, ~220 milhões de habitantes, 27 UFs), o projeto em si é uma ferramenta interna de observabilidade B2B e não altera diretamente o acesso da população a bens/serviços — impacto tratado como indireto/tangencial e não contabilizado como contribuição direta a este ODS. | — |
| ODS 11 — Cidades e Comunidades Sustentáveis | Não se aplica | Sem relação com planejamento urbano. | — |
| ODS 12 — Consumo e Produção Responsáveis | Não se aplica | Fora do escopo (não trata economia circular ou padrões de consumo). | — |
| ODS 13 — Ação Contra a Mudança Global do Clima | Não se aplica | Sem relação com ação climática. | — |
| ODS 14 — Vida na Água | Não se aplica | Sem relação com ecossistemas aquáticos. | — |
| ODS 15 — Vida Terrestre | Não se aplica | Sem relação com ecossistemas terrestres. | — |
| ODS 16 — Paz, Justiça e Instituições Eficazes | Não se aplica | Sem relação com instituições públicas, justiça ou transparência institucional. | — |
| ODS 17 — Parcerias e Meios de Implementação | Indireta | Nasce de uma parceria estratégica Inteli × Grupo Globo (projeto parceiro CCMD7) e tem potencial de evoluir para integração com outros sistemas internos e, no futuro, com parceiros tecnológicos, ampliando o alcance da solução de monitoração proprietária. | Nº de sistemas internos integrados à camada unificada (`signal_point`) após o MVP |

---

### 5.2. ODS prioritários (aprofundamento)

ODS selecionados por terem relação mais direta/concreta com o projeto, conforme o termo de parceria.

#### ODS 9 — Indústria, Inovação e Infraestrutura
- **Como o projeto contribui:** Desenvolve um sistema distribuído proprietário de backend para coleta de telemetria capaz de receber, normalizar e processar dados de frontends independentemente da plataforma, suportando protocolos modernos e legados por meio de APIs unificadas — algo que soluções de mercado (pensadas para protocolos homogêneos e modernos) não atendem para a realidade de dispositivos do Globoplay.
- **Público impactado:** Times internos de engenharia, observabilidade e produto do Grupo Globo, que passam a ter visibilidade operacional do frontend hoje inexistente para parte relevante do parque de dispositivos.
- **Evidência/justificativa:** Termo de parceria classifica o projeto como inovação para indústria e infraestrutura, construída em um mercado "totalmente dominado por sistemas de monitoração multinacionais". As fontes de dados já disponíveis (NewRelic, Prometheus, Apollo GraphQL, RPaaS, Tsuru, Cloud Armor, Youbora/NPAW) demonstram a complexidade de infraestrutura que a camada unificada (`signal_point`, ~35,8M linhas) precisa correlacionar.
- **Possíveis riscos de impacto negativo:** Concentração de conhecimento crítico de observabilidade em uma solução proprietária pode gerar dependência interna (vendor lock-in reverso) caso a manutenção não seja sustentada após o MVP.

#### ODS 17 — Parcerias e Meios de Implementação
- **Como o projeto contribui:** O projeto é fruto direto de uma parceria estratégica entre o Inteli e o Grupo Globo (termo CCMD7), com potencial de evoluir para integração com outros sistemas internos e futuros parceiros tecnológicos.
- **Público impactado:** Grupo Globo (como parceiro contratante) e a comunidade acadêmica do Inteli (equipe do projeto, professor orientador).
- **Evidência/justificativa:** Observação explícita no termo de parceria: "Representa uma iniciativa de inovação em infraestrutura tecnológica nacional (...) que pode evoluir para integração com outros sistemas internos e potencialmente com parceiros tecnológicos no futuro."
- **Possíveis riscos de impacto negativo:** Restrição contratual de não compartilhar dados e desafios com terceiros limita a disseminação aberta do conhecimento gerado, reduzindo o potencial de impacto de parceria fora do próprio Grupo Globo.

#### ODS 4 — Educação de Qualidade
- **Como o projeto contribui:** Promove o desenvolvimento de competências da equipe em arquitetura de sistemas distribuídos, integração via APIs, tratamento de heterogeneidade tecnológica (protocolos modernos e legados) e boas práticas de engenharia de software, em um projeto real com dados e escala de produção.
- **Público impactado:** Estudantes/equipe do grupo (G05) responsáveis pelo desenvolvimento do MVP.
- **Evidência/justificativa:** Observações do termo de parceria indicam que o projeto "promove competências para práticas de projetos de software" e "contribui para o desenvolvimento técnico das equipes envolvidas".
- **Possíveis riscos de impacto negativo:** Nenhum identificado — a capacitação é um subproduto do desenvolvimento do MVP, sem trade-off aparente.

---

### 5.3. Síntese

O projeto tem seu impacto na Agenda 2030 concentrado nas dimensões de **Parcerias** e **Pessoas**: a contribuição mais direta está no **ODS 9** (inovação em infraestrutura de monitoração proprietária, hoje dominada por players multinacionais) e no **ODS 17** (parceria estratégica Inteli-Globo com potencial de expansão futura), enquanto o **ODS 4** aparece como contribuição indireta ligada à capacitação técnica da equipe. Nas dimensões Planeta, Prosperidade e Paz o projeto não se aplica, por se tratar de uma solução B2B de observabilidade interna, sem intervenção direta sobre questões ambientais, econômicas macro ou institucionais. Vale notar um trade-off relevante: embora o problema de negócio seja motivado por desigualdade real de acesso (renda, infraestrutura de rede e geografia no território brasileiro), a solução em si não altera essa desigualdade — apenas melhora a visibilidade operacional sobre ela — por isso o **ODS 10** foi classificado como não aplicável em vez de indireto, evitando sobre-estimar o alcance social do projeto.

---

## Referências

GRUPO GLOBO. Entrevistas e levantamento de requisitos com as equipes de Engenharia, SRE e Produto do Globoplay. [S.l.], 2026. Levantamento interno realizado com o parceiro no âmbito do projeto CCMD7.

GRUPO GLOBO; INTELI. **Anexo - Fontes de Dados**: Monitoração Agêntica, Grupo Globo × Inteli (CCMD7). [S.l.], jun. 2026. Anexo técnico ao termo de parceria CCMD7.

GRUPO GLOBO; INTELI. **Argus - Documentação do Dataset**: correlator de incidentes, Globoplay. Versão 1.3. [S.l.]: parceria acadêmica Globo × Inteli, 2026. Documento interno de distribuição restrita.

INTELI. **Termo de Abertura de Projeto Interdisciplinar (TAPI)**: Turma 15, Ciência da Computação, Módulo 7 - Projeto Parceiro Globo, CCMD7. São Paulo: Inteli, 2026.

INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. **ISO 31000:2018**: risk management - guidelines. Geneva: ISO, 2018.

KIM, W. Chan; MAUBORGNE, Renée. **Blue Ocean Strategy**: How to Create Uncontested Market Space and Make the Competition Irrelevant. Boston: Harvard Business School Press, 2005.

OSTERWALDER, Alexander et al. **Value Proposition Design**: How to Create Products and Services Customers Want. Hoboken: John Wiley & Sons, 2014.

PROJECT MANAGEMENT INSTITUTE. **A Guide to the Project Management Body of Knowledge (PMBOK Guide)**. 7. ed. Newtown Square: PMI, 2021.
