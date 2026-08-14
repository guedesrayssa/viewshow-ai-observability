# Análise de Impacto nos ODS (Objetivos de Desenvolvimento Sustentável)

> Avaliação de como o projeto se relaciona com os 17 Objetivos de Desenvolvimento Sustentável da ONU, identificando impactos diretos, indiretos e oportunidades de contribuição.

> **Contexto do projeto:** o projeto é uma plataforma distribuída, desenvolvida para o Grupo Globo (Globoplay), para coleta, normalização e correlação de telemetria (QoS técnico + QoE percebida) de aplicações frontend rodando em dispositivos extremamente heterogêneos (TVs antigas, celulares de baixo custo, redes instáveis) em todo o território nacional — incluindo suporte a protocolos legados não atendidos por ferramentas de monitoração de mercado. As classificações abaixo seguem o checklist de impacto ODS já validado no termo de parceria com o Inteli (`TAPI - Turma 15 - Ciência da Computação - Módulo 7.pdf`), detalhado com base no escopo técnico do projeto e nas fontes de dados apresentadas pelo parceiro.

## 1. Mapeamento geral

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

## 2. ODS prioritários (aprofundamento)

> ODS selecionados por terem relação mais direta/concreta com o projeto, conforme o termo de parceria.

### ODS 9 — Indústria, Inovação e Infraestrutura
- **Como o projeto contribui:** Desenvolve um sistema distribuído proprietário de backend para coleta de telemetria capaz de receber, normalizar e processar dados de frontends independentemente da plataforma, suportando protocolos modernos e legados por meio de APIs unificadas — algo que soluções de mercado (pensadas para protocolos homogêneos e modernos) não atendem para a realidade de dispositivos do Globoplay.
- **Público impactado:** Times internos de engenharia, observabilidade e produto do Grupo Globo, que passam a ter visibilidade operacional do frontend hoje inexistente para parte relevante do parque de dispositivos.
- **Evidência/justificativa:** Termo de parceria classifica o projeto como inovação para indústria e infraestrutura, construída em um mercado "totalmente dominado por sistemas de monitoração multinacionais". As fontes de dados já disponíveis (NewRelic, Prometheus, Apollo GraphQL, RPaaS, Tsuru, Cloud Armor, Youbora/NPAW) demonstram a complexidade de infraestrutura que a camada unificada (`signal_point`, ~35,8M linhas) precisa correlacionar.
- **Possíveis riscos de impacto negativo:** Concentração de conhecimento crítico de observabilidade em uma solução proprietária pode gerar dependência interna (vendor lock-in reverso) caso a manutenção não seja sustentada após o MVP.

### ODS 17 — Parcerias e Meios de Implementação
- **Como o projeto contribui:** O projeto é fruto direto de uma parceria estratégica entre o Inteli e o Grupo Globo (termo CCMD7), com potencial de evoluir para integração com outros sistemas internos e futuros parceiros tecnológicos.
- **Público impactado:** Grupo Globo (como parceiro contratante) e a comunidade acadêmica do Inteli (equipe do projeto, professor orientador).
- **Evidência/justificativa:** Observação explícita no termo de parceria: "Representa uma iniciativa de inovação em infraestrutura tecnológica nacional (...) que pode evoluir para integração com outros sistemas internos e potencialmente com parceiros tecnológicos no futuro."
- **Possíveis riscos de impacto negativo:** Restrição contratual de não compartilhar dados e desafios com terceiros limita a disseminação aberta do conhecimento gerado, reduzindo o potencial de impacto de parceria fora do próprio Grupo Globo.

### ODS 4 — Educação de Qualidade
- **Como o projeto contribui:** Promove o desenvolvimento de competências da equipe em arquitetura de sistemas distribuídos, integração via APIs, tratamento de heterogeneidade tecnológica (protocolos modernos e legados) e boas práticas de engenharia de software, em um projeto real com dados e escala de produção.
- **Público impactado:** Estudantes/equipe do grupo (G05) responsáveis pelo desenvolvimento do MVP.
- **Evidência/justificativa:** Observações do termo de parceria indicam que o projeto "promove competências para práticas de projetos de software" e "contribui para o desenvolvimento técnico das equipes envolvidas".
- **Possíveis riscos de impacto negativo:** Nenhum identificado — a capacitação é um subproduto do desenvolvimento do MVP, sem trade-off aparente.

---

## 3. Síntese

O projeto tem seu impacto na Agenda 2030 concentrado nas dimensões de **Parcerias** e **Pessoas**: a contribuição mais direta está no **ODS 9** (inovação em infraestrutura de monitoração proprietária, hoje dominada por players multinacionais) e no **ODS 17** (parceria estratégica Inteli-Globo com potencial de expansão futura), enquanto o **ODS 4** aparece como contribuição indireta ligada à capacitação técnica da equipe. Nas dimensões Planeta, Prosperidade e Paz o projeto não se aplica, por se tratar de uma solução B2B de observabilidade interna, sem intervenção direta sobre questões ambientais, econômicas macro ou institucionais. Vale notar um trade-off relevante: embora o problema de negócio seja motivado por desigualdade real de acesso (renda, infraestrutura de rede e geografia no território brasileiro), a solução em si não altera essa desigualdade — apenas melhora a visibilidade operacional sobre ela — por isso o **ODS 10** foi classificado como não aplicável em vez de indireto, evitando sobre-estimar o alcance social do projeto.
