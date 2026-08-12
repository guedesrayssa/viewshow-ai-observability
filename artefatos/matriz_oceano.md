# Matriz de Avaliação de Valor – Estratégia do Oceano Azul

&nbsp;&nbsp;&nbsp;&nbsp;A Matriz de Avaliação de Valor do Oceano Azul é uma ferramenta estratégica que permite comparar, de forma estruturada, a proposta de valor de um projeto em relação às soluções existentes no mercado. A partir da identificação de atributos relevantes para o cliente, a matriz orienta decisões sobre quais fatores devem ser **Reduzidos**, **Eliminados**, **Aumentados** ou **Criados** (framework ERRC), com o objetivo de simultaneamente reduzir custos e elevar o valor percebido pelo cliente.  

&nbsp;&nbsp;&nbsp;&nbsp;No contexto deste projeto, a matriz foi construída considerando a realidade operacional do Globoplay e o cenário competitivo de ferramentas de monitoramento/telemetria de frontend disponíveis no mercado (por exemplo, soluções de RUM/APM voltadas a aplicações web e mobile). A análise toma como referência um conjunto de oito atributos considerados críticos para os times de engenharia, SRE e produto, permitindo visualizar como a plataforma proprietária proposta se diferencia das alternativas tradicionais.

---

## Atributos considerados

&nbsp;&nbsp;&nbsp;&nbsp;Foram definidos oito atributos de valor que sintetizam as principais preocupações e expectativas do cliente em relação a uma plataforma de telemetria para frontends multiplataforma:

1. **Custo total de telemetria** – gastos anuais com coleta, processamento e visualização de dados, incluindo licenças de ferramentas externas.
2. **Cobertura de dispositivos legados** – capacidade de coletar telemetria de TVs e dispositivos antigos, com protocolos ou limitações não atendidos por soluções modernas.
3. **Granularidade de segmentação** – nível de detalhe disponível para análise por device family, modelo, versão de app, OS, região, CDN, tipo de playback, entre outros.
4. **Tempo médio de diagnóstico (MTTD/MTTR)** – rapidez para identificar e resolver a causa raiz de incidentes.
5. **Customização de schema e eventos** – flexibilidade para definir modelos de dados e eventos alinhados às necessidades específicas de streaming.
6. **Integração com ecossistema interno** – facilidade de integração com data lakes, sistemas de alerta, ferramentas de ticket e dashboards já utilizados pelo Globoplay.
7. **Qualidade de métricas de QoE** – adequação e precisão das métricas de qualidade de experiência do usuário (TTFF, falha de playback, rebuffer, etc.).
8. **Dependência de fornecedor externo** – grau de exposição estratégica a ferramentas de terceiros para capacidade crítica de observabilidade.

&nbsp;&nbsp;&nbsp;&nbsp;Com base nesses atributos, a estratégia do projeto foi desenhada utilizando as quatro ações do Oceano Azul: Reduzir, Eliminar, Aumentar e Criar. A seguir, detalhamos cada quadrante, com exemplos de pontuação comparativa e justificativas.

---