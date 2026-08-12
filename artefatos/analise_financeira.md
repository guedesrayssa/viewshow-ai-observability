# Análise Financeira

> Estimativas construídas a partir das demandas levantadas junto ao parceiro para o horizonte de 1 ano (investimentos, custos e receitas). Todos os valores devem ser tratados como estimativas e revisados conforme o projeto evolui.

**Grupo:** G05
**Parceiro:** Grupo Globo (Globoplay) — Projeto (CCMD7)
**Versão:** 11/08/2026 · v1.0

---

## 1. Premissas e contexto

| Premissa | Descrição |
|---|---|
| Escopo considerado | MVP definido no termo de parceria: API única de ingestão de eventos, suporte a protocolos legados (dispositivos antigos), pipeline de ingestão/armazenamento em alta escala sem perdas, normalização mínima, consultas para análise de falhas críticas e dashboard com filtros cumulativos. Cobre a transição do MVP acadêmico para uma operação assistida no Ano 1. |
| Horizonte temporal | 12 meses (set/2026 a ago/2027, a partir da entrega do MVP ao final do módulo) |
| Demandas do parceiro consideradas | Ingestão multiplataforma (7 plataformas — iOS, Android, Android TV, Fire TV, tvOS, Web, Smart TVs), suporte a protocolos modernos e legados, absorção de picos de até 4,1 milhões de sessões simultâneas em eventos ao vivo, normalização de 13+ fontes de dados na camada unificada (`signal_point`), e restrição contratual de não compartilhar dados/desafios com terceiros — o que exige operação em infraestrutura própria, sem terceirizar o dado sensível a SaaS externos. |
| Moeda | BRL (R$) |
| Metodologia de estimativa | O termo de parceria e o anexo de fontes de dados fornecidos pelo parceiro não disponibilizam orçamento real da Globo. Os valores abaixo foram estimados por **benchmarking de mercado** (custo de infraestrutura cloud equivalente ao volume de dados descrito no anexo — ex.: ~68 milhões de pontos no Prometheus, ~35,8 milhões de linhas na tabela unificada `signal_point`, 13+ fontes distintas) e por **valor/hora médio de squads** de engenharia de backend/dados no mercado brasileiro. Devem ser validados com os pontos focais do parceiro (Igor Thurow — líder técnico; Carlos Papani — líder do projeto) antes de qualquer decisão de investimento real. |

---

## 2. Investimentos iniciais (CAPEX)

| Item | Descrição | Valor estimado (R$) | Justificativa |
|---|---|---|---|
| Infraestrutura cloud inicial | Provisionamento de cluster (GKE), feature store/BigQuery, Cloud Armor e ambientes de staging | 40.000 | Réplica, em ambiente próprio, das bases já usadas pelo correlator (NewRelic, Prometheus, Apollo, RPaaS-fe, Tsuru, Cloud Armor, Youbora) listadas no anexo de fontes de dados |
| Ferramentas e licenças de desenvolvimento | Observabilidade do próprio backend, CI/CD, ferramentas de teste de carga | 12.000 | Necessário para validar o requisito de ingestão "sem perdas" sob alta escala exigido no MVP |
| Ambiente de testes multiplataforma | Dispositivos/emuladores para os 7 sistemas suportados (incluindo legados) | 18.000 | Exigido para validar suporte a protocolos legados e normalização mínima em dispositivos mais antigos, conforme escopo macro do termo |
| Discovery e levantamento de requisitos | Entrevistas com stakeholders da Globo, mapeamento das 13+ fontes de dados, protótipos de dashboard | 15.000 | Horas da equipe (Inteli + pontos focais Globo: Carlos Papani, Thiago Frensch, Igor Thurow) já investidas na fase de elicitação do projeto |
| **Total CAPEX** | | **85.000** | |

---

## 3. Custos operacionais (OPEX) — Ano 1

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

## 4. Valor gerado / economia de custos — Ano 1

> **Adaptação de escopo:** este é um projeto de ferramenta interna entregue a um parceiro corporativo, não um produto comercializado com receita direta. Por isso, a seção "Receitas" do modelo padrão foi substituída por **valor gerado / economia de custos** para a Globo, coerente com a proposta do termo de parceria (redução de custo com ferramentas externas de monitoração e redução do tempo de diagnóstico de incidentes).

| Fonte de valor | Modelo | Premissa de volume/impacto | Valor estimado Ano 1 (R$) | Justificativa |
|---|---|---|---|---|
| Redução de custo com ferramentas de observabilidade externas | Substituição parcial de contratos de terceiros | Parte do gasto hoje distribuído entre múltiplas ferramentas por componente (13+ fontes monitoradas separadamente, conforme anexo de fontes de dados) passa a ser coberta pela camada unificada própria | 400.000 | Benchmarking de mercado para contratos enterprise de observabilidade (ex.: New Relic, Datadog) em plataformas do porte do Globoplay; premissa conservadora de substituição parcial (não total) no primeiro ano |
| Redução do custo de diagnóstico manual (MTTR) | Ganho de eficiência operacional | Hoje a correlação de causa raiz exige "reunião de especialistas" por componente (player, CDN, backend, identidade, catálogo), conforme material do parceiro; a correlação automatizada reduz horas de especialista por incidente | 300.000 | Estimativa de horas de especialista evitadas por incidente × custo-hora médio de squads sênior × volume mensal de incidentes reportado como relevante pelo parceiro |
| Redução de perdas por degradação em eventos de alta audiência | Cost avoidance | Menor tempo até a causa provável reduz a janela de degradação em picos de audiência (até 4,1 milhões de sessões simultâneas em eventos ao vivo) | 200.000 | Estimativa conservadora de impacto evitado em SLA/experiência do usuário durante eventos críticos, sem dado de penalidade contratual real disponibilizado pelo parceiro |
| **Total de valor gerado** | | | **900.000** | |

---

## 5. Projeção financeira consolidada — Ano 1 (trimestral)

> Assume-se adoção gradual do valor gerado (rollout dos times internos usando a plataforma) e CAPEX concentrado no Q1.

| | Q1 | Q2 | Q3 | Q4 | Total Ano 1 |
|---|---|---|---|---|---|
| Valor gerado / economia | 90.000 | 180.000 | 270.000 | 360.000 | 900.000 |
| Custos (OPEX) | 186.450 | 186.450 | 186.450 | 186.450 | 745.800 |
| Investimentos (CAPEX) | 85.000 | 0 | 0 | 0 | 85.000 |
| Resultado do período | -181.450 | -6.450 | 83.550 | 173.550 | 69.200 |
| Fluxo de caixa acumulado | -181.450 | -187.900 | -104.350 | 69.200 | 69.200 (final) |

---

## 6. Ponto de equilíbrio (break-even)

Considerando a curva de adoção premissada (10% / 20% / 30% / 40% do valor gerado ao longo dos trimestres), o fluxo de caixa acumulado torna-se positivo dentro do **Q4**, por volta do **11º mês**, quando a economia acumulada supera CAPEX + OPEX acumulados. Essa estimativa depende fortemente de dois fatores não confirmados com o parceiro: (i) a velocidade real de adoção da plataforma pelos times de engenharia/observabilidade/produto da Globo, e (ii) o percentual efetivo de substituição de ferramentas externas de monitoração — nenhum dos dois consta no anexo de fontes de dados ou no termo de parceria.

---

## 7. Riscos financeiros e sensibilidade

- **Adoção mais lenta que a premissada**: se os times internos da Globo levarem mais tempo para migrar da monitoração por silo para a camada unificada, o break-even se desloca para além do Ano 1.
- **Ausência de dados reais de custo**: as estimativas de economia dependem de valores de contrato com ferramentas externas (New Relic, Datadog etc.) que não foram disponibilizados — o anexo de fontes de dados lista as fontes técnicas, não seus custos de licenciamento.
- **Volume de dados acima do estimado**: picos de audiência maiores que os 4,1 milhões de sessões simultâneas observados, ou o avanço do requisito de novas fontes/protocolos, podem elevar o OPEX de infraestrutura além do projetado.
- **Restrição de não compartilhar dados com terceiros**: impede o uso de serviços gerenciados de terceiros para reduzir custo de infraestrutura, mantendo a dependência de operação própria (Pessoal + Infraestrutura concentram ~77% do OPEX).
- **Escalonamento de suporte a dispositivos legados**: cada novo protocolo/dispositivo legado suportado tende a aumentar o custo de manutenção acima do premissado.
- Relacionar com a Matriz de Risco do artefato de entendimento de negócio quando esse artefato estiver disponível no repositório (ainda não versionado nesta branch).
