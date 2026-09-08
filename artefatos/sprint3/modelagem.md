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

&emsp;Os diagramas de sequência são diagramas de interação da UML utilizados para representar, em ordem temporal, as mensagens trocadas entre os participantes de um comportamento. A disposição das linhas de vida e das mensagens permite identificar responsabilidades, dependências e caminhos alternativos durante a realização de um cenário. Essa representação segue os conceitos de interação definidos pela especificação UML 2.5.1 (OBJECT MANAGEMENT GROUP, 2017) e a abordagem apresentada por Larman (2007).

&emsp;Larman (2007) diferencia os Diagramas de Sequência do Sistema, que tratam o sistema como uma caixa-preta, dos diagramas de interação empregados no projeto orientado a objetos, que detalham os participantes internos e suas mensagens. Nesta seção, adota-se a segunda perspectiva em nível de componentes e serviços. Por esse motivo, os diagramas apresentam elementos internos do View Show, como o Backend, os workers, as filas e os serviços de armazenamento.

&emsp;No View Show, esses diagramas descrevem como os dados saem do ARGUS, tornam-se informações analisáveis e chegam aos usuários. A seção contempla a ingestão periódica e por snapshot, a autenticação, a consulta, a revisão humana, a previsão de degradações, a detecção de incidentes e a recuperação de falhas. Cada diagrama é acompanhado por uma explicação de seu objetivo e das decisões arquiteturais necessárias para compreender o fluxo.

&emsp;Os diagramas apresentam a arquitetura-alvo do View Show e especificam as responsabilidades dos participantes em cada cenário. As interações são descritas independentemente do estágio de implementação dos componentes.

### 5.1 Catálogo de diagramas de sequência

&emsp;Os nove diagramas foram organizados por cenário e vinculados aos casos de uso que realizam ou apoiam. A Tabela x funciona como índice da seção e diferencia as interações iniciadas pelo usuário dos processos técnicos executados de forma assíncrona.

<div align="center">

<strong>Tabela x: Catálogo dos diagramas de sequência</strong>

</div>

| ID | Cenário | Casos de uso relacionados | Tipo de fluxo |
| --- | --- | --- | --- |
| DS-01A | Sincronização com o MySQL vivo | UC-01, UC-03, UC-04, UC-06, UC-07 | Suporte técnico |
| DS-01B | Importação de snapshot pela interface | UC-01, UC-03, UC-04, UC-06, UC-07 | Suporte técnico/alternativo |
| DS-02A | Autenticação federada e consulta | UC-01, UC-02 | Básico |
| DS-02B | Revisão concorrente e promoção ao conjunto de referência | UC-03, UC-04 | Concorrente |
| DS-02C | Avaliação da recuperação após correção | UC-05 | Básico/alternativo |
| DS-03A | Previsão preventiva e validação posterior | UC-06 | Suporte técnico/assíncrono |
| DS-03B | Detecção reativa e diagnóstico por IA | UC-03, UC-04, UC-06 | Suporte técnico/assíncrono |
| DS-03C | Falha, novas tentativas, DLQ e reanálise | UC-04, UC-07 | Exceção/alternativo |
| DS-04 | Visão geral ponta a ponta | UC-01, UC-02, UC-03, UC-04, UC-06 | Resumo |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;Os diagramas automáticos de ingestão e análise representam mecanismos técnicos que viabilizam os objetivos dos usuários. Por isso, sua relação com os casos de uso é de suporte. A importação de snapshot e a solicitação de reanálise são apresentadas como variações operacionais dos fluxos de disponibilização e análise dos dados.

### 5.2 Convenções

&emsp;As mensagens estão dispostas de cima para baixo na ordem em que ocorrem. Os fragmentos `alt`, `opt`, `loop` e `par` indicam, respectivamente, alternativas exclusivas, comportamentos condicionais, repetições e atividades concorrentes. As mensagens enviadas à SQS representam comunicação assíncrona; retornos e chamadas diretas representam comunicação síncrona. Horários são registrados em UTC e as operações repetíveis empregam identificadores idempotentes, de modo que uma mesma solicitação possa ser repetida sem duplicar seu efeito.

&emsp;Os diagramas representam componentes lógicos da aplicação. Os participantes identificam papéis ou serviços responsáveis por cada interação, enquanto as mensagens expressam as responsabilidades exercidas no cenário. Elementos como sub-redes, rotas, ALB e NAT Gateway pertencem ao diagrama de implantação e foram omitidos para preservar a legibilidade. O termo `Prediction` identifica uma previsão de risco futuro, enquanto `Incident` identifica uma degradação já observada nos dados.

### 5.3 Ingestão e disponibilização dos dados

&emsp;A ingestão transforma os registros operacionais do ARGUS em fatos e projeções consultáveis pelo View Show. O mesmo serviço processa tanto a fonte MySQL ativa quanto os snapshots enviados pela interface, preservando as regras de normalização e persistência. Esses fluxos fornecem os dados utilizados nos casos de uso UC-01, UC-03, UC-04, UC-06 e UC-07.

#### 5.3.1 DS-01A — Sincronização com o MySQL vivo

&emsp;A sincronização periódica mantém no DynamoDB os últimos 30 dias dos dados produzidos pelo ARGUS e arquiva no S3, em formato Parquet, os 11 meses anteriores. A cada 15 minutos, o EventBridge inicia uma tarefa no Fargate e o Serviço de Ingestão tenta obter no DynamoDB um **bloqueio temporário com expiração**. Esse bloqueio, também denominado *lease*, concede a uma única execução o direito de atualizar a janela; caso a tarefa seja interrompida, a expiração permite que uma execução posterior continue o processamento.

<div align="center">

<strong>Diagrama x: DS-01A — Sincronização dos dados do MySQL vivo do ARGUS</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    participant EB as EventBridge
    participant ECS as ECS/Fargate
    participant ING as Serviço de Ingestão
    participant SM as Secrets Manager
    participant MYSQL as MySQL ARGUS
    participant DB as DynamoDB
    participant S3 as Amazon S3
    participant GLUE as Glue Data Catalog
    participant Q as SQS de Análise
    participant CW as CloudWatch

    EB->>ECS: RunTask(sync)
    ECS->>ING: Iniciar sincronização
    ING->>DB: Criar IngestionRun
    ING->>DB: Adquirir bloqueio temporário

    alt Outra sincronização mantém o bloqueio
        DB-->>ING: ConditionalCheckFailed
        ING->>DB: IngestionRun = SKIPPED_LOCKED
        ING->>CW: Registrar execução ignorada
    else Bloqueio adquirido
        ING->>SM: Obter credenciais do ARGUS
        SM-->>ING: Credenciais
        ING->>MYSQL: Conectar via VPN e TLS
        ING->>MYSQL: Validar schema físico

        alt Schema incompatível
            ING->>DB: Registrar erro permanente
            ING->>DB: IngestionRun = FAILED
            Note over ING,DB: Checkpoint e watermark não avançam
        else Schema válido
            ING->>DB: Ler checkpoint e watermark
            DB-->>ING: resumeCursor e publishedWatermark
            ING->>ING: Calcular janela, lookback e safety delay

            loop Enquanto houver páginas
                ING->>MYSQL: Ler página após resumeCursor
                MYSQL-->>ING: Registros físicos
                ING->>ING: Validar e normalizar
                ING->>ING: Calcular recordId e payloadHash
                ING->>DB: Consultar registros existentes

                alt Registro novo ou alterado
                    ING->>DB: Gravar em lote
                    opt Payload grande autorizado
                        ING->>S3: Armazenar payload
                        ING->>DB: Gravar referência do objeto
                    end
                else Registro inalterado
                    Note over ING,DB: Não repetir escrita
                end

                ING->>DB: Avançar resumeCursor
            end

            ING->>DB: Atualizar projeções afetadas
            opt Dados ultrapassaram 30 dias na camada quente
                ING->>S3: Gravar partição Parquet histórica
                S3-->>ING: Checksum e contagem confirmados
                ING->>GLUE: Registrar partição validada
                ING->>DB: Autorizar expiração da cópia quente
            end
            ING->>ING: Determinar eventos exigidos pela janela
            ING->>DB: Transação: watermark + uma outbox PENDING por evento

            loop Para cada item PENDING
                ING->>Q: Publicar evento com eventId e idempotencyKey próprios
                Q-->>ING: Evento aceito
                ING->>DB: Marcar somente esse item como PUBLISHED
            end

            ING->>DB: IngestionRun = SUCCEEDED
        end

        ING->>DB: Liberar bloqueio
        ING->>CW: Publicar logs, métricas e watermarks
    end

    opt Uma publicação SQS foi interrompida
        Note over DB: Somente a outbox não confirmada permanece PENDING
        ING->>DB: Próxima execução recupera itens PENDING
        ING->>Q: Republicar cada item com os mesmos IDs
        ING->>DB: Marcar cada item confirmado como PUBLISHED
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;Depois de obter o bloqueio, o serviço recupera as credenciais no Secrets Manager e acessa o MySQL pela rede privada, com transporte protegido por TLS. Os registros são lidos em páginas, normalizados e identificados por `recordId`. O `payloadHash` permite reconhecer quando o conteúdo não mudou e evita escritas desnecessárias. Registros novos ou alterados permanecem no DynamoDB durante a janela quente. Ao ultrapassarem 30 dias, são consolidados em partições Parquet no S3 e registrados no Glue Data Catalog; a expiração da cópia quente somente é autorizada após a validação do arquivo histórico.

&emsp;O marcador da última janela completa publicada é denominado *watermark*. Sua atualização ocorre na mesma transação que cria um item de saída pendente, conhecido como *outbox*, para cada evento exigido. Toda janela produz uma detecção, e o fechamento horário também produz uma previsão; cada item possui identificadores e estado próprios. Se uma publicação falhar, a execução seguinte republica somente os itens `PENDING` com as mesmas chaves de idempotência. Se outra sincronização mantiver o bloqueio, a nova tentativa é encerrada como `SKIPPED_LOCKED`, sem interferir na tarefa ativa.

#### 5.3.2 DS-01B — Importação de snapshot pela interface

&emsp;A importação de snapshot permite carregar pela interface uma cópia do banco do ARGUS sem interromper o conjunto de dados que já está disponível. O arquivo é enviado diretamente ao S3 por partes, mediante endereços temporários gerados pelo Backend. Concluído o envio, uma tarefa Fargate restaura o dump em um MySQL 8 isolado e reutiliza o mesmo processo de normalização empregado na sincronização periódica. Enquanto a tarefa é executada, o Dashboard consulta periodicamente o estado do `ImportJob`, prática denominada *polling*, para apresentar o progresso ao usuário.

<div align="center">

<strong>Diagrama x: DS-01B — Importação assíncrona de um snapshot do ARGUS</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    actor U as Operador de dados
    participant UI as Dashboard
    participant API as Backend
    participant S3 as Amazon S3
    participant ECS as ECS/Fargate
    participant MYSQL as MySQL 8 temporário
    participant ING as Serviço de Ingestão
    participant DB as DynamoDB
    participant GLUE as Glue Data Catalog
    participant Q as SQS de Análise
    participant CW as CloudWatch

    U->>UI: Selecionar dump
    UI->>API: POST /api/v1/imports
    API->>API: Resolver sessão corporativa e verificar data:import
    alt Sessão ausente
        API-->>UI: HTTP 401 UNAUTHENTICATED
    else Sessão sem data:import
        API-->>UI: HTTP 403 FORBIDDEN
    else Operador autorizado
    API->>DB: Criar ImportJob = UPLOADING e candidateDatasetVersion
    API-->>UI: importId + URLs multipart pré-assinadas
    end

    loop Para cada parte do arquivo
        UI->>S3: Enviar parte
        S3-->>UI: Parte recebida
        UI->>UI: Atualizar percentual do upload
    end

    UI->>API: POST /api/v1/imports/{importId}/complete + Idempotency-Key
    API->>API: Resolver sessão corporativa e verificar data:import
    alt Sessão ausente
        API-->>UI: HTTP 401 UNAUTHENTICATED
    else Sessão sem data:import
        API-->>UI: HTTP 403 FORBIDDEN
    else Operador autorizado
    API->>DB: Reservar chave + hash, completionStep = RESERVED

    alt Primeira conclusão válida
        API->>S3: Confirmar upload, tamanho e checksum
        API->>DB: completionStep = UPLOAD_COMPLETED,<br/>status = PROCESSING, stage = STARTING_TASK
        API->>ECS: RunTask(import-snapshot, clientToken derivado do importId)
        ECS-->>API: taskArn
        API->>DB: Persistir taskArn e resposta, stage = VALIDATING
        API-->>UI: HTTP 202 Accepted
    else Mesma chave e mesmas partes
        API->>DB: Consultar etapa e resposta persistidas
        opt Upload ainda não confirmado
            API->>S3: Confirmar ou reconhecer upload já concluído
            API->>DB: completionStep = UPLOAD_COMPLETED,<br/>status = PROCESSING, stage = STARTING_TASK
        end
        opt RunTask pendente ou resposta perdida
            API->>ECS: Repetir RunTask com o mesmo clientToken
            ECS-->>API: Mesmo taskArn
            API->>DB: Persistir taskArn e resposta
        end
        API-->>UI: Repetir HTTP 202 sem duplicar efeitos
    else Chave reutilizada com partes diferentes
        API-->>UI: HTTP 409 IDEMPOTENCY_KEY_REUSED
    end
    end

    par Processamento assíncrono
        ECS->>DB: stage = VALIDATING
        ECS->>S3: Baixar dump
        S3-->>ECS: Arquivo
        ECS->>ECS: Validar formato, checksum e espaço

        alt Dump inválido
            ECS->>DB: ImportJob = FAILED
            ECS->>CW: Registrar erro sanitizado
        else Dump válido
            ECS->>DB: stage = RESTORING
            ECS->>MYSQL: Iniciar MySQL 8 isolado
            ECS->>MYSQL: Restaurar dump

            alt Restauração falhou
                ECS->>DB: ImportJob = FAILED
                ECS->>CW: Registrar falha de restauração
            else Restauração concluída
                ECS->>DB: stage = INGESTING
                ECS->>ING: Executar backfill(snapshot)
                ING->>MYSQL: Ler dados restaurados
                Note over ING,DB: Paginação e normalização seguem o DS-01A
                ING->>DB: Gravar até 30 dias na versão candidata
                ING->>S3: Gravar 11 meses em Parquet na versão candidata
                S3-->>ING: Checksum e contagens do arquivo
                ING->>GLUE: Registrar partições da versão candidata
                ING->>DB: Validar camadas, projeções e watermarks

                alt Backfill ou validação falhou
                    ING->>DB: ImportJob = FAILED
                    ING->>CW: Registrar falha sem ativar a candidata
                else Versão candidata concluída
                    ECS->>DB: stage = ACTIVATING
                    ING->>DB: TransactWriteItems
                    Note over ING,DB: Atualizar watermark e manifesto ativo,<br/>criar duas outboxes PENDING e concluir ImportJob
                    ING->>Q: Publicar ANOMALY_DETECTION
                    Q-->>ING: Detecção aceita
                    ING->>DB: Outbox da detecção = PUBLISHED
                    ING->>Q: Publicar QOE_FORECAST
                    Q-->>ING: Previsão aceita
                    ING->>DB: Outbox da previsão = PUBLISHED
                    ECS->>CW: Publicar métricas da importação
                end
            end
        end

        ECS->>MYSQL: Encerrar banco temporário, se iniciado
        ECS->>ECS: Descartar volume efêmero
        ECS->>CW: Registrar resultado da limpeza

    and Acompanhamento pelo usuário
        loop Enquanto o estado não for terminal
            UI->>API: GET /api/v1/imports/{importId}
            API->>API: Resolver sessão corporativa e verificar data:import
            API->>DB: Consultar ImportJob
            DB-->>API: status, stage e progresso
            API-->>UI: Estado atual
            UI->>UI: Atualizar mensagem de carregamento
        end
    end

    UI->>API: GET /api/v1/imports/{importId}
    API->>API: Resolver sessão corporativa e verificar data:import
    API->>DB: Consultar estado final
    DB-->>API: COMPLETED ou FAILED

    alt Importação concluída
        API-->>UI: Dataset carregado
        UI->>UI: Exibir sucesso e atualizar dashboard
    else Importação falhou
        API-->>UI: Falha e código de acompanhamento
        UI->>UI: Exibir erro e preservar dataset anterior
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;O ator deste fluxo é o `Operador de dados`: o Backend resolve a sessão corporativa e exige `data:import`, concedida somente pelo grupo Cognito `data-operator`, antes de criar ou consultar o `ImportJob` e antes de acessar S3 ou ECS. Sessão ausente recebe HTTP 401 com `UNAUTHENTICATED`; sessão válida sem a permissão recebe HTTP 403 com `FORBIDDEN`. Claims no body ou em headers não concedem essa autorização. O Backend responde com HTTP 202 porque a restauração e a ingestão continuam de forma assíncrona. A conclusão reserva condicionalmente a chave de idempotência e o hash canônico das partes no `ImportJob`; cada etapa alcançada, o `taskArn` e a resposta são persistidos. Se a chamada for repetida ou interrompida, o Backend retoma a etapa pendente e utiliza o mesmo `clientToken` no `RunTask`, sem criar outra tarefa. O `ImportJob` registra `createdBy`, `completionRequestedBy` e `activatedBy` a partir da sessão autorizada, além de `createdAt`, `completionRequestedAt` e `activatedAt`; `activatedBy` guarda o operador cujo comando autorizado iniciou o processamento. Ele recebe uma `candidateDatasetVersion`, usada nas chaves do DynamoDB, nos prefixos do S3, nas partições do Glue e nos watermarks. O dashboard continua consultando o manifesto anterior até que os dois níveis da candidata sejam validados. Depois da validação, uma transação troca o manifesto ativo, cria itens independentes de outbox para a detecção e para a previsão e conclui o job. O `recordId` permanece estável entre versões.

&emsp;As falhas são tratadas de modo a preservar um estado utilizável. Dump inválido, falha de restauração, backfill incompleto ou validação inconsistente encerram o `ImportJob` como `FAILED` sem alterar o manifesto ativo; a versão candidata permanece invisível e pode ser removida posteriormente. Falhas de publicação mantêm apenas o item correspondente da outbox como `PENDING`. O encerramento do MySQL e o descarte do volume são executados no caminho comum após sucesso ou falha, sem remover o dump retido no S3. A ingestão não consulta nem modifica o conjunto de diagnósticos confirmados.

### 5.4 Backend, autenticação e revisão

&emsp;Os fluxos do Backend representam as interações iniciadas pelos usuários corporativos. O primeiro garante uma sessão autenticada antes de disponibilizar o dashboard; o segundo registra a decisão humana sobre uma hipótese diagnóstica; o terceiro compara os indicadores anteriores e posteriores a uma correção externa. Essas interações realizam os casos de uso UC-01, UC-02, UC-03, UC-04 e UC-05. O Dashboard atua como interface, enquanto o Backend concentra a validação da sessão, a consulta aos dados e a aplicação das regras de revisão e comparação.

#### 5.4.1 DS-02A — Autenticação federada e consulta

&emsp;A autenticação federada permite que o View Show reconheça a identidade corporativa sem armazenar senhas. Quando não existe sessão válida, o Backend direciona o usuário ao Cognito, que delega a autenticação ao SSO da Globo. Somente depois da validação do retorno o sistema cria a sessão e consulta o modelo de leitura da visão geral.

<div align="center">

<strong>Diagrama x: DS-02A — Autenticação federada e consulta do dashboard</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    actor U as Usuário Globo
    participant UI as Dashboard
    participant API as Backend
    participant COG as Cognito
    participant SSO as SSO Globo
    participant DB as DynamoDB
    participant CW as CloudWatch

    U->>UI: Acessar área protegida
    UI->>API: GET /auth/session

    alt Sessão inexistente ou expirada
        API-->>UI: HTTP 401
        UI->>API: GET /auth/login
        API->>API: Gerar state, nonce e PKCE
        API-->>U: Redirecionar para Cognito
        U->>COG: Authorization Request
        COG->>SSO: Federar por OIDC ou SAML
        SSO->>U: Solicitar autenticação corporativa
        U->>SSO: Informar credenciais no domínio Globo
        SSO-->>COG: Identidade autenticada
        COG-->>API: Authorization Code
        API->>API: Validar state
        API->>COG: Trocar código e PKCE por tokens
        COG-->>API: JWT assinado
        API->>API: Validar assinatura, emissor, audience, expiração e nonce

        alt Token válido e identidade autorizada
            API-->>U: Cookie HttpOnly, Secure e SameSite
            API-->>U: Redirecionar para o dashboard
        else Token ou identidade inválida
            API->>CW: Registrar falha sanitizada
            API-->>U: Acesso negado
        end
    else Sessão válida
        API-->>UI: Usuário autenticado
    end

    U->>UI: Abrir visão geral
    UI->>API: GET /api/v1/dashboard/overview com cookie
    API->>API: Validar sessão e JWT

    alt Sessão válida
        API->>DB: Consultar modelo de leitura da visão geral
        DB-->>API: Incidentes, métricas e frescor
        API->>API: Converter para DTO público
        API->>CW: Registrar latência e requestId
        API-->>UI: HTTP 200 + data/meta
        UI-->>U: Exibir dashboard
    else Sessão expirada durante o uso
        API-->>UI: HTTP 401
        UI-->>U: Informar sessão expirada
        UI->>API: Reiniciar login federado
    end

    opt Usuário encerra a sessão
        U->>UI: Sair
        UI->>API: POST /auth/logout
        API-->>U: Apagar cookie de sessão
        API-->>U: Redirecionar para logout do Cognito
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;O SSO da Globo autentica o usuário, enquanto o Cognito atua como intermediário de identidade e emite tokens assinados no formato JWT. O Backend conclui o fluxo OAuth segundo o padrão *Backend for Frontend* (BFF). O padrão PKCE (*Proof Key for Code Exchange*) vincula o pedido de autenticação à troca posterior do código, reduzindo o risco de sua utilização indevida. O navegador recebe somente um cookie `HttpOnly`, `Secure` e `SameSite`, inacessível ao JavaScript. As respostas públicas também ocultam chaves e detalhes físicos das camadas de armazenamento.

&emsp;Uma sessão inexistente, expirada ou associada a uma identidade não autorizada interrompe a consulta antes do acesso aos dados. As falhas são registradas sem credenciais ou tokens e o usuário é direcionado novamente ao processo de autenticação.

#### 5.4.2 DS-02B — Revisão concorrente e promoção ao conjunto de referência

&emsp;A revisão de hipóteses permite que uma pessoa confirme, refute ou marque como inconclusiva a causa provável apresentada pelo sistema. Como dois usuários podem abrir o mesmo diagnóstico, o Backend utiliza a versão conhecida pelo revisor para aceitar somente a decisão compatível com o estado e a versão atuais. Uma hipótese confirmada passa a integrar o *golden set*, isto é, o conjunto de diagnósticos humanos confirmados que serve como referência para análises futuras. Uma decisão inconclusiva permanece revisável e não promove a hipótese.

<div align="center">

<strong>Diagrama x: DS-02B — Revisão concorrente e promoção de hipótese ao conjunto de referência</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    actor A as Usuário A
    actor B as Usuário B
    participant UI as Dashboard
    participant API as Backend
    participant OP as DynamoDB Operacional
    participant GS as Conjunto de referência

    par Usuários consultam a mesma hipótese
        A->>UI: Abrir diagnóstico
        UI->>API: GET /incidents/{id}/diagnosis
        API->>OP: Consultar incidente e hipóteses
        OP-->>API: Hypothesis PENDING, version = 0
        API-->>UI: Diagnóstico
        UI-->>A: Exibir hipótese pendente
    and
        B->>UI: Abrir diagnóstico
        UI->>API: GET /incidents/{id}/diagnosis
        API->>OP: Consultar incidente e hipóteses
        OP-->>API: Hypothesis PENDING, version = 0
        API-->>UI: Diagnóstico
        UI-->>B: Exibir hipótese pendente
    end

    A->>UI: Confirmar, refutar ou marcar a hipótese como inconclusiva
    UI->>API: PATCH review, expectedVersion=0, Idempotency-Key A
    API->>API: Obter identidade do Usuário A
    API->>OP: Consultar Idempotency-Key A

    alt Chave A ainda não processada
        alt Decisão CONFIRMED
            API->>OP: TransactWriteItems
            Note over API,GS: Condição: status PENDING e version 0
            Note over OP,GS: Confirmar hipótese, registrar auditoria imutável,<br/>salvar resposta idempotente e criar GoldenCase
            OP-->>API: Transação concluída
            API-->>UI: HTTP 200 - CONFIRMED, version = 1
        else Decisão REFUTED
            API->>OP: TransactWriteItems
            Note over API,OP: Condição: status PENDING e version 0
            Note over API,OP: Refutar hipótese, registrar causa alternativa quando informada,<br/>auditoria imutável e resposta idempotente, sem GoldenCase
            OP-->>API: Transação concluída
            API-->>UI: HTTP 200 - REFUTED, version = 1
        else Decisão INCONCLUSIVE
            API->>OP: TransactWriteItems
            Note over API,OP: Condição: status PENDING e version 0
            Note over API,OP: Gravar hipótese INCONCLUSIVE, auditoria imutável<br/>e resposta idempotente, sem escrever no golden set
            OP-->>API: Transação concluída
            API-->>UI: HTTP 200 - INCONCLUSIVE, version = 1
        end
    else Mesma chave e mesmo conteúdo
        OP-->>API: Resultado armazenado
        API-->>UI: HTTP 200 com resposta anterior
    else Mesma chave com conteúdo diferente
        API-->>UI: HTTP 409 - IDEMPOTENCY_KEY_REUSED
    end

    Note over A,B: O cenário continua pelo ramo INCONCLUSIVE
    B->>UI: Refutar hipótese com expectedVersion=0 ainda obsoleto
    UI->>API: PATCH review - REFUTED, expectedVersion=0, Idempotency-Key B
    API->>API: Obter identidade do Usuário B
    API->>OP: Consultar Idempotency-Key B

    alt Chave B ainda não processada
        API->>OP: TransactWriteItems
        Note over API,OP: Condição falha: expectedVersion=0 está obsoleta,<br/>estado atual INCONCLUSIVE, version 1
        OP-->>API: ConditionalCheckFailed
        API->>OP: Consultar estado atual
        OP-->>API: INCONCLUSIVE, version = 1
        API-->>UI: HTTP 409 - REVIEW_VERSION_CONFLICT
        UI-->>B: Atualizar a hipótese antes de revisar
    else Repetição de operação concluída
        OP-->>API: Resultado armazenado
        API-->>UI: Devolver resposta anterior
    end

    A->>UI: Confirmar a hipótese após nova análise
    UI->>API: PATCH review - CONFIRMED, expectedVersion=1, Idempotency-Key C
    API->>OP: TransactWriteItems
    Note over API,GS: Condição: status INCONCLUSIVE e expectedVersion=1,<br/>registrar auditoria, resposta idempotente e GoldenCase
    OP-->>API: Transação concluída
    API-->>UI: HTTP 200 - CONFIRMED, version = 2

    B->>UI: Tentar refutar com expectedVersion=2 atual
    UI->>API: PATCH review - REFUTED, expectedVersion=2, Idempotency-Key D
    API->>OP: Consultar estado atual
    OP-->>API: CONFIRMED, version = 2
    API-->>UI: HTTP 409 - REVIEW_FINAL_STATE_CONFLICT

    opt Resposta de sucesso foi perdida
        A->>UI: Repetir confirmação
        UI->>API: Mesmo body e Idempotency-Key C
        API->>OP: Consultar resultado idempotente
        OP-->>API: Decisão já concluída
        API-->>UI: HTTP 200 sem nova auditoria
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A identidade do revisor vem da sessão. A requisição informa `Idempotency-Key` e `expectedVersion`; a escrita exige a versão esperada e aceita `PENDING` ou `INCONCLUSIVE`. `CONFIRMED` e `REFUTED` são terminais. `INCONCLUSIVE` grava uma decisão humana, mas não é terminal: outra revisão pode decidir `CONFIRMED` ou `REFUTED` com nova `Idempotency-Key` e a versão atual. Somente `CONFIRMED` inclui a criação do `GoldenCase` na transação; `REFUTED` e `INCONCLUSIVE` permanecem no histórico operacional.

&emsp;Requisições sem a versão esperada são rejeitadas sem alterar a hipótese. Uma requisição com versão obsoleta recebe `REVIEW_VERSION_CONFLICT`; uma tentativa de alterar `CONFIRMED` ou `REFUTED` com a versão atual recebe `REVIEW_FINAL_STATE_CONFLICT`. Toda decisão grava auditoria imutável. A chave de idempotência permite devolver o mesmo resultado quando uma requisição é repetida, sem duplicar a auditoria ou o caso confirmado.

#### 5.4.3 DS-02C — Avaliação da recuperação após correção

&emsp;A avaliação de recuperação ocorre depois de uma correção realizada fora do View Show. A Engenheira de Software ou a Product Manager seleciona o incidente, confirma o marco temporal da intervenção e solicita a comparação de janelas equivalentes. O fluxo realiza UC-05 sem atribuir ao sistema a implantação da correção nem transformar uma associação temporal em afirmação de causalidade.

<div align="center">

<strong>Diagrama x: DS-02C — Avaliação da recuperação após correção</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    actor U as Engenheira ou Product Manager
    participant UI as Dashboard
    participant API as Backend
    participant DB as DynamoDB
    participant ATH as Amazon Athena

    U->>UI: Selecionar incidente ou problema
    UI->>API: Solicitar contexto de recuperação
    API->>DB: Consultar segmento e marco da correção
    DB-->>API: Contexto disponível
    API-->>UI: Segmento, marco e janelas sugeridas

    alt Marco da correção inexistente
        UI-->>U: Solicitar marco aproximado
        U->>UI: Informar data e hora estimadas
    else Marco registrado
        UI-->>U: Exibir marco associado
    end

    U->>UI: Confirmar marco e janelas equivalentes
    UI->>API: Solicitar comparação de recuperação
    alt Janelas contidas nos últimos 30 dias
        API->>DB: Consultar indicadores anteriores e posteriores
        DB-->>API: Métricas, períodos e tamanhos das amostras
    else Janela inclui período histórico
        API->>ATH: Consultar partições Parquet da versão ativa
        ATH-->>API: Métricas, períodos e tamanhos das amostras
    end
    API->>API: Verificar janelas equivalentes e mínimo de 20 observações
    API->>API: Calcular variações absolutas e percentuais

    alt Amostras suficientes e períodos comparáveis
        API->>API: Classificar recuperação
        API-->>UI: Variações e resultado da comparação
        UI-->>U: Exibir melhora, estabilidade ou piora
        U->>UI: Registrar conclusão e limitações
        UI->>API: Solicitar registro da avaliação
        API->>DB: Armazenar avaliação, autoria e data
        DB-->>API: Avaliação registrada
        API-->>UI: Confirmar registro
    else Amostra insuficiente ou períodos incompatíveis
        API-->>UI: Comparação inconclusiva e limitações
        UI-->>U: Solicitar ajuste das janelas ou nova avaliação futura
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;O componente responsável pela comparação deverá devolver os períodos, os tamanhos das amostras e as variações absolutas e percentuais para que o resultado permaneça auditável. Consultas de até 30 dias utilizam o DynamoDB, enquanto períodos anteriores são obtidos pelo Athena a partir dos arquivos Parquet no S3. No MVP, a classificação conclusiva exige janelas de mesma duração, os mesmos filtros de segmento e ao menos 20 observações em cada janela; nos demais cenários, a interface informa a limitação e preserva o contexto para ajuste ou repetição posterior.

&emsp;A conclusão registrada representa a interpretação do ator a partir dos indicadores disponíveis. O View Show não executa implantação ou reversão e não afirma que a correção causou a variação observada. Essa delimitação mantém o diagrama coerente com a fronteira funcional definida em UC-05.

### 5.5 Worker de Análise

&emsp;O Worker de Análise consome de forma assíncrona as janelas materializadas pela ingestão e coordena três responsabilidades: antecipar degradações, reconhecer anomalias já observadas e recuperar processamentos interrompidos. Essas atividades não são iniciadas diretamente pelos atores, mas fornecem previsões, incidentes, evidências, hipóteses e informações operacionais para os casos de uso UC-03, UC-04, UC-06 e UC-07.

&emsp;O orquestrador de análise permanece um módulo interno do Worker. Ele combina os resultados dos modelos, recupera informações do DynamoDB e consulta casos humanos confirmados antes de solicitar ao agente diagnóstico uma explicação para o risco ou incidente. O Amazon Bedrock apoia a geração das hipóteses, mas não substitui a decisão humana.

#### 5.5.1 DS-03A — Previsão preventiva e validação posterior

&emsp;A previsão preventiva estima, a cada janela horária completa, o risco de degradação da experiência na hora seguinte. Antes de produzir uma nova previsão, o Worker compara a estimativa anterior com o valor efetivamente observado. Essa validação permite acompanhar a qualidade do modelo e registrar se ele reconheceu corretamente a ocorrência ou a ausência de uma degradação.

<div align="center">

<strong>Diagrama x: DS-03A — Previsão preventiva e validação da previsão anterior</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    participant Q as SQS de Análise
    participant W as Worker de Análise
    participant DB as DynamoDB
    participant M as QoE Forecast Model
    participant O as Analysis Orchestrator
    participant A as Diagnostic Agent
    participant GS as Conjunto de referência
    participant B as Amazon Bedrock

    Q->>W: ANALYSIS_REQUESTED - QOE_FORECAST
    W->>W: Validar schemaVersion e campos
    W->>DB: Consultar idempotencyKey

    alt Análise já concluída
        DB-->>W: AnalysisRun = SUCCEEDED
        W->>Q: Confirmar e remover duplicata
    else Nova análise
        W->>DB: Criar AnalysisRun = PROCESSING

        opt Existe previsão para a janela recém-concluída
            W->>DB: Buscar Prediction anterior
            W->>DB: Ler buffering realmente observado
            W->>W: Comparar previsto e observado

            alt Dados completos
                W->>DB: Salvar TP, FP, TN ou FN
                W->>DB: Prediction = EVALUATED
            else Dados insuficientes após a tolerância
                W->>DB: validationStatus = UNAVAILABLE
                W->>DB: classificationOutcome = UNKNOWN
            end
        end

        W->>DB: Ler janela atual e variáveis históricas
        DB-->>W: Valor, lags, média móvel, sessões, erros e calendário
        W->>M: predict(features, modelVersion)
        M-->>W: predictedValue e riskScore
        W->>W: Comparar previsão com o limiar
        W->>DB: Criar Prediction = ACTIVE

        alt Risco abaixo do limiar
            W->>DB: riskLevel = NORMAL
            W->>DB: AnalysisRun = SUCCEEDED
            W->>Q: Confirmar mensagem
        else Risco acima do limiar
            W->>DB: riskLevel = ELEVATED
            W->>O: Solicitar diagnóstico preventivo
            O->>DB: Verificar qualidade e cobertura

            alt Qualidade insuficiente
                O->>DB: Diagnosis = PENDING
                W->>DB: AnalysisRun = SUCCEEDED
                W->>Q: Confirmar mensagem
            else Qualidade suficiente
                O->>DB: Reunir evidências e contexto de até 5h
                O->>GS: Consultar casos confirmados
                GS-->>O: Casos semelhantes
                O->>DB: Diagnosis = PROCESSING
                O->>A: Diagnosticar risco preventivo
                A->>B: Enviar contexto estruturado e sanitizado
                B-->>A: Hipóteses candidatas
                A->>A: Estruturar, justificar e ranquear
                A-->>O: Hipóteses preventivas
                O->>DB: Salvar Diagnosis = READY
                O->>DB: Salvar Hypotheses = PENDING
                W->>DB: AnalysisRun = SUCCEEDED
                W->>Q: Confirmar mensagem
            end
        end
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A previsão executa após uma janela horária completa e registra o limiar e a versão do modelo. A mesma execução compara a previsão anterior com o valor observado e classifica o resultado como `TP`, `FP`, `TN`, `FN` ou `UNKNOWN`. Risco normal não aciona o agente; risco elevado exige qualidade mínima. Uma hipótese preventiva não é um incidente e continua sujeita à revisão humana. As classificações `TP`, `FP`, `TN` e `FN` representam, respectivamente, verdadeiro positivo, falso positivo, verdadeiro negativo e falso negativo; `UNKNOWN` indica que os dados disponíveis não permitem avaliar a previsão.

#### 5.5.2 DS-03B — Detecção reativa e diagnóstico por IA

&emsp;A detecção reativa examina cada nova janela de 15 minutos para identificar alterações relevantes em relação ao comportamento histórico. O detector aplica o desvio absoluto mediano (MAD) às séries individuais e a distância de Mahalanobis ao conjunto de variáveis correlacionadas. A primeira técnica identifica valores afastados do padrão de uma métrica; a segunda verifica se a combinação entre várias métricas se tornou atípica.

<div align="center">

<strong>Diagrama x: DS-03B — Detecção reativa e diagnóstico automático por IA</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    participant Q as SQS de Análise
    participant W as Worker de Análise
    participant DB as DynamoDB
    participant D as Anomaly Detector
    participant O as Analysis Orchestrator
    participant A as Diagnostic Agent
    participant GS as Conjunto de referência
    participant B as Amazon Bedrock

    Q->>W: ANALYSIS_REQUESTED - ANOMALY_DETECTION
    W->>W: Validar schemaVersion e campos
    W->>DB: Consultar idempotencyKey

    alt Análise já concluída
        DB-->>W: AnalysisRun = SUCCEEDED
        W->>Q: Confirmar e remover duplicata
    else Nova análise
        W->>DB: Criar AnalysisRun = PROCESSING
        W->>DB: Ler janela atual, histórico e baseline
        DB-->>W: Sinais e qualidade dos dados
        W->>D: detect(window, detectorVersion)

        par Detecção por série
            D->>D: Calcular mediana e MAD
        and Detecção multivariada
            D->>D: Calcular distância de Mahalanobis
        end

        D-->>W: Scores, limiares e sinais encontrados

        alt Nenhuma anomalia acima do limiar
            W->>DB: Salvar resumo da detecção
            W->>DB: AnalysisRun = SUCCEEDED
            W->>Q: Confirmar mensagem
        else Anomalia encontrada
            W->>O: Entregar resultado e evidências
            O->>DB: Procurar incidente ativo correlacionável

            alt Incidente existente
                DB-->>O: incidentId existente
                O->>DB: Anexar nova Evidence
            else Nenhum incidente correlacionável
                O->>DB: Criar Incident = DETECTED
                Note over O,DB: Escrita condicional evita duplicação
                O->>DB: Criar Evidence do detector
            end

            O->>DB: Verificar qualidade e cobertura

            alt Qualidade insuficiente
                O->>DB: Diagnosis = PENDING
                W->>DB: AnalysisRun = SUCCEEDED
                W->>Q: Confirmar mensagem
            else Qualidade suficiente
                O->>DB: Incident = INVESTIGATING
                O->>DB: Reunir métricas, erros, concentrações e timeline
                O->>GS: Consultar casos confirmados semelhantes
                GS-->>O: Casos de referência
                O->>DB: Diagnosis = PROCESSING
                O->>A: Solicitar diagnóstico reativo
                A->>B: Enviar contexto estruturado e sanitizado
                B-->>A: Hipóteses candidatas
                A->>A: Estruturar, justificar e ranquear
                A-->>O: Hipóteses reativas
                O->>DB: Salvar Diagnosis = READY
                O->>DB: Salvar Hypotheses = PENDING
                W->>DB: AnalysisRun = SUCCEEDED
                W->>Q: Confirmar mensagem
            end
        end
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;MAD e Mahalanobis permanecem módulos internos do mesmo Worker. O detector produz scores e evidências; o `Analysis Orchestrator` cria ou correlaciona o incidente. O resultado estatístico torna-se uma evidência associada ao incidente. Quando há qualidade e cobertura suficientes, o agente consulta o contexto de até cinco horas anteriores à falha e o conjunto de casos confirmados para produzir hipóteses justificadas. Eventos individuais ficam restritos ao mesmo dispositivo; quando existirem apenas agregados, são usadas métricas do segmento afetado e o diagnóstico recebe qualidade limitada. O incidente permanece disponível mesmo quando o diagnóstico por IA não pode ser concluído.

#### 5.5.3 DS-03C — Recuperação de falhas, mensagens não processadas e reanálise

&emsp;A recuperação de falhas evita que uma indisponibilidade transitória descarte o resultado já produzido. O Worker registra cada tentativa e retoma a partir da última etapa persistida. Entre as tentativas, aplica-se uma espera progressiva, denominada *backoff*, para reduzir a pressão sobre a dependência indisponível. Depois do limite configurado, a mensagem segue para a *Dead-Letter Queue* (DLQ), fila separada que conserva mensagens não processadas para inspeção e reenvio controlado. O mesmo fluxo permite que um usuário autenticado solicite uma nova análise do incidente.

<div align="center">

<strong>Diagrama x: DS-03C — Recuperação de falhas, DLQ e reanálise</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    actor U as Usuário Globo
    participant UI as Dashboard
    participant API as Backend
    participant Q as SQS de Análise
    participant W as Worker de Análise
    participant DB as DynamoDB
    participant DLQ as Dead-Letter Queue
    participant CW as CloudWatch

    Q->>W: Entregar mensagem
    W->>DB: Consultar AnalysisRun e idempotencyKey

    alt Execução já concluída
        DB-->>W: AnalysisRun = SUCCEEDED
        W->>Q: Remover mensagem duplicada
    else Execução nova ou incompleta
        W->>DB: Criar ou retomar AnalysisRun
        W->>DB: Registrar attemptCount

        loop Enquanto o processamento estiver ativo
            W->>Q: Estender tempo de invisibilidade
        end

        W->>W: Retomar da última etapa persistida

        alt Processamento concluído
            W->>DB: AnalysisRun = SUCCEEDED
            W->>Q: Remover mensagem
        else Bedrock ou dependência indisponível
            W->>DB: Preservar resultados já produzidos
            W->>DB: Diagnosis = FAILED, retryable = true
            W->>DB: AnalysisRun = RETRY_PENDING

            alt Ainda há tentativas
                W->>Q: Adiar tentativa com espera progressiva
                Note over Q,W: 30 s, 2 min, 5 min e 15 min
            else Quinta tentativa falhou
                W->>DB: AnalysisRun = FAILED
                Q->>DLQ: Encaminhar automaticamente
                DLQ->>CW: Disparar alarme
            end
        else Mensagem permanentemente inválida
            W->>DB: Registrar erro de contrato
            W->>DB: AnalysisRun = FAILED
            W->>DLQ: Preservar mensagem e metadados
            W->>Q: Remover mensagem inválida da fila principal
            DLQ->>CW: Disparar alarme
        end
    end

    opt Reenvio técnico após correção
        DLQ->>Q: Republicar mensagem preservada
        Q->>W: Entregar com o mesmo eventId e idempotencyKey
        W->>DB: Retomar ou ignorar se concluída
    end

    opt Usuário solicita nova análise
        U->>UI: Solicitar reanálise
        UI->>API: POST /incidents/{id}/reanalyze e Idempotency-Key
        API->>API: Validar sessão e obter requestedBy
        API->>Q: REANALYSIS_REQUESTED com key na raiz e reason MANUAL_REQUEST
        API-->>UI: HTTP 202 Accepted
        UI-->>U: Reanálise solicitada
    end
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;Os valores iniciais adotados para a fila foram reunidos na Tabela x. Eles delimitam o tempo concedido a cada processamento, o número de tentativas e o período disponível para uma recuperação manual.

<div align="center">

<strong>Tabela x: Parâmetros operacionais da fila de análise</strong>

</div>

| Configuração | Valor inicial |
| --- | ---: |
| Tipo da fila | SQS Standard |
| Tempo de invisibilidade da mensagem | 5 minutos |
| Renovação durante o processamento | A cada 60 segundos |
| Máximo de recebimentos | 5 |
| Retenção da fila principal | 4 dias |
| Retenção da DLQ | 14 dias |
| Espera máxima por novas mensagens | 20 segundos |
| Alarme | Uma ou mais mensagens na DLQ |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;Mensagens duplicadas são tratadas por idempotência. O Worker retoma da última etapa persistida, e uma falha no Bedrock não remove previsão, incidente ou evidências nem produz uma hipótese artificial. Erros permanentes seguem diretamente para a DLQ; falhas transitórias usam a espera progressiva e o reenvio automático após o quinto recebimento.

&emsp;Ao concluir uma solicitação, o Worker registra a execução como `SUCCEEDED`. Cada previsão preserva a versão do modelo, o limiar, a janela-alvo e, quando disponível, o resultado de sua validação. Toda anomalia persistida permanece associada à evidência que a fundamenta e, quando aplicável, a um incidente. As hipóteses continuam pendentes até a revisão humana, enquanto mensagens que não puderam ser processadas permanecem recuperáveis na DLQ.

### 5.6 Visão geral ponta a ponta

&emsp;O fluxo ponta a ponta sintetiza como os processos anteriores se conectam. Ele começa quando o ARGUS ou um snapshot disponibiliza dados, acompanha sua normalização e análise e termina quando o usuário consulta o resultado e decide sobre uma hipótese. Essa visão não substitui os diagramas detalhados; sua função é evidenciar a continuidade entre a origem operacional, o processamento automático e a intervenção humana.

<div align="center">

<strong>Diagrama x: DS-04 — Visão geral ponta a ponta da plataforma View Show</strong>

</div>

```mermaid
sequenceDiagram
    autonumber

    actor U as Usuário Globo
    participant SRC as MySQL ARGUS / Snapshot
    participant ING as Serviço de Ingestão
    participant DB as DynamoDB Operacional
    participant S3 as S3 / Parquet histórico
    participant GLUE as Glue Data Catalog
    participant ATH as Amazon Athena
    participant Q as SQS de Análise
    participant W as Worker de Análise
    participant B as Amazon Bedrock
    participant UI as Dashboard
    participant API as Backend
    participant GS as Conjunto de referência

    SRC->>ING: Disponibilizar nova janela de dados
    ING->>ING: Validar e normalizar
    ING->>DB: Manter até 30 dias de fatos e projeções
    ING->>S3: Arquivar 11 meses em Parquet
    ING->>GLUE: Registrar partições históricas
    ING->>DB: Publicar watermark e outbox
    ING->>Q: ANALYSIS_REQUESTED
    Q->>W: Entregar janela materializada
    W->>DB: Ler dados, histórico e evidências
    DB-->>W: Contexto da análise

    alt Previsão horária
        W->>W: Executar QoE Forecast Model
        W->>DB: Salvar Prediction

        opt Risco elevado e qualidade suficiente
            W->>DB: Reunir contexto preventivo
            W->>B: Investigar possíveis causas
            B-->>W: Hipóteses candidatas
            W->>DB: Salvar diagnóstico e hipóteses preventivas
        end
    else Detecção a cada 15 minutos
        W->>W: Executar MAD e Mahalanobis

        opt Anomalia encontrada
            W->>DB: Criar ou correlacionar Incident
            W->>DB: Salvar Evidence
            W->>B: Investigar causa raiz
            B-->>W: Hipóteses candidatas
            W->>DB: Salvar diagnóstico e hipóteses reativas
        end
    end

    W->>DB: AnalysisRun = SUCCEEDED
    W->>Q: Confirmar mensagem
    U->>UI: Acessar dashboard
    Note over U,API: Autenticação federada conforme DS-02A
    UI->>API: Consultar visão geral ou diagnóstico
    alt Janela contida nos últimos 30 dias
        API->>DB: Consultar modelos de leitura quentes
        DB-->>API: Incidente, previsão, evidências e hipóteses
    else Janela inclui período histórico
        API->>ATH: Consultar partições Parquet da versão ativa
        ATH->>GLUE: Resolver schema e partições
        GLUE-->>ATH: Metadados catalogados
        ATH->>S3: Ler arquivos Parquet
        S3-->>ATH: Dados históricos
        ATH-->>API: Séries e indicadores históricos
    end
    API-->>UI: DTO público
    UI-->>U: Exibir resultado e revisão pendente
    U->>UI: Confirmar, refutar ou marcar hipótese como inconclusiva
    UI->>API: PATCH review com key e expectedVersion

    alt Hipótese confirmada
        API->>DB: TransactWriteItems
        Note over API,GS: Na mesma transação: atualizar hipótese, auditar,<br/>salvar idempotência e criar GoldenCase
        API-->>UI: HTTP 200 - CONFIRMED
    else Hipótese refutada
        API->>DB: Transação condicional sem promoção
        Note over API,DB: Registrar causa alternativa quando informada
        API-->>UI: HTTP 200 - REFUTED
    else Hipótese inconclusiva
        API->>DB: Registrar decisão revisável sem promoção
        API-->>UI: HTTP 200 - INCONCLUSIVE
    end

    UI-->>U: Exibir decisão registrada e seu estado
```

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;Na primeira parte, o DS-01A detalha a sincronização do MySQL e o DS-01B detalha a importação de snapshots. Depois da publicação na fila, o DS-03A descreve a previsão horária, o DS-03B apresenta a detecção de incidentes e o DS-03C mostra a recuperação de falhas. A interação do usuário é aprofundada no DS-02A, para autenticação e consulta, no DS-02B, para revisão de hipóteses, e no DS-02C, para avaliação posterior a uma correção externa.

&emsp;Ao final do percurso, até 30 dias da janela ingerida estão disponíveis no DynamoDB e os 11 meses anteriores permanecem em Parquet no S3, sob o mesmo `datasetVersion`. Uma previsão continua distinta de um incidente observado, enquanto uma anomalia pode criar ou reforçar um incidente. As hipóteses permanecem pendentes até a decisão humana e somente as confirmadas passam a integrar o conjunto de referência; decisões refutadas podem registrar a causa alternativa informada, e decisões inconclusivas permanecem revisáveis. O `traceId`, identificador de correlação propagado entre os componentes, permite acompanhar uma execução ao longo de todo o fluxo.

### 5.7 Rastreabilidade interna

&emsp;Para evitar que os processos técnicos sejam interpretados como casos de uso independentes, a Tabela x registra a natureza de cada relação. Ela também resume a principal decisão arquitetural demonstrada por cada diagrama.

<div align="center">

<strong>Tabela x: Rastreabilidade dos diagramas de sequência</strong>

</div>

| Diagrama | Casos de uso | Natureza da relação | Decisão principal |
| --- | --- | --- | --- |
| DS-01A | UC-01, UC-03, UC-04, UC-06, UC-07 | Suporte técnico | Persistência operacional e arquivamento histórico da telemetria |
| DS-01B | UC-01, UC-03, UC-04, UC-06, UC-07 | Suporte técnico | Upload no S3, MySQL temporário no Fargate e ativação versionada |
| DS-02A | UC-01, UC-02 | Realização | SSO federado com Backend for Frontend |
| DS-02B | UC-03, UC-04 | Realização | Concorrência otimista, auditoria e promoção transacional |
| DS-02C | UC-05 | Realização | Comparação auditável de janelas equivalentes sem inferência indevida de causalidade |
| DS-03A | UC-06 | Suporte técnico | Previsão horária e validação posterior |
| DS-03B | UC-03, UC-04, UC-06 | Suporte técnico | Detecção a cada 15 minutos e diagnóstico por IA |
| DS-03C | UC-04, UC-07 | Exceção e alternativa | Repetição controlada, DLQ e reanálise |
| DS-04 | UC-01, UC-02, UC-03, UC-04, UC-06 | Síntese | Continuidade do dado até a decisão humana |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

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
