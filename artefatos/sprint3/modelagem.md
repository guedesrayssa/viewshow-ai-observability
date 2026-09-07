# Modelagem do Sistema — View Show

> Este documento apresenta a modelagem estrutural e comportamental do View Show por meio de diagramas UML e descrições textuais. A modelagem foi construída com base nos requisitos funcionais, não funcionais e decisões arquiteturais do projeto.

## Sumário

1. [Introdução](#1-introdução)
2. [Diagrama de casos de uso](#2-diagrama-de-casos-de-uso)
3. [Descrições dos casos de uso](#3-descrições-dos-casos-de-uso)
4. [Diagrama de classes](#4-diagrama-de-classes)
5. [Diagramas de sequência](#5-diagramas-de-sequência)
6. [Rastreabilidade da modelagem](#6-rastreabilidade-da-modelagem)
7. [Validação e consistência](#7-validação-e-consistência)
8. [Referências](#8-referências)

---

## 1. Introdução

### 1.1 Objetivo

Este artefato tem como objetivo modelar o sistema View Show com base nos requisitos e funcionalidades definidos nas etapas anteriores do projeto.

A modelagem utiliza diagramas UML e descrições textuais para representar:

- as interações entre os atores e o sistema;
- os fluxos principais, alternativos e de exceção;
- a estrutura lógica das classes;
- as interações temporais entre componentes;
- a rastreabilidade entre requisitos e elementos da modelagem.

### 1.2 Escopo da modelagem

A modelagem de casos de uso contempla a aplicação web interna do View Show, utilizada por equipes do Globoplay para consultar telemetria, analisar incidentes, investigar falhas técnicas e acompanhar a qualidade da experiência (QoE). O recorte corresponde às telas de Login, Visão Geral, Incidentes, Evidências, Eventos e Monitoramento previstas para o MVP e para a Sprint 3.

Não fazem parte da modelagem de casos de uso:

- a emissão de telemetria pelos frontends do Globoplay;
- os processos internos de ingestão, enfileiramento, normalização e armazenamento;
- a execução de correções, deploys ou rollbacks em produção.

Esses elementos viabilizam o produto, mas não constituem objetivos iniciados diretamente pelos atores na interface. A observação da integridade dos dados de telemetria, por sua vez, integra o escopo funcional porque subsidia a avaliação da confiabilidade das análises apresentadas pelo View Show.

### 1.3 Documentos de referência

| Documento | Utilização neste artefato |
| --- | --- |
| [Especificação de requisitos](../sprint1/requisitos.md) | Identificação dos requisitos e casos de uso |
| [Entendimento da experiência do usuário](../sprint1/entendimento_ux.md) | Identificação das personas, jornadas e objetivos observáveis no frontend |
| [Arquitetura inicial](../sprint2/arquitetura-inicial.md) | Identificação de componentes e integrações |
| [Documentação de frontend](../sprint2/frontend.md) | Validação dos fluxos de interface |
| [Documentação de backend](../sprint2/backend-sprint-2.md) | Validação de serviços, entidades e operações |

### 1.4 Convenções adotadas

- Casos de uso são identificados como `UC-XX`.
- Requisitos funcionais são identificados como `RFXX`.
- Requisitos não funcionais são identificados como `RNFXX`.
- Classes, métodos e atributos utilizam os nomes empregados no sistema.
- Cada diagrama deve possuir título, fonte e uma descrição que explique como interpretá-lo.
- Sempre que possível, a fonte editável do diagrama e sua versão em SVG devem ser versionadas no repositório.

---

## 2. Diagrama de casos de uso

&emsp;Os casos de uso descrevem o comportamento do sistema a partir dos objetivos dos atores que interagem com ele. Nessa perspectiva, o sistema é tratado como uma caixa-preta: registra-se o resultado que deve ser oferecido ao usuário, sem antecipar a divisão interna entre interfaces, serviços ou mecanismos de persistência. A modelagem desta seção adota a abordagem de Larman (2007), que recomenda priorizar casos de uso no nível de objetivo do usuário e complementar o diagrama com narrativas capazes de explicitar o contrato comportamental do sistema.

&emsp;No View Show, ações como aplicar filtros, consultar evidências e comparar períodos integram objetivos mais amplos de análise. O diagrama apresenta os atores, a fronteira do sistema e os objetivos que produzem resultados relevantes para esses atores, enquanto a Seção 3 detalha as interações necessárias para alcançá-los.

### 2.1 Atores

&emsp;Um ator representa um papel exercido na interação com o sistema, e não uma pessoa específica. O papel **Usuário corporativo** foi definido como abstrato para concentrar as capacidades comuns de acesso e consulta. Analista de Atendimento Técnico N1, Engenheira de Software e Product Manager especializam esse papel e acrescentam objetivos próprios de suas responsabilidades. O provedor de identidade é mantido como ator secundário porque participa da troca de informações necessária à autenticação, embora esteja fora da fronteira do View Show.

<div align="center">

<strong>Tabela x: Atores do diagrama de casos de uso</strong>

</div>

| ID | Ator | Tipo | Responsabilidade principal |
| --- | --- | --- | --- |
| AT-01 | Usuário corporativo | Primário, abstrato | Acessar o View Show e consultar informações comuns aos perfis autorizados. |
| AT-02 | Analista de Atendimento Técnico N1 | Especialização de AT-01 | Priorizar incidentes e revisar as hipóteses apresentadas pelo sistema. |
| AT-03 | Engenheira de Software | Especialização de AT-01 | Validar hipóteses, investigar falhas, avaliar recuperações e monitorar a telemetria. |
| AT-04 | Product Manager | Especialização de AT-01 | Analisar QoE, priorizar problemas e avaliar resultados posteriores a correções. |
| AT-05 | Provedor de identidade/SSO | Secundário | Autenticar a conta corporativa e devolver a identidade validada. |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

### 2.2 Catálogo de casos de uso

&emsp;O catálogo apresenta sete objetivos observáveis dos usuários do View Show. Cada caso de uso reúne as interações que conduzem a um resultado relevante para o ator principal, desde o acesso ao sistema até a análise de incidentes, a investigação técnica, a avaliação da qualidade da experiência e o acompanhamento da telemetria.

<div align="center">

<strong>Tabela x: Catálogo dos casos de uso</strong>

</div>

| ID | Caso de uso | Ator principal | Requisitos relacionados |
| --- | --- | --- | --- |
| UC-01 | Consultar dashboard | Usuário corporativo | RF07, RF08, RF09, RF10, RNF07, RNF14 |
| UC-02 | Autenticar-se | Usuário corporativo | RF04, RNF04, RIE01, RESTR01 |
| UC-03 | Analisar incidente | Analista de Atendimento Técnico N1 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 |
| UC-04 | Investigar falha técnica | Engenheira de Software | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 |
| UC-05 | Avaliar recuperação após correção | Engenheira de Software e Product Manager | RF07, RF08, RF09, RNF05, RNF14 |
| UC-06 | Analisar qualidade da experiência | Product Manager | RF07, RF08, RF09, RNF05, RNF14, RNF15 |
| UC-07 | Monitorar a telemetria | Engenheira de Software | RF07, RF08, RNF01, RNF02, RNF03, RNF09, RNF15 |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A consulta ao dashboard abrange a aplicação de filtros e a exportação de resultados. A análise de incidentes compreende a priorização das ocorrências, a consulta das hipóteses e evidências e o registro da avaliação humana. A investigação técnica aprofunda a inspeção de eventos e as comparações entre recortes. Os demais casos tratam da avaliação posterior a correções, da análise agregada de QoE e da verificação da integridade das fontes e do processamento da telemetria.

### 2.3 Diagrama

&emsp;O Diagrama x sintetiza a fronteira funcional do View Show e as associações entre os atores e seus objetivos. Os pormenores de cada interação permanecem nas descrições textuais para que a representação visual conserve a função de oferecer uma visão geral do sistema.

<div align="center">

<strong>Diagrama x: Casos de uso do View Show</strong>

![Diagrama de casos de uso do View Show](../../assets/modelagem/casos-de-uso.svg)

Fonte: Material produzido pelos autores (2026).

</div>

### 2.4 Critérios de construção e leitura

&emsp;A fronteira **Sistema View Show** contém as funcionalidades percebidas pelos atores durante o uso da aplicação. A emissão, a ingestão, o enfileiramento, a normalização e o armazenamento da telemetria são processos internos ou externos à interação direta dos usuários e, por isso, não são representados como casos de uso.

&emsp;Operações como filtrar resultados, consultar evidências e comparar períodos são descritas nos fluxos dos casos de uso aos quais dão suporte. A avaliação de recuperação constitui um objetivo independente porque ocorre após uma intervenção externa e produz como resultado uma comparação entre janelas temporais equivalentes.

&emsp;A autenticação é representada como um caso de uso próprio devido à participação do provedor corporativo de identidade. Nos demais casos, a existência de uma sessão válida é estabelecida como pré-condição.

### 2.5 Relações principais

&emsp;A Tabela x apresenta as associações entre atores e casos de uso e as relações de generalização entre os perfis especializados e o Usuário corporativo. As associações identificam os objetivos iniciados por cada ator, enquanto as generalizações indicam o compartilhamento das capacidades comuns de acesso e consulta.

<div align="center">

<strong>Tabela x: Relações representadas no diagrama</strong>

</div>

| Origem | Relação | Destino | Justificativa |
| --- | --- | --- | --- |
| AT-02 | Generalização | AT-01 | O Analista N1 também executa os objetivos comuns de um usuário corporativo. |
| AT-03 | Generalização | AT-01 | A Engenheira de Software também executa os objetivos comuns. |
| AT-04 | Generalização | AT-01 | A Product Manager também executa os objetivos comuns. |
| AT-01 | Associação | UC-01 e UC-02 | Todo perfil autorizado pode autenticar-se e consultar o dashboard. |
| AT-02 | Associação | UC-03 | O Analista N1 prioriza o incidente, consulta as evidências e avalia a hipótese apresentada. |
| AT-03 | Associação | UC-04, UC-05 e UC-07 | A Engenheira investiga falhas, avalia a recuperação e monitora a telemetria. |
| AT-04 | Associação | UC-05 | A Product Manager avalia os indicadores posteriores a uma correção. |
| AT-04 | Associação | UC-06 | A Product Manager inicia a análise de QoE. |
| AT-05 | Associação | UC-02 | O provedor externo participa da autenticação corporativa. |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

---

## 3. Descrições dos casos de uso

&emsp;Larman (2007) descreve casos de uso por meio de narrativas estruturadas que caracterizam o objetivo, os participantes e o contrato comportamental estabelecido entre os atores e o sistema. Esse formato articula pré-condições, garantias de sucesso, fluxo principal, variações e requisitos especiais, permitindo especificar o comportamento observável sem antecipar decisões internas de implementação.

&emsp;Os casos de uso do View Show são apresentados segundo essa estrutura. Cada descrição delimita o resultado esperado, relaciona os requisitos que fundamentam o comportamento e registra, em **Problemas em aberto**, somente as decisões funcionais que ainda precisam ser definidas para o respectivo caso de uso.

### 3.1 UC-01 — Consultar dashboard

&emsp;Este caso de uso reúne a consulta compartilhada pelos três perfis corporativos. O objetivo é permitir que o usuário construa um recorte coerente dos dados e obtenha informações que possam ser aprofundadas nas análises de incidente, de investigação técnica ou de qualidade da experiência.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Usuário corporativo.
- **Atores secundários:** Nenhum.

#### Requisitos relacionados

- **RF07 — Dashboard de navegação em eventos:** disponibilização da navegação e da visualização gráfica da telemetria.
- **RF08 — Métricas e alertas operacionais:** apresentação de indicadores de QoE e ocorrências de falha.
- **RF09 — Consultas para análise de falhas críticas:** realização de consultas simples e filtradas sobre os eventos.
- **RF10 — Exportação de dados:** exportação do conjunto consultado nos formatos previstos.
- **RNF07 — Tempo de carregamento da interface:** carregamento dos componentes principais e filtros em até 30 segundos.
- **RNF14 — Latência de consultas filtradas:** resposta em até dois segundos no percentil 95 das solicitações.

#### Interessados e interesses

- **Usuário corporativo:** consultar rapidamente indicadores, incidentes e eventos relevantes ao seu trabalho.
- **Globo:** disponibilizar informações confiáveis, protegidas e sem exposição de dados pessoais.
- **Equipe de operação:** tornar dados parciais e indisponibilidades claramente identificáveis.

#### Pré-condições

- O usuário possui uma sessão autenticada.

#### Pós-condições

- **Em caso de sucesso:** os indicadores e incidentes do recorte selecionado são apresentados e o contexto dos filtros permanece disponível.
- **Garantia mínima:** uma falha de fonte é informada sem substituir os dados ausentes por valores fictícios.

#### Fluxo Básico

1. O usuário acessa o dashboard.
2. O sistema carrega os indicadores e incidentes do período padrão.
3. O usuário seleciona filtros como período, dispositivo, versão ou região.
4. O sistema atualiza os resultados e identifica o recorte aplicado.
5. O usuário seleciona uma ocorrência ou um conjunto de eventos.
6. O sistema apresenta os detalhes correspondentes e preserva o contexto da consulta.

#### Fluxos alternativos

- **2a. Fonte indisponível:** o sistema identifica os componentes sem dados e mantém disponíveis os componentes carregados corretamente.
- **4a. Nenhum resultado:** o sistema apresenta um estado vazio e permite alterar os filtros. O fluxo retorna ao passo 3.
- **4b. Exportação solicitada:** o usuário solicita a exportação e o sistema gera CSV, XLSX ou PDF com o período e os filtros utilizados.
- **4c. Exportação indisponível:** o sistema informa a falha e preserva a consulta atual.

#### Requisitos especiais

- Acesso restrito a usuários autorizados, conforme RNF04.
- Carregamento dos componentes principais conforme RNF07.
- Buscas filtradas com P95 de até dois segundos, conforme RNF14.
- Os resultados devem excluir informações pessoalmente identificáveis (PII).

#### Lista de variantes

- **3a. Recorte da consulta:** período, dispositivo, versão, região ou combinação desses filtros.
- **4a. Formato de exportação:** CSV, XLSX ou PDF.

#### Frequência de ocorrência

Várias vezes ao dia, com aumento durante incidentes e eventos ao vivo.

#### Problemas em aberto

- Quais informações devem compor obrigatoriamente cada formato de exportação?
- Quais telas devem preservar os filtros durante a navegação?

### 3.2 UC-02 — Autenticar-se

&emsp;Este caso de uso isola a criação da sessão corporativa utilizada pelos demais objetivos. A separação permite registrar a participação do provedor de identidade e explicitar as garantias mínimas aplicáveis quando a autenticação não é concluída.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Usuário corporativo.
- **Ator secundário:** Provedor de identidade/SSO.

#### Requisitos relacionados

- **RF04 — Autenticação corporativa:** criação e encerramento de sessões por meio do provedor de identidade corporativo.
- **RNF04 — Segurança e confidencialidade:** restrição do painel e das APIs a contas autorizadas do domínio corporativo.
- **RIE01 — Serviço corporativo de autenticação da Globo:** integração responsável por autenticar a identidade e fornecer os dados de autorização.
- **RESTR01 — Política de acesso corporativo da Globo:** delegação integral da autenticação ao serviço corporativo, sem armazenamento local de senhas.

#### Interessados e interesses

- **Usuário corporativo:** acessar a plataforma com segurança e baixa carga operacional.
- **Globo:** restringir o acesso a contas corporativas autorizadas.
- **Segurança da informação:** impedir sessões inválidas e proteger as credenciais.

#### Pré-condições

- O usuário possui uma conta autorizada.
- O provedor de identidade está configurado.

#### Pós-condições

- **Em caso de sucesso:** uma sessão autorizada é criada e o sistema disponibiliza o dashboard.
- **Garantia mínima:** nenhuma sessão é criada quando a identidade ou o domínio não são validados.

#### Fluxo Básico

1. O usuário acessa a página de entrada.
2. O usuário seleciona a autenticação corporativa.
3. O sistema encaminha a solicitação ao provedor de identidade.
4. O provedor autentica o usuário e devolve sua identidade.
5. O sistema valida o domínio e as permissões recebidas.
6. O sistema cria a sessão e apresenta o dashboard.

#### Fluxos alternativos

- **3a. Provedor indisponível:** o sistema informa a indisponibilidade sem exibir uma resposta técnica bruta.
- **4a. Credencial recusada:** o sistema informa que a autenticação não foi concluída e retorna ao passo 1.
- **5a. Domínio não autorizado:** o sistema nega o acesso e não cria uma sessão.

#### Requisitos especiais

- Acesso restrito ao domínio corporativo, conforme RNF04 e RESTR01.
- Chamadas sem autenticação ou sem autorização retornam 401 ou 403.
- Credenciais não são expostas nem armazenadas pela interface web.

#### Lista de variantes

- **3a. Protocolo de federação:** OpenID Connect (OIDC) ou SAML, conforme a configuração do provedor corporativo.
- **5a. Origem da autorização:** domínio corporativo e grupos ou perfis devolvidos pelo provedor.

#### Frequência de ocorrência

No início de cada sessão e após sua expiração.

#### Problemas em aberto

- Qual provedor corporativo e qual protocolo de federação serão utilizados no SSO?
- Quais grupos ou perfis corporativos determinarão as permissões de acesso ao View Show?

### 3.3 UC-03 — Analisar incidente

&emsp;Este caso de uso descreve a análise de um incidente pelo Atendimento N1. O sistema apresenta o impacto estimado, o recorte afetado, as hipóteses e as evidências disponíveis para que o analista avalie o diagnóstico e registre sua decisão.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Analista de Atendimento Técnico N1.
- **Atores secundários:** Nenhum.

#### Requisitos relacionados

- **RF07 — Dashboard de navegação em eventos:** apresentação dos incidentes e das evidências relacionadas.
- **RF08 — Métricas e alertas operacionais:** disponibilização do impacto, da severidade e dos indicadores associados à ocorrência.
- **RF09 — Consultas para análise de falhas críticas:** aplicação de filtros para delimitar o recorte afetado.
- **RNF08 — Confiabilidade do diagnóstico por ML:** F1-Score mínimo de 80% para a classificação da causa raiz.
- **RNF10 — Operacionalidade:** localização da causa provável em até cinco cliques a partir da tela inicial.
- **RNF13 — Janela de contexto do diagnóstico:** uso dos registros das cinco horas anteriores à falha.
- **RNF15 — Tempo de sinalização de degradações:** apresentação do alerta em até 30 segundos após o recebimento dos eventos necessários à detecção.

#### Interessados e interesses

- **Analista N1:** compreender o impacto do incidente e avaliar a hipótese apresentada pelo sistema.
- **Engenharia:** dispor de uma avaliação humana rastreável sobre a hipótese e suas evidências.
- **Globo:** reduzir o tempo de diagnóstico e incorporar a validação humana às análises de causa provável.

#### Pré-condições

- O analista está autenticado.
- Existe ao menos um incidente detectado.

#### Pós-condições

- **Em caso de sucesso:** a hipótese é registrada como confirmada, refutada ou inconclusiva; quando identificada, a causa informada pelo analista também é registrada com sua justificativa.
- **Garantia mínima:** o incidente e suas evidências permanecem inalterados quando o analista não conclui a revisão.

#### Fluxo Básico

1. O analista acessa a área de incidentes.
2. O sistema apresenta os incidentes por severidade e impacto.
3. O analista seleciona um incidente.
4. O sistema apresenta o recorte afetado e as hipóteses de causa provável.
5. O sistema apresenta confiança, justificativas e evidências de cada hipótese.
6. O analista aplica filtros para delimitar o problema.
7. O analista avalia a hipótese como confirmada, refutada ou inconclusiva.
8. Quando a hipótese é refutada e a causa é conhecida, o analista informa a causa identificada e apresenta uma justificativa.
9. O sistema registra a decisão, a justificativa, a autoria e o momento da revisão.

#### Fluxos alternativos

- **4a. Nenhuma hipótese disponível:** o sistema informa que a causa permanece inconclusiva e permite ao analista registrar uma causa conhecida. O fluxo segue para o passo 8.
- **5a. Evidências incompletas:** o sistema identifica as fontes ausentes ou atrasadas e segue para o passo 6.
- **6a. Nenhum resultado para o recorte:** o sistema mantém o incidente aberto e permite remover filtros. O fluxo retorna ao passo 6.
- **8a. Causa não identificada:** o analista mantém a revisão como refutada ou inconclusiva sem informar uma causa alternativa.
- **9a. Revisão cancelada:** o fluxo termina sem registrar uma nova decisão.

#### Requisitos especiais

- A causa provável deve ser localizável em até cinco cliques, conforme RNF10.
- As hipóteses exibidas devem ser produzidas por um modelo com F1-Score igual ou superior a 80%, conforme RNF08.
- O contexto fornecido ao modelo deve conter somente os registros das cinco horas anteriores à falha, conforme RNF13.
- A incerteza da hipótese deve ser apresentada explicitamente.
- O incidente não deve expor PII.
- Degradações devem ser sinalizadas conforme RNF15.
- A decisão deve registrar autoria, data, justificativa e estado da revisão.

#### Lista de variantes

- **2a. Ordenação dos incidentes:** severidade, impacto ou recência.
- **6a. Recorte do incidente:** período, dispositivo, versão, região ou conteúdo.
- **7a. Estado da revisão:** confirmada, refutada ou inconclusiva.
- **8a. Origem da causa registrada:** seleção de uma causa apresentada pelo sistema ou descrição informada pelo analista.

#### Frequência de ocorrência

Diária, podendo tornar-se contínua durante incidentes críticos.

#### Problemas em aberto

- Quais critérios mínimos devem orientar a confirmação ou a refutação de uma hipótese?
- Quais informações são obrigatórias quando o analista registra uma causa diferente da hipótese apresentada?

### 3.4 UC-04 — Investigar falha técnica

&emsp;Este caso de uso descreve a investigação técnica de uma falha por meio da análise da hipótese, dos eventos correlacionados, da linha do tempo e da comparação entre recortes equivalentes. O resultado esperado é uma conclusão fundamentada nas evidências disponíveis.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Engenheira de Software especialista no componente investigado.
- **Atores secundários:** Nenhum.

#### Requisitos relacionados

- **RF05 — Visualização de dados brutos e normalizados:** consulta ao evento original e à representação normalizada.
- **RF06 — Cobertura mínima de eventos:** disponibilidade dos eventos `request`, `vitals`, `screen_view`, `video_view`, `session` e `error`.
- **RF07 — Dashboard de navegação em eventos:** acesso gráfico aos eventos e ao contexto do incidente.
- **RF08 — Métricas e alertas operacionais:** consulta aos indicadores associados à falha.
- **RF09 — Consultas para análise de falhas críticas:** filtragem e comparação dos eventos investigados.
- **RNF05 — Retenção do histórico:** consulta a até um ano de dados, distribuídos entre armazenamento de acesso rápido e de baixo custo.
- **RNF08 — Confiabilidade do diagnóstico por ML:** F1-Score mínimo de 80% para a classificação da causa raiz.
- **RNF10 — Operacionalidade:** localização da causa provável em até cinco cliques a partir da tela inicial.
- **RNF13 — Janela de contexto do diagnóstico:** uso dos registros das cinco horas anteriores à falha.
- **RNF14 — Latência de consultas filtradas:** resposta em até dois segundos no percentil 95 das solicitações.

#### Interessados e interesses

- **Engenharia:** confirmar ou refutar uma hipótese com evidências rastreáveis.
- **Atendimento N1:** consultar a conclusão técnica associada ao incidente.
- **Globo:** reduzir o tempo de identificação da causa raiz.

#### Pré-condições

- A engenheira está autenticada.
- Existe um incidente selecionado para investigação.

#### Pós-condições

- **Em caso de sucesso:** a hipótese é registrada como confirmada, refutada ou inconclusiva, com autoria e justificativa.
- **Garantia mínima:** nenhuma alteração é executada em produção pelo View Show.

#### Fluxo Básico

1. A engenheira abre o diagnóstico do incidente.
2. O sistema apresenta a hipótese, a confiança e as evidências relacionadas.
3. A engenheira inspeciona os eventos brutos e normalizados.
4. O sistema apresenta a linha do tempo da sessão e destaca o momento da falha.
5. A engenheira compara versões, dispositivos ou períodos equivalentes.
6. A engenheira registra sua conclusão e justificativa.
7. O sistema armazena a decisão com autoria e data, sem executar alterações em produção.

#### Fluxos alternativos

- **3a. Evento bruto indisponível:** o sistema informa que a comparação com o evento normalizado não pode ser realizada.
- **4a. Marcação temporal inconfiável:** o sistema sinaliza a limitação e não afirma uma ordem precisa para os eventos.
- **5a. Evidências conflitantes:** a hipótese permanece inconclusiva e o fluxo segue para o passo 6.
- **6a. Hipótese já revisada:** o sistema apresenta a decisão vigente e impede que uma revisão concorrente a sobrescreva sem confirmação.
- **6b. Registro cancelado:** o fluxo termina sem alterar a hipótese.

#### Requisitos especiais

- Suporte aos eventos definidos no RF06.
- Visualização de dados brutos e normalizados, conforme RF05.
- As hipóteses exibidas devem ser produzidas por um modelo com F1-Score igual ou superior a 80%, conforme RNF08.
- O contexto fornecido ao modelo deve conter somente os registros das cinco horas anteriores à falha, conforme RNF13.
- Histórico de até um ano, conforme RNF05.
- A causa provável deve ser localizável em até cinco cliques a partir do dashboard, conforme RNF10.
- As buscas filtradas devem apresentar P95 de até dois segundos, conforme RNF14.
- Registro da autoria e do momento da conclusão.

#### Lista de variantes

- **3a. Evento inspecionado:** request, vitals, screen_view, video_view, session ou error.
- **5a. Dimensão de comparação:** versão, dispositivo, região ou período equivalente.

#### Frequência de ocorrência

Sempre que um incidente exigir investigação técnica especializada.

#### Problemas em aberto

- Qual tolerância temporal deve ser considerada ao ordenar eventos com timestamps divergentes?
- Qual política será adotada para resolver revisões concorrentes de uma mesma hipótese?

### 3.5 UC-05 — Avaliar recuperação após correção

&emsp;Este caso de uso descreve a avaliação dos indicadores após uma correção realizada fora do View Show. A comparação utiliza janelas temporais equivalentes para determinar se o comportamento observado apresenta melhora, estabilidade, piora ou resultado inconclusivo.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Atores principais:** Engenheira de Software ou Product Manager.
- **Atores secundários:** Nenhum.

#### Requisitos relacionados

- **RF07 — Dashboard de navegação em eventos:** apresentação dos indicadores anteriores e posteriores à correção.
- **RF08 — Métricas e alertas operacionais:** disponibilização das métricas utilizadas para avaliar a recuperação.
- **RF09 — Consultas para análise de falhas críticas:** seleção de períodos e segmentos equivalentes para comparação.
- **RNF05 — Retenção do histórico:** acesso a até um ano de dados para compor as janelas temporais.
- **RNF14 — Latência de consultas filtradas:** resposta em até dois segundos no percentil 95 para consultas em armazenamento de acesso rápido.

#### Interessados e interesses

- **Engenharia:** verificar, com indicadores rastreáveis, se o comportamento técnico foi restabelecido.
- **Product Manager:** compreender se a experiência do segmento afetado melhorou após a intervenção.
- **Globo:** registrar resultados sem atribuir causalidade além do que os dados sustentam.

#### Pré-condições

- O ator está autenticado.
- Existe um incidente ou problema analisado e uma correção externa concluída ou um marco temporal aproximado para a intervenção.

#### Pós-condições

- **Em caso de sucesso:** a comparação anterior e posterior à correção é classificada e registrada com seus períodos, indicadores e limitações.
- **Garantia mínima:** o sistema não afirma causalidade, não executa implantação ou reversão e identifica quando os dados não permitem concluir sobre a recuperação.

#### Fluxo Básico

1. O ator seleciona o incidente ou problema cuja recuperação deseja avaliar.
2. O sistema apresenta o segmento afetado e o marco temporal associado à correção.
3. O ator confirma ou ajusta o marco temporal e as janelas equivalentes de comparação.
4. O sistema recupera os indicadores anteriores e posteriores à correção.
5. O sistema compara, conforme a disponibilidade, taxa de erros, latências P95 e P99, tempo de inicialização do vídeo, buffering, sessões afetadas e ocorrências de ANR.
6. O sistema apresenta as variações absolutas e percentuais, o tamanho das amostras e a classificação do resultado como melhora, estabilidade, piora ou inconclusivo.
7. O ator registra uma conclusão e as limitações observadas.
8. O sistema armazena a avaliação com autoria e data.

#### Fluxos alternativos

- **2a. Marco temporal inexistente:** o ator informa uma estimativa para a correção e o sistema identifica a aproximação na avaliação.
- **4a. Dados em armazenamento de longo prazo:** o sistema informa que a recuperação da consulta pode demandar mais tempo.
- **4b. Amostra insuficiente:** o sistema classifica a avaliação como inconclusiva e identifica os indicadores afetados.
- **5a. Períodos não comparáveis:** o sistema informa a diferença encontrada e retorna ao passo 3.
- **7a. Avaliação cancelada:** o fluxo termina sem registrar uma nova conclusão.

#### Requisitos especiais

- O histórico deve observar a retenção de 30 dias em armazenamento de acesso rápido e 11 meses em armazenamento de baixo custo, conforme RNF05.
- As buscas filtradas devem apresentar P95 de até dois segundos quando os dados estiverem em armazenamento de acesso rápido, conforme RNF14.
- Cada janela deve conter ao menos 20 observações enquanto não houver um limiar específico definido para o indicador analisado.
- As janelas devem possuir a mesma duração e preservar dispositivo, versão, região, conteúdo e demais filtros que definem o segmento comparado.
- O resultado é classificado como melhora quando a distância em relação à linha de base diminui sem piora de indicador crítico; como piora quando essa distância aumenta ou um indicador crítico ultrapassa seu limiar; como estabilidade quando nenhuma variação relevante ocorre; e como inconclusivo quando as condições de amostra ou comparabilidade não são atendidas.
- Os dados devem permanecer anonimizados e não expor PII.
- A classificação deve explicitar amostra, período e limitações, sem tratar correlação temporal como prova de causalidade.
- O View Show não deve executar implantação, reversão ou qualquer alteração no ambiente de produção.

#### Lista de variantes

- **2a. Marco da correção:** data registrada, evento correlacionado ou estimativa informada pelo ator.
- **4a. Camada de armazenamento:** dados recentes em armazenamento de acesso rápido ou dados históricos recuperados do armazenamento de baixo custo.
- **5a. Conjunto de indicadores:** disponibilidade definida pelo tipo de incidente e pelo segmento afetado.

#### Frequência de ocorrência

Após correções externas relacionadas a incidentes ou degradações relevantes.

#### Problemas em aberto

- Qual deve ser a amostra mínima para cada indicador utilizado na avaliação?
- Quais dados identificam o marco da correção e sua associação com o incidente analisado?

### 3.6 UC-06 — Analisar qualidade da experiência

&emsp;Este caso de uso representa a análise agregada realizada pela área de produto. Seu objetivo é reconhecer problemas recorrentes, comparar segmentos afetados e acompanhar a evolução dos indicadores para apoiar a priorização das melhorias na experiência.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Product Manager.
- **Atores secundários:** Nenhum.

#### Requisitos relacionados

- **RF07 — Dashboard de navegação em eventos:** visualização gráfica dos indicadores e das degradações de QoE.
- **RF08 — Métricas e alertas operacionais:** apresentação das métricas de qualidade da experiência e dos alertas relacionados.
- **RF09 — Consultas para análise de falhas críticas:** filtragem por segmento, plataforma, dispositivo, versão, região ou conteúdo.
- **RNF05 — Retenção do histórico:** acesso a até um ano de dados para análise de tendências.
- **RNF14 — Latência de consultas filtradas:** resposta em até dois segundos no percentil 95 das solicitações.
- **RNF15 — Tempo de sinalização de degradações:** apresentação do alerta em até 30 segundos após o recebimento dos eventos necessários à detecção.

#### Interessados e interesses

- **Product Manager:** priorizar problemas pelo impacto técnico na experiência.
- **Engenharia:** receber recortes comparáveis e tecnicamente fundamentados.
- **Globo:** acompanhar tendências sem atribuir causalidade indevida.

#### Pré-condições

- A Product Manager está autenticada.
- Existem dados agregados para o período consultado.

#### Pós-condições

- **Em caso de sucesso:** os problemas recorrentes e os segmentos prioritários são apresentados com seus indicadores e sua evolução histórica.
- **Garantia mínima:** indicadores ausentes e amostras insuficientes são identificados sem inferência de valores ou causalidade.

#### Fluxo Básico

1. A Product Manager acessa os indicadores de QoE.
2. O sistema apresenta um ranking de problemas recorrentes por quantidade de sessões afetadas, severidade e recência.
3. A Product Manager seleciona um problema e o segmento que deseja analisar.
4. O sistema apresenta buffering, tempo de inicialização do vídeo, latência e erros para o recorte selecionado.
5. A Product Manager aplica filtros de plataforma, dispositivo, versão, região ou conteúdo.
6. O sistema compara os segmentos utilizando os mesmos indicadores e explicita o tamanho das amostras.
7. A Product Manager consulta o histórico de degradações e identifica a prioridade do problema.

#### Fluxos alternativos

- **2a. Indicador indisponível:** o sistema identifica a lacuna sem inferir valores.
- **2b. Nenhum problema recorrente:** o sistema apresenta os indicadores gerais do período sem produzir um ranking vazio.
- **5a. Nenhum resultado para o recorte:** o sistema preserva a seleção anterior e permite remover filtros. O fluxo retorna ao passo 5.
- **6a. Amostra insuficiente:** o segmento é marcado como inconclusivo.
- **7a. Histórico em armazenamento de longo prazo:** o sistema informa que a recuperação da consulta pode demandar mais tempo.

#### Requisitos especiais

- Cada indicador deve apresentar definição, unidade, período e tamanho da amostra.
- As buscas filtradas devem apresentar P95 de até dois segundos, conforme RNF14.
- As degradações devem ser sinalizadas em até 30 segundos após o recebimento dos eventos que permitam sua detecção, conforme RNF15.
- Os dados devem permanecer anonimizados.
- O histórico deve seguir a política definida no RNF05.

#### Lista de variantes

- **2a. Critério do ranking:** sessões afetadas, severidade ou recência.
- **4a. Indicador analisado:** buffering, inicialização, latência ou erro.
- **5a. Segmento:** plataforma, dispositivo, versão, região ou conteúdo.
- **7a. Período histórico:** dados em armazenamento de acesso rápido ou de longo prazo.

#### Frequência de ocorrência

Diária ou semanal, com maior frequência durante incidentes ou eventos relevantes.

#### Problemas em aberto

- Qual será a amostra mínima aceita em uma comparação?
- Como os critérios de sessões afetadas, severidade e recência serão ponderados no ranking?

### 3.7 UC-07 — Monitorar a telemetria

&emsp;Este caso de uso descreve o acompanhamento da integridade e da atualidade da telemetria utilizada pelo View Show. A engenheira observa as fontes e os indicadores de processamento para distinguir degradações da experiência de lacunas, atrasos ou falhas nos dados que sustentam as análises.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Engenheira de Software.
- **Atores secundários:** Nenhum.

#### Requisitos relacionados

- **RF07 — Dashboard de navegação em eventos:** apresentação visual dos dados e do estado das fontes de telemetria.
- **RF08 — Métricas e alertas operacionais:** disponibilização dos indicadores e alertas relacionados à operação.
- **RNF01 — Capacidade de processamento:** acompanhamento do consumo durante picos equivalentes a 50 milhões de eventos simultâneos.
- **RNF02 — Latência ponta a ponta:** limite de dois minutos entre a captura e a disponibilidade do evento para consulta.
- **RNF03 — Tolerância a falhas:** isolamento de mensagens inválidas sem interrupção do processamento.
- **RNF09 — Disponibilidade:** disponibilidade mínima de 99,9% para o dashboard e as APIs de consulta.
- **RNF15 — Tempo de sinalização de degradações:** apresentação do alerta em até 30 segundos após o recebimento dos eventos necessários à detecção.

#### Interessados e interesses

- **Engenharia:** identificar rapidamente fontes, filas ou componentes degradados que comprometam a confiabilidade das análises.
- **Equipe de operação:** distinguir falhas de telemetria de falhas reais na experiência dos usuários.
- **Globo:** manter disponibilidade, atualidade e capacidade de processamento durante picos de audiência.

#### Pré-condições

- A engenheira está autenticada.
- O pipeline de telemetria está configurado para publicar métricas operacionais.

#### Pós-condições

- **Em caso de sucesso:** a fonte ou o componente degradado é identificado e o contexto de monitoramento permanece disponível para uma ação externa.
- **Garantia mínima:** dados parciais, atrasados ou indisponíveis são identificados e não são apresentados como íntegros.

#### Fluxo Básico

1. A engenheira acessa a área de monitoramento.
2. O sistema apresenta a taxa de ingestão, a latência de processamento, o volume em fila, as mensagens isoladas e a cobertura por fonte e região.
3. A engenheira seleciona período, fonte, plataforma ou região.
4. O sistema atualiza os indicadores e destaca as degradações detectadas.
5. A engenheira seleciona uma fonte ou um componente degradado.
6. O sistema apresenta lacunas, atrasos, falhas de processamento e o instante da última atualização.
7. A engenheira identifica a ação operacional externa necessária e preserva o recorte para acompanhamento.

#### Fluxos alternativos

- **2a. Nenhuma degradação:** o sistema informa que os indicadores se encontram dentro dos limites monitorados.
- **2b. Métricas parciais:** o sistema identifica os componentes sem dados e apresenta somente as medições disponíveis.
- **4a. Fonte sem atualização:** o sistema sinaliza a defasagem e informa o instante do último evento recebido.
- **6a. Detalhes indisponíveis:** o sistema preserva o alerta e informa que a causa operacional não pôde ser determinada.

#### Requisitos especiais

- O monitoramento deve permitir verificar a escalabilidade do consumidor durante picos equivalentes a 50 milhões de eventos simultâneos, conforme RNF01.
- O tempo entre captura, normalização, inferência e disponibilidade para consulta não deve ultrapassar dois minutos, conforme RNF02.
- Mensagens inválidas devem ser isoladas sem interromper o processamento do lote, conforme RNF03.
- O dashboard e as APIs de consulta devem manter disponibilidade mínima de 99,9%, conforme RNF09.
- Uma degradação deve ser sinalizada em até 30 segundos após o recebimento dos eventos que permitam sua detecção, conforme RNF15.
- Métricas operacionais não devem expor PII.

#### Lista de variantes

- **2a. Fonte das métricas:** telemetria publicada pelo serviço, métricas da fila ou estado informado pelo componente monitorado.
- **3a. Recorte operacional:** período, fonte, plataforma ou região.
- **4a. Atualização da interface:** releitura automática periódica ou atualização manual solicitada pela engenheira.

#### Frequência de ocorrência

Várias consultas ao dia, com acompanhamento prolongado durante incidentes e eventos ao vivo.

#### Problemas em aberto

- Quais limites operacionais devem caracterizar atraso, cobertura parcial e indisponibilidade em cada fonte?
- Qual granularidade temporal deve ser apresentada no histórico das métricas operacionais?

### 3.8 Síntese das descrições

&emsp;As sete narrativas delimitam os objetivos dos atores e os resultados que o View Show deve oferecer. Os fluxos básicos descrevem os cenários de sucesso, enquanto os fluxos alternativos registram indisponibilidades, ausência de dados, amostras insuficientes e demais condições que modificam o percurso principal.

&emsp;A descrição em caixa-preta mantém o foco nas responsabilidades observáveis do sistema, conforme a abordagem de Larman (2007). Dessa forma, os casos de uso fornecem uma base comum para a análise dos requisitos, a definição das interações e a verificação posterior do comportamento esperado.

---

## 4. Diagrama de classes

### 4.1 Objetivo e escopo

[EXPLICAR qual visão estrutural será representada: domínio, aplicação,
persistência ou combinação controlada dessas visões.]

### 4.2 Diagrama

<!--
Inserir o diagrama de classes exportado em SVG ou PNG.

Exemplo:
![Diagrama de classes do View Show](../../assets/modelagem/classes.svg)
-->

[INSERIR DIAGRAMA DE CLASSES UML]

**Figura x — Diagrama de classes do View Show.**
Fonte: Material produzido pelos autores (2026).

### 4.3 Descrição das classes

| Classe | Estereótipo/camada | Responsabilidade | Principais atributos | Principais operações |
| --- | --- | --- | --- | --- |
| `[Classe]` | Entidade | [RESPONSABILIDADE] | `[atributo: Tipo]` | `[metodo(): Retorno]` |
| `[Classe]` | Serviço | [RESPONSABILIDADE] | `[atributo: Tipo]` | `[metodo(): Retorno]` |
| `[Classe]` | Repositório | [RESPONSABILIDADE] | `[atributo: Tipo]` | `[metodo(): Retorno]` |

### 4.4 Relacionamentos

| Origem | Relação | Destino | Multiplicidade | Justificativa |
| --- | --- | --- | --- | --- |
| `[ClasseA]` | Associação | `[ClasseB]` | `1 — 0..*` | [JUSTIFICATIVA] |
| `[ClasseA]` | Composição | `[ClasseB]` | `1 — 1..*` | [JUSTIFICATIVA] |
| `[ClasseA]` | Generalização | `[ClasseB]` | — | [JUSTIFICATIVA] |
| `[ClasseA]` | Dependência | `[ClasseB]` | — | [JUSTIFICATIVA] |

### 4.5 Regras e invariantes do modelo

| ID | Classe(s) envolvida(s) | Regra |
| --- | --- | --- |
| INV-01 | `[Classe]` | [REGRA QUE DEVE PERMANECER VERDADEIRA] |
| INV-02 | `[ClasseA]`, `[ClasseB]` | [REGRA DE CONSISTÊNCIA] |

### 4.6 Decisões de modelagem

[EXPLICAR as principais decisões, abstrações, padrões empregados e elementos
omitidos deliberadamente para manter o diagrama legível.]

---

## 5. Diagramas de sequência

> Deve existir pelo menos um diagrama de sequência para cada fluxo considerado
> crítico. Os cenários escolhidos devem estar ligados a um caso de uso descrito
> na Seção 3.

### 5.1 Catálogo de diagramas de sequência

| ID | Cenário | Caso de uso | Tipo de fluxo | Responsável |
| --- | --- | --- | --- | --- |
| DS-01 | [CENÁRIO PRINCIPAL] | UC-XX | Básico | [Nome] |
| DS-02 | [CENÁRIO ALTERNATIVO] | UC-XX/A1 | Alternativo | [Nome] |
| DS-03 | [CENÁRIO DE FALHA] | UC-XX/E1 | Exceção | [Nome] |

### 5.2 DS-XX — [Nome do cenário]

#### Objetivo

[EXPLICAR o comportamento representado e por que ele é relevante.]

#### Caso de uso relacionado

- **Caso de uso:** UC-XX — [NOME].
- **Fluxo representado:** Básico, A1 ou E1.
- **Pré-condição:** [CONDIÇÃO].
- **Resultado esperado:** [RESULTADO].

#### Participantes

| Participante | Tipo | Responsabilidade |
| --- | --- | --- |
| `[Ator]` | Ator | [RESPONSABILIDADE] |
| `[Interface]` | Boundary | [RESPONSABILIDADE] |
| `[Controlador]` | Control | [RESPONSABILIDADE] |
| `[Entidade]` | Entity | [RESPONSABILIDADE] |
| `[Sistema externo]` | Sistema | [RESPONSABILIDADE] |

#### Diagrama

<!--
Inserir o diagrama de sequência exportado em SVG ou PNG.

Exemplo:
![Diagrama de sequência](../../assets/modelagem/sequencia-uc-xx.svg)
-->

[INSERIR DIAGRAMA DE SEQUÊNCIA UML]

**Figura x — Diagrama de sequência do cenário [NOME].**
Fonte: Material produzido pelos autores (2026).

#### Descrição textual da sequência

| Ordem | Origem | Destino | Mensagem/operação | Resultado |
| --- | --- | --- | --- | --- |
| 1 | `[Ator]` | `[Interface]` | `[acao()]` | [RESULTADO] |
| 2 | `[Interface]` | `[Controlador]` | `[operacao()]` | [RESULTADO] |
| 3 | `[Controlador]` | `[Entidade/Serviço]` | `[operacao()]` | [RESULTADO] |
| 4 | `[Serviço]` | `[Controlador]` | `[retorno]` | [RESULTADO] |
| 5 | `[Controlador]` | `[Interface]` | `[resposta]` | [RESULTADO] |

#### Fragmentos combinados

| Fragmento | Condição de guarda | Comportamento |
| --- | --- | --- |
| `alt` | `[condição]` | [CAMINHOS ALTERNATIVOS] |
| `opt` | `[condição]` | [COMPORTAMENTO OPCIONAL] |
| `loop` | `[condição de repetição]` | [REPETIÇÃO] |
| `break` | `[condição de interrupção]` | [INTERRUPÇÃO] |

#### Tratamento de erros

[EXPLICAR timeout, indisponibilidade de dependências, dados inválidos,
reprocessamento, mensagens de erro e estado preservado.]

---

## 6. Rastreabilidade da modelagem

A rastreabilidade relaciona os casos de uso aos requisitos, às necessidades de usuário e aos demais elementos da modelagem. Essa relação permite verificar a origem de cada comportamento e identificar os conceitos que participam de sua realização.

<div align="center">

<strong>Tabela x: Rastreabilidade dos casos de uso</strong>

</div>

| Área | Caso de uso | Requisitos | Histórias ou telas relacionadas | Elementos conceituais | Sequências relacionadas |
| --- | --- | --- | --- | --- | --- |
| Login e acesso | UC-02 | RF04, RNF04, RIE01, RESTR01 | [Tela de Login](../sprint1/entendimento_ux.md#41-login) | Usuário corporativo, sessão e provedor de identidade | DS-02A |
| Visão Geral, filtros e exportação | UC-01 | RF07, RF08, RF09, RF10, RNF07, RNF14 | [Visão Geral](../sprint1/entendimento_ux.md#42-visão-geral) | Dashboard, consulta, filtro e exportação | DS-01A, DS-01B, DS-02A, DS-04 |
| Análise e revisão de incidente | UC-03 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 | [US-N1-01 a US-N1-05](../sprint1/entendimento_ux.md#32-user-stories-da-persona-1) | Incidente, hipótese, evidência e decisão de revisão | DS-01A, DS-01B, DS-02B, DS-03B, DS-04 |
| Investigação técnica | UC-04 | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 | [US-ENG-01 a US-ENG-04](../sprint1/entendimento_ux.md#33-user-stories-da-persona-2) | Incidente, evento, linha do tempo, hipótese e evidência | DS-01A, DS-01B, DS-02B, DS-03B, DS-04 |
| Avaliação posterior a uma correção | UC-05 | RF07, RF08, RF09, RNF05, RNF14 | [US-ENG-05](../sprint1/entendimento_ux.md#us-eng-05---verificar-a-recuperação-após-uma-correção) e [US-PM-04](../sprint1/entendimento_ux.md#us-pm-04---avaliar-a-evolução-após-uma-correção) | Incidente, marco temporal, janela de comparação e indicador | DS-02C |
| Indicadores, segmentos e histórico de QoE | UC-06 | RF07, RF08, RF09, RNF05, RNF14, RNF15 | [US-PM-01 a US-PM-05](../sprint1/entendimento_ux.md#34-user-stories-da-persona-3) | Indicador de QoE, segmento, série temporal e degradação | DS-01A, DS-01B, DS-03A, DS-03B, DS-04 |
| Integridade da telemetria | UC-07 | RF07, RF08, RNF01, RNF02, RNF03, RNF09, RNF15 | [US-ENG-06](../sprint1/entendimento_ux.md#us-eng-06---monitorar-a-saúde-da-telemetria) e [tela de Monitoramento](../sprint1/entendimento_ux.md#56-monitoramento-da-telemetria) | Fonte de telemetria, métrica operacional, cobertura e alerta | DS-01A, DS-01B, DS-03C |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

---

## 7. Validação e consistência

### 7.1 Lista de verificação

#### Casos de uso

- [x] Todos os atores possuem objetivos claros.
- [x] Todos os casos de uso do diagrama possuem descrição textual.
- [x] Cada descrição segue as seções do formato completo de Larman.
- [x] Os fluxos básicos terminam nas pós-condições declaradas.
- [x] Os fluxos alternativos identificam o passo de origem ou o encerramento.
- [x] As relações representadas possuem semântica compatível com a UML.
- [x] Os casos de uso estão ligados a requisitos existentes.

#### Diagrama de classes

- [ ] As classes representam conceitos ou componentes relevantes.
- [ ] Atributos e operações possuem tipos.
- [ ] Associações possuem multiplicidades.
- [ ] Composição, agregação, herança e dependência foram usadas corretamente.
- [ ] As classes mencionadas nos diagramas de sequência existem no diagrama.
- [ ] O diagrama é consistente com a arquitetura-alvo do View Show.

#### Diagramas de sequência

- [ ] Cada diagrama referencia um caso de uso e um fluxo específico.
- [ ] As mensagens aparecem em ordem temporal.
- [ ] Chamadas síncronas, assíncronas e retornos estão diferenciados.
- [ ] Alternativas e exceções usam fragmentos combinados.
- [ ] Participantes correspondem a atores, interfaces, serviços ou classes da arquitetura-alvo.
- [ ] O resultado final corresponde às pós-condições do caso de uso.

### 7.2 Questões de modelagem em aberto

| ID | Questão | Casos de uso relacionados |
| --- | --- | --- |
| Q-01 | Definição das informações obrigatórias em cada formato de exportação e das telas que preservam os filtros. | UC-01 |
| Q-02 | Definição do protocolo de federação e dos perfis corporativos que determinam as permissões de acesso. | UC-02 |
| Q-03 | Definição dos critérios de revisão das hipóteses e dos dados obrigatórios para registrar uma causa alternativa. | UC-03, UC-04 |
| Q-04 | Definição da amostra mínima e dos critérios de comparabilidade para análises temporais e de segmentos. | UC-05, UC-06 |
| Q-05 | Definição dos limites que caracterizam atraso, cobertura parcial e indisponibilidade das fontes de telemetria. | UC-07 |

### 7.3 Consistência entre os artefatos

| Relação verificada | Critério de consistência |
| --- | --- |
| Casos de uso e requisitos | Cada comportamento está associado a requisitos funcionais, não funcionais, interfaces ou restrições existentes. |
| Atores e entendimento do usuário | Os papéis e seus objetivos correspondem às personas, jornadas e telas definidas para o View Show. |
| Casos de uso e diagrama de classes | As entidades e os serviços representam os conceitos necessários às pós-condições dos casos de uso. |
| Casos de uso e diagramas de sequência | As interações realizam os fluxos básicos e alternativos sem alterar o objetivo ou as garantias declaradas. |

---

## 8. Referências

LARMAN, Craig. *Utilizando UML e padrões: uma introdução à análise e ao projeto orientados a objetos e ao desenvolvimento iterativo*. 3. ed. Porto Alegre: Bookman, 2007. E-book. Disponível em: https://integrada.minhabiblioteca.com.br/reader/books/9788577800476. Acesso em: 6 set. 2026.

OBJECT MANAGEMENT GROUP. *OMG Unified Modeling Language (OMG UML)*. Version 2.5.1. 2017. Disponível em: https://www.omg.org/spec/UML/2.5.1. Acesso em: 6 set. 2026.

GRUPO 05 — OS BIG BROTHERS. *Especificação de requisitos: Monitoramento de Frontend Globoplay*. 2026. Disponível em: [requisitos.md](../sprint1/requisitos.md).
