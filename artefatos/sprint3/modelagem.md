# Modelagem do Sistema

> Este documento apresenta a modelagem estrutural e comportamental do View Show por meio de diagramas UML e descrições textuais. A modelagem foi construída com base nos requisitos funcionais, não funcionais e decisões arquiteturais do projeto.

## Sumário

1. [Introdução](#1-introdução)
2. [Diagrama de casos de uso](#2-diagrama-de-casos-de-uso)
3. [Descrições dos casos de uso](#3-descrições-dos-casos-de-uso)
4. [Diagrama de classes](#4-diagrama-de-classes)
5. [Diagramas de sequência](#5-diagramas-de-sequência)
6. [Rastreabilidade da modelagem](#6-rastreabilidade-da-modelagem)
7. [Referências](#7-referências)

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

A modelagem de casos de uso contempla a aplicação web interna do View Show, utilizada por equipes do Globoplay para consultar telemetria, analisar incidentes, investigar falhas técnicas e acompanhar a qualidade da experiência (QoE). O recorte corresponde às telas de Login, Visão Geral, Incidentes, Evidências, Eventos, Monitoramento e Importações previstas para o MVP. O recorte também contempla o ponto de entrada dos dados: a sincronização e a normalização dos registros do ARGUS (UC-08), iniciada por um ator técnico, e o início manual de uma importação pelo operador (UC-09), pois RF01, RF02, RF03 e RIE02 definem contratos observáveis que não podem ficar sem representação.

Não fazem parte da modelagem de casos de uso:

- a emissão de telemetria pelos frontends do Globoplay ao ARGUS, sistema interno da Globo fora da fronteira do View Show;
- os processos internos de enfileiramento, publicação em fila e armazenamento posteriores à normalização (SQS, DLQ, Glue, Athena, S3);
- a execução de correções, deploys ou rollbacks em produção.

Esses elementos viabilizam o produto, mas não constituem objetivos iniciados diretamente pelos atores na interface. A observação da integridade dos dados de telemetria, por sua vez, integra o escopo funcional porque subsidia a avaliação da confiabilidade das análises apresentadas pelo View Show.

### 1.3 Convenções adotadas

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

&emsp;Um ator representa um papel exercido na interação com o sistema, e não uma pessoa específica. O papel **Usuário corporativo** foi definido como abstrato para concentrar as capacidades comuns de acesso e consulta. Analista de Atendimento Técnico N1, Engenheira de Software e Product Manager especializam esse papel e acrescentam objetivos próprios de suas responsabilidades. O provedor de identidade é mantido como ator secundário porque participa da troca de informações necessária à autenticação, embora esteja fora da fronteira do View Show. O temporizador de sincronização (EventBridge) é um ator técnico e primário: ele, não um usuário final, inicia periodicamente a sincronização dos dados do ARGUS, que por sua vez é um ator secundário e externo — o sistema interno da Globo que já recebe a telemetria emitida pelos frontends do Globoplay, fora da fronteira do View Show.

<div align="center">

<sup>Tabela 1: Atores do diagrama de casos de uso e suas responsabilidades principais</sup>

| ID | Ator | Tipo | Responsabilidade principal |
| --- | --- | --- | --- |
| AT-01 | Usuário corporativo | Primário, abstrato | Acessar o View Show e consultar informações comuns aos perfis autorizados. |
| AT-02 | Analista de Atendimento Técnico N1 | Especialização de AT-01 | Priorizar incidentes e revisar as hipóteses apresentadas pelo sistema. |
| AT-03 | Engenheira de Software | Especialização de AT-01 | Validar hipóteses, investigar falhas, avaliar recuperações e monitorar a telemetria. |
| AT-04 | Product Manager | Especialização de AT-01 | Analisar QoE, priorizar problemas e avaliar resultados posteriores a correções. |
| AT-05 | Provedor de identidade/SSO | Secundário | Autenticar a conta corporativa e devolver a identidade validada. |
| AT-06 | Temporizador de sincronização (EventBridge) | Primário, técnico | Iniciar periodicamente a sincronização dos dados operacionais do ARGUS. |
| AT-07 | ARGUS | Secundário, externo | Fornecer os dados operacionais já recebidos dos frontends do Globoplay, consumidos por leitura (MySQL) pelo Serviço de Ingestão. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 2.2 Catálogo de casos de uso

&emsp;O catálogo apresenta nove objetivos observáveis dos atores do View Show. Cada caso de uso reúne as interações que conduzem a um resultado relevante para o ator principal, desde o acesso ao sistema até a análise de incidentes, a investigação técnica, a avaliação da qualidade da experiência, o acompanhamento da telemetria e a recepção dos eventos que alimentam essa telemetria.

<div align="center">

<sup>Tabela 2: Catálogo dos casos de uso do View Show e requisitos relacionados</sup>

| ID | Caso de uso | Ator principal | Requisitos relacionados |
| --- | --- | --- | --- |
| UC-01 | Consultar dashboard | Usuário corporativo | RF07, RF08, RF09, RF10, RNF07, RNF14 |
| UC-02 | Autenticar-se | Usuário corporativo | RF04, RNF04, RIE01, RESTR01 |
| UC-03 | Analisar incidente | Analista de Atendimento Técnico N1 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 |
| UC-04 | Investigar falha técnica | Engenheira de Software | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 |
| UC-05 | Avaliar recuperação após correção | Engenheira de Software e Product Manager | RF07, RF08, RF09, RNF05, RNF14 |
| UC-06 | Analisar qualidade da experiência | Product Manager | RF07, RF08, RF09, RNF05, RNF14, RNF15 |
| UC-07 | Monitorar a telemetria | Engenheira de Software | RF07, RF08, RNF01, RNF02, RNF03, RNF09, RNF15 |
| UC-08 | Sincronizar e normalizar dados do ARGUS | Temporizador de sincronização (EventBridge) | RF01, RF02, RF03, RIE02 |
| UC-09 | Iniciar importação manual de snapshot do ARGUS | Operador de dados (Engenheira de Software) | RF01, RF02, RF03, RNF04, RIE02 |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;A consulta ao dashboard abrange a aplicação de filtros e a exportação de resultados. A análise de incidentes compreende a priorização das ocorrências, a consulta das hipóteses e evidências e o registro da avaliação humana. A investigação técnica aprofunda a inspeção de eventos e as comparações entre recortes. Os demais casos tratam da avaliação posterior a correções, da análise agregada de QoE, da verificação da integridade das fontes e do processamento da telemetria e, por fim, da sincronização e normalização dos dados do ARGUS, que é o ponto de entrada de dados sobre o qual todos os demais casos de uso operam. Diferentemente dos demais, o UC-08 não é iniciado por um usuário final: seu ator principal é um temporizador técnico, o que o qualifica como subfunção de suporte. O UC-09 separa a etapa observável iniciada pelo operador — validar o snapshot, reservar a importação e preparar o upload — do processamento assíncrono posterior descrito no UC-08.

### 2.3 Diagrama

&emsp;A Figura 1 sintetiza a fronteira funcional do View Show e as associações entre os atores e seus objetivos. Os pormenores de cada interação permanecem nas descrições textuais para que a representação visual conserve a função de oferecer uma visão geral do sistema.

<div align="center">

<sup>Figura 1: Casos de uso do View Show — fronteira funcional do sistema e associações entre os atores e seus objetivos</sup>

```mermaid
flowchart LR
    U[Usuário corporativo] --> UC01([UC-01 Consultar dashboard])
    U --> UC02([UC-02 Autenticar-se])
    N1[Analista N1] --> UC03([UC-03 Analisar incidente])
    ENG[Engenheira de Software] --> UC04([UC-04 Investigar falha técnica])
    ENG --> UC05([UC-05 Avaliar recuperação])
    ENG --> UC07([UC-07 Monitorar telemetria])
    ENG --> UC09([UC-09 Iniciar importação manual])
    PM[Product Manager] --> UC05
    PM --> UC06([UC-06 Analisar QoE])
    SSO[Provedor de identidade] --> UC02
    TIMER[Temporizador] --> UC08([UC-08 Sincronizar e normalizar ARGUS])
    ARGUS[ARGUS] --> UC08
    UC09 -. extensão manual .-> UC08
```

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 2.4 Critérios de construção e leitura

&emsp;A fronteira **Sistema View Show** contém as funcionalidades percebidas pelos atores durante o uso da aplicação. A sincronização e a normalização dos dados do ARGUS constituem um objetivo observável, iniciado por um ator técnico (o temporizador de sincronização) em vez de por um usuário final; por isso, são representadas separadamente em UC-08, no nível de subfunção. A emissão de telemetria pelos frontends do Globoplay para o ARGUS ocorre fora da fronteira do View Show e não é modelada: o ARGUS é o ator que já recebeu essa telemetria e fornece os dados consumidos por UC-08. Já o enfileiramento, a publicação assíncrona e o armazenamento posteriores à normalização (SQS, DLQ, Glue, Athena, S3) são processos internos que não são iniciados por nenhum ator e, por isso, não são representados como caso de uso — eles aparecem apenas nos diagramas de sequência da Seção 5, como suporte técnico ao UC-08.

&emsp;Operações como filtrar resultados, consultar evidências e comparar períodos são descritas nos fluxos dos casos de uso aos quais dão suporte. A avaliação de recuperação constitui um objetivo independente porque ocorre após uma intervenção externa e produz como resultado uma comparação entre janelas temporais equivalentes.

&emsp;A autenticação é representada como um caso de uso próprio devido à participação do provedor corporativo de identidade. Nos demais casos, a existência de uma sessão válida é estabelecida como pré-condição.

### 2.5 Relações principais

&emsp;A Tabela 3 apresenta as associações entre atores e casos de uso e as relações de generalização entre os perfis especializados e o Usuário corporativo. As associações identificam os objetivos iniciados por cada ator, enquanto as generalizações indicam o compartilhamento das capacidades comuns de acesso e consulta.

<div align="center">

<sup>Tabela 3: Relações de generalização e associação representadas no diagrama de casos de uso</sup>

| Origem | Relação | Destino | Justificativa |
| --- | --- | --- | --- |
| AT-02 | Generalização | AT-01 | O Analista N1 também executa os objetivos comuns de um usuário corporativo. |
| AT-03 | Generalização | AT-01 | A Engenheira de Software também executa os objetivos comuns. |
| AT-04 | Generalização | AT-01 | A Product Manager também executa os objetivos comuns. |
| AT-01 | Associação | UC-01 e UC-02 | Todo perfil autorizado pode autenticar-se e consultar o dashboard. |
| AT-02 | Associação | UC-03 | O Analista N1 prioriza o incidente, consulta as evidências e avalia a hipótese apresentada. |
| AT-03 | Associação | UC-04, UC-05, UC-07 e UC-09 | A Engenheira investiga falhas, avalia a recuperação, monitora a telemetria e, no papel de operadora de dados, inicia uma importação manual. |
| AT-04 | Associação | UC-05 | A Product Manager avalia os indicadores posteriores a uma correção. |
| AT-04 | Associação | UC-06 | A Product Manager inicia a análise de QoE. |
| AT-05 | Associação | UC-02 | O provedor externo participa da autenticação corporativa. |
| AT-06 | Associação | UC-08 | O temporizador inicia periodicamente a sincronização dos dados do ARGUS. |
| AT-07 | Associação | UC-08 | O ARGUS fornece os dados operacionais consumidos pela sincronização. |
| UC-09 | Extensão | UC-08 | A importação manual fornece ao UC-08 uma origem alternativa ao sincronismo periódico, encerrando quando o upload multipart está preparado. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

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

> **Divergência tecnológica/temporária.** Este caso de uso descreve o modelo-alvo, com o Cognito federado ao SSO corporativo da Globo por OIDC/SAML. No runtime atual, a autenticação ocorre por login direto de usuário e senha no Cognito, e as rotas federadas retornam `503`, até a convergência para o modelo aqui descrito.

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

- **4a. Nenhuma hipótese disponível:** o sistema informa que a causa permanece inconclusiva, sem uma hipótese a ser confirmada, refutada ou reavaliada. O fluxo segue para o passo 4a.1.
  - **4a.1. Registro de causa sem revisão de hipótese:** o analista pode informar diretamente uma causa conhecida e sua justificativa, sem que exista uma hipótese a ser revisada. O fluxo segue para o passo 9.
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

- O histórico deve observar até 30 dias em armazenamento de acesso rápido e
  uma política de retenção de até 12 meses; a disponibilidade é dada pelos
  intervalos registrados no manifesto, conforme RNF05.
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

### 3.8 UC-08 — Sincronizar e normalizar dados do ARGUS

&emsp;Este caso de uso descreve como o View Show obtém os dados que sustentam todos os demais objetivos do sistema. Periodicamente, o Serviço de Ingestão lê os registros operacionais do ARGUS — sistema interno da Globo que já recebe a telemetria emitida pelos frontends do Globoplay —, normaliza-os para o esquema interno padronizado e os disponibiliza às demais análises. Um operador de dados pode complementar essa sincronização com a importação manual de um snapshot do ARGUS, sem interromper o conjunto de dados vigente.

#### Escopo

Sistema View Show.

#### Nível

Subfunção (processo técnico de suporte, iniciado por um temporizador, não por um usuário final).

#### Atores

- **Ator principal:** Temporizador de sincronização (EventBridge).
- **Atores secundários:** ARGUS (fonte dos dados operacionais) e Operador de dados — papel exercido por um Usuário corporativo com a permissão `data:import`, tipicamente a Engenheira de Software — no fluxo alternativo de importação manual de snapshot.

#### Requisitos relacionados

- **RF01 — Ingestão de eventos multiplataforma:** os registros já cobrem dispositivos e plataformas distintas porque o ARGUS os recebeu previamente de toda a base instalada do Globoplay.
- **RF02 — Ingestão de eventos:** recebimento e armazenamento dos eventos publicados pelas aplicações frontend do Globoplay, realizado indiretamente pela leitura periódica do ARGUS.
- **RF03 — Normalização dos dados:** normalização dos registros lidos do ARGUS, independentemente do protocolo ou formato de origem, para o formato padronizado interno antes da persistência.
- **RIE02 — Frontends do Globoplay (Smart TV, mobile, web):** contrato original de uma API de ingestão que recebe eventos diretamente dos frontends; hoje satisfeito indiretamente, pois o ARGUS já implementa esse recebimento fora da fronteira do View Show (ver nota de substituição tecnológica abaixo).

#### Interessados e interesses

- **Engenharia:** dispor de dados normalizados, atualizados e auditáveis, com baixa necessidade de intervenção manual.
- **Globo:** preservar a fidelidade dos dados do ARGUS na sincronização periódica, com uma via de reprocessamento por snapshot quando necessário.
- **Demais atores do View Show:** dependem indiretamente deste caso de uso, pois todas as análises partem dos dados aqui sincronizados.

#### Pré-condições

- O ARGUS está acessível pela rede privada autorizada, ou um snapshot válido foi fornecido por um operador de dados.

#### Pós-condições

- **Em caso de sucesso:** os registros novos ou alterados do ARGUS estão normalizados, persistidos no DynamoDB (ou arquivados no S3 quando ultrapassam a janela quente) e as solicitações de análise correspondentes foram publicadas na fila.
- **Garantia mínima:** nenhum evento é publicado na fila sem que seu registro tenha sido persistido antes; uma sincronização concorrente não corrompe o checkpoint nem duplica o processamento de uma mesma janela.

#### Fluxo Básico

1. O temporizador inicia a sincronização periódica.
2. O sistema adquire um bloqueio temporário para a execução.
3. O sistema obtém as credenciais do ARGUS e conecta-se pela rede privada.
4. O sistema lê os registros do ARGUS a partir do último checkpoint.
5. O sistema valida e normaliza cada registro para o esquema interno padronizado.
6. O sistema persiste os registros novos ou alterados e atualiza o checkpoint.
7. O sistema publica na fila as solicitações de análise decorrentes da janela sincronizada.
8. O sistema libera o bloqueio e registra a execução.

#### Fluxos alternativos

- **1a. Importação manual de snapshot:** um operador de dados envia, pela interface, um snapshot do ARGUS. O sistema restaura o snapshot em um banco temporário isolado e segue a partir do passo 4 sobre esse snapshot, ativando a nova versão do conjunto de dados ao final sem interromper o conjunto vigente.
- **2a. Bloqueio já adquirido por outra execução:** o sistema encerra a execução como ignorada e não altera checkpoint nem watermark. O fluxo termina.
- **3a. Schema do ARGUS incompatível:** o sistema registra falha permanente e não avança checkpoint nem watermark. O fluxo termina.
- **7a. Falha ao publicar um item na fila:** o item permanece pendente e é republicado pela execução seguinte com a mesma chave de idempotência.

#### Requisitos especiais

- Cobertura de plataformas heterogêneas preservada por herança do ARGUS, conforme RF01: o View Show não reprocessa o protocolo de origem do dispositivo, apenas os registros já recebidos.
- Nenhuma publicação na fila ocorre para um registro que ainda não foi persistido, preservando a garantia comportamental de RIE02 (confirmação apenas após persistência) mesmo sem uma API de recebimento própria.
- A importação manual de snapshot exige a permissão `data:import`.

#### Lista de variantes

- **1a. Origem da sincronização:** automática, pelo temporizador, ou manual, por snapshot enviado por um operador de dados.
- **5a. Tipo de evento normalizado:** `request`, `vitals`, `screen_view`, `video_view`, `session` ou `error`.

#### Frequência de ocorrência

A cada 15 minutos, automaticamente; a importação manual ocorre sob demanda, tipicamente para reprocessamento ou recuperação.

#### Problemas em aberto

- Qual granularidade de erro deve ser reportada ao operador quando um snapshot falha na restauração?
- O ARGUS deve continuar sendo a única fonte de dados, ou o View Show deverá, no futuro, expor uma API de recebimento direto dos frontends, como originalmente descrito em RIE02?

> **Substituição tecnológica documentada.** RIE02 descreve originalmente uma API de ingestão que recebe eventos diretamente dos frontends do Globoplay e confirma o recebimento somente após a publicação na fila. A arquitetura-alvo substitui esse contrato por um modelo de leitura periódica do ARGUS — sistema interno da Globo que já recebe essa telemetria antes do View Show, fora de sua fronteira. A garantia comportamental de RIE02 (nenhuma confirmação sem persistência prévia) é preservada pelo par checkpoint + outbox transacional do Serviço de Ingestão (DS-01A), mesmo sem uma API de recebimento própria dos frontends.

### 3.9 UC-09 — Iniciar importação manual de snapshot do ARGUS

&emsp;Este caso de uso especializa a entrada manual prevista no fluxo 1a do UC-08. Seu término ocorre quando o sistema aceita o snapshot e prepara de forma durável o upload multipart; restauração, normalização e ativação são assíncronas e permanecem no UC-08. Essa separação torna explícito o objetivo observável do operador e permite verificar integralmente suas entradas, exceções e pós-condições sem declarar que o processamento posterior já terminou.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário, extensão operacional do UC-08.

#### Atores

- **Ator principal:** Operador de dados, papel exercido pela Engenheira de Software autenticada.
- **Atores secundários:** armazenamento de snapshots e repositório operacional.

#### Requisitos relacionados

- **RF01 — Ingestão de eventos multiplataforma:** o snapshot preserva registros oriundos das plataformas atendidas pelo ARGUS.
- **RF02 — Ingestão de eventos:** a importação manual oferece uma origem controlada para reprocessamento ou recuperação.
- **RF03 — Normalização dos dados:** o snapshot aceito será normalizado pelo processamento assíncrono do UC-08.
- **RNF04 — Segurança e confidencialidade:** somente uma sessão autenticada pode iniciar a operação.
- **RIE02 — Entrada da telemetria:** a importação preserva a origem ARGUS adotada pela arquitetura.

#### Pré-condições

- O operador possui uma sessão autenticada.
- O snapshot está disponível localmente como `argus_dump.sql.gz` ou como arquivo `.zip` sem componentes de caminho.
- Não existe outra importação ativa, exceto quando a chamada repete a mesma chave de idempotência.

#### Pós-condições

- **Em caso de sucesso:** existe exatamente um `ImportJob` no estado `UPLOADING`, associado ao operador e aos metadados validados; a vaga global está reservada e existe exatamente um upload multipart preparado no armazenamento.
- **Garantia mínima:** uma entrada inválida ou uma requisição não autenticada não cria `ImportJob` nem upload multipart; uma tentativa concorrente não substitui a importação ativa; repetir a mesma solicitação com a mesma chave de idempotência devolve o mesmo `ImportJob` sem criar outro multipart.

#### Fluxo básico

1. O operador abre a importação manual e seleciona `argus_dump.sql.gz`.
2. O operador informa a data civil de extração do snapshot e confirma o envio.
3. O sistema valida sessão, chave de idempotência, nome, data e tamanho do arquivo.
4. O sistema reserva de forma exclusiva a importação ativa e registra o `ImportJob` como `PREPARING`.
5. O sistema prepara um upload multipart no armazenamento.
6. O sistema registra a geometria do upload e transiciona o `ImportJob` para `UPLOADING`.
7. O sistema devolve ao operador o identificador e o estado público da importação, sem expor identificadores físicos do armazenamento.

#### Fluxos alternativos

- **1a. Snapshot ZIP:** o operador seleciona um arquivo `.zip`; o fluxo segue no passo 2, aplicando o limite próprio do ZIP.
- **4a. Repetição idempotente:** já existe uma importação criada pelo mesmo operador com a mesma chave de idempotência; o sistema devolve o `ImportJob` original e segue para o passo 7 sem criar outro multipart.

#### Fluxos de exceção

- **3a. Sessão ausente ou inválida:** o sistema responde `401 UNAUTHENTICATED`; o fluxo termina sem efeitos persistentes.
- **3b. Chave de idempotência ausente ou inválida:** o sistema responde `400 VALIDATION_ERROR`; o fluxo termina sem criar importação ou multipart.
- **3c. Nome, tamanho ou data inválidos:** o sistema responde `400 VALIDATION_ERROR`; o fluxo termina sem criar importação ou multipart.
- **4b. Outra importação em andamento:** o sistema responde `409 IMPORT_IN_PROGRESS`, preserva a importação ativa e não cria outro multipart.
- **4c. Estado ativo não pode ser confirmado após uma disputa:** o sistema responde `503 DATA_UNAVAILABLE` sem expor a falha interna.
- **5a. Falha ao preparar o upload:** o sistema não informa sucesso; registra a preparação como falha quando consegue adquirir a cerca de versão e deixa a limpeza para reconciliação quando o resultado da escrita é incerto.

#### Requisitos especiais e limites

- `argus_dump.sql.gz`: tamanho inteiro entre **1 byte e 5 GiB**, inclusive.
- `.zip`: nome com **1 a 251 caracteres antes da extensão**, sem `/` ou `\`, e tamanho inteiro entre **1 byte e 10 GiB**, inclusive.
- O corpo inicial da requisição tem limite de **64 KiB**.
- A data de extração deve ser uma data civil real no formato `YYYY-MM-DD`.
- Toda tentativa de criação deve possuir uma chave de idempotência válida.
- A resposta pública não deve expor `uploadId`, bucket, chave física, URL assinada ou checksum interno.

#### Lista de variantes

- **1a. Formato do snapshot:** GZIP canônico ou ZIP que contenha o dump do ARGUS.
- **3a. Limite por formato:** 5 GiB para GZIP e 10 GiB para ZIP.

#### Frequência de ocorrência

Sob demanda, para carga inicial, reprocessamento ou recuperação de dados.

### 3.10 Síntese das descrições

&emsp;As nove narrativas delimitam os objetivos dos atores e os resultados que o View Show deve oferecer. O UC-08 descreve uma subfunção técnica iniciada por um temporizador; o UC-09 torna explícito o objetivo operacional do usuário que inicia a alternativa manual de snapshot e termina antes do processamento assíncrono. Os fluxos básicos descrevem os cenários de sucesso, enquanto os fluxos alternativos e de exceção registram indisponibilidades, entradas inválidas, concorrência e demais condições que modificam o percurso principal.

&emsp;A descrição em caixa-preta mantém o foco nas responsabilidades observáveis do sistema, conforme a abordagem de Larman (2007). Dessa forma, os casos de uso fornecem uma base comum para a análise dos requisitos, a definição das interações e a verificação posterior do comportamento esperado.

---

## 4. Diagrama de classes

### 4.1. Objetivo e escopo

&emsp;Esta seção modela exclusivamente a arquitetura-alvo final do View Show, alinhada aos casos de uso da Seção 2 e aos diagramas de sequência da Seção 5 deste documento. As classes, os estados e os relacionamentos representados aqui não são derivados dos arquivos, rotas ou módulos hoje presentes no repositório: eles descrevem a solução aprovada para implementação, independentemente do que já foi construído.

&emsp;Elementos transitórios do protótipo — autenticação local, hash de senha, nomes de arquivos e módulos atuais, o schema v1/v2 da tabela operacional e demais limitações momentâneas da implementação — não são modelados nesta seção, por descreverem um estágio intermediário e não a solução-alvo.

&emsp;A modelagem é dividida em três visões complementares, para não misturar conceitos de natureza diferente na mesma figura:

- **Visão de domínio** (4.2.1): as entidades e os objetos de valor que persistem através do tempo de vida de um incidente, de uma previsão ou de uma importação, independentemente de qual componente os manipula.
- **Visão de aplicação** (4.2.2): os serviços e as fronteiras que operam sobre o domínio — a API do dashboard, o Worker de Análise, a autorização e os repositórios.
- **Visão de persistência** (4.2.3): o mapeamento entre as classes de domínio e as camadas físicas de armazenamento (DynamoDB, S3/Parquet, Glue e Athena), sem transformar esses componentes de infraestrutura em classes de domínio.

&emsp;O Serviço de Ingestão e seus registros canônicos (`SignalObservation`, `DimensionalMetricAggregate`, `Incident` físico) possuem contrato técnico próprio; nesta seção, a Ingestão aparece apenas como fronteira de serviço na visão de aplicação, para não duplicar esse contrato. O frontend permanece fora do escopo porque apenas consome a API do dashboard.

### 4.2. Diagramas

#### 4.2.1. Modelo de domínio

<div align="center">

<sup>Figura 2: Modelo de domínio do View Show — entidades, objetos de valor, atributos e relacionamentos</sup>

</div>

```mermaid
classDiagram
    direction TB

    class Operador {
        <<entidade de domínio>>
        +id: String
        +email: String
        +name: String
        +groups: String[]
        +possuiPermissao(permissao: String) Boolean
    }

    class Incidente {
        <<entidade de domínio>>
        +id: String
        +number: String?
        +title: String
        +priority: String
        +status: String
        +startedAt: DateTime
        +detectedAt: DateTime
        +endedAt: DateTime?
        +transicionarPara(novoStatus: String) void
    }

    class Evidencia {
        <<entidade de domínio>>
        +id: String
        +type: String
        +statement: String
        +relation: String
        +strength: String
        +observedAt: DateTime
    }

    class Diagnostico {
        <<entidade de domínio>>
        +id: String
        +status: String
        +summary: String?
        +confidence: Number?
        +generatedAt: DateTime?
        +marcarPronto(hipoteses: Hipotese[]) void
        +marcarFalha(motivo: String) void
    }

    class Hipotese {
        <<entidade de domínio>>
        +id: String
        +rank: Number
        +statement: String
        +probability: Number
        +rationale: String
        +registrarDecisao(status: String, note: String?, correctedCause: String?, expectedVersion: Number) AuditoriaRevisao
    }

    class DecisaoRevisao {
        <<objeto de valor>>
        +status: String
        +note: String?
        +correctedCause: String?
        +reviewedAt: DateTime?
        +version: Number
    }

    class AuditoriaRevisao {
        <<entidade de domínio>>
        <<imutável>>
        +id: String
        +previousStatus: String?
        +newStatus: String
        +note: String?
        +correctedCause: String?
        +version: Number
        +recordedAt: DateTime
    }

    class GoldenCase {
        <<entidade de domínio>>
        +id: String
        +statement: String
        +sourceHypothesisId: String?
        +confirmedAt: DateTime
    }

    class Previsao {
        <<entidade de domínio>>
        +id: String
        +predictedValue: Number
        +riskScore: Number
        +riskLevel: String
        +modelVersion: String
        +classificationOutcome: String?
        +classificarResultado(valorObservado: Number) String
    }

    class Janela {
        <<objeto de valor>>
        +start: DateTime
        +end: DateTime
        +grainSeconds: Number
    }

    class AvaliacaoRecuperacao {
        <<entidade de domínio>>
        +id: String
        +milestoneAt: DateTime
        +variation: Number
        +conclusion: String
        +note: String?
        +recordedAt: DateTime
        +classificarRecuperacao() String
    }

    class ImportJob {
        <<entidade de domínio>>
        +id: String
        +status: String
        +stage: String
        +error: String?
        +createdBy: String
        +createdAt: DateTime
        +completionRequestedBy: String?
        +completionRequestedAt: DateTime?
        +activatedBy: String?
        +activatedAt: DateTime?
        +avancarEtapa(stage: String) void
        +concluir(datasetVersion: DatasetVersion, activatedBy: String) void
        +falhar(erro: String) void
    }

    class DatasetVersion {
        <<objeto de valor>>
        +id: String
    }

    class Manifesto {
        <<entidade de domínio>>
        +hotFrom: DateTime
        +hotThrough: DateTime
        +archivePrefix: String
        +apontarVersaoAtiva(versao: DatasetVersion) void
    }

    class AnalysisRun {
        <<entidade de domínio>>
        +id: String
        +eventType: String
        +idempotencyKey: String
        +status: String
        +attemptCount: Number
        +confirmarSucesso() void
        +registrarTentativa(erro: String?) void
    }

    Operador "1" -- "0..*" ImportJob : cria e conclui
    Operador "1" -- "0..*" AuditoriaRevisao : registra
    Operador "1" -- "0..*" AvaliacaoRecuperacao : registra
    Incidente "1" --> "0..*" Evidencia : reúne
    Incidente "1" --> "0..1" Diagnostico : produz
    Incidente "1" --> "0..*" AvaliacaoRecuperacao : é avaliado por
    Previsao "1" --> "0..1" Diagnostico : produz
    Diagnostico "1" --> "0..*" Hipotese : ordena por confiança quando ready
    Hipotese "1" --> "0..*" Evidencia : associa
    Hipotese "1" *-- "1" DecisaoRevisao : estado atual
    Hipotese "1" --> "0..*" AuditoriaRevisao : histórico imutável
    AuditoriaRevisao "1" ..> "0..1" GoldenCase : confirmed cria
    Previsao "1" *-- "1" Janela : targetWindow
    AvaliacaoRecuperacao "1" *-- "1" Janela : janela base
    AvaliacaoRecuperacao "1" *-- "1" Janela : janela de comparação
    Incidente "1" --> "1" DatasetVersion : pertence a
    Previsao "1" --> "1" DatasetVersion : pertence a
    ImportJob "1" --> "1" DatasetVersion : ativa candidata
    Manifesto "1" --> "1" DatasetVersion : aponta versão ativa
    AnalysisRun "1" --> "0..1" Incidente : correlaciona ou cria
    AnalysisRun "1" --> "0..1" Previsao : produz
```

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;A Figura 2 apresenta as entidades e os objetos de valor do modelo de domínio, com seus atributos, operações e relacionamentos. A responsabilidade de cada elemento é detalhada na Tabela 5 (item 4.3.1); os estados e as transições relevantes estão na Tabela 7 (item 4.3.3); e as regras, garantias e invariantes que regem o comportamento dessas classes estão consolidadas na Tabela 9 (item 4.5).

#### 4.2.2. Serviços e fronteiras da aplicação

<div align="center">

<sup>Figura 3: Serviços e fronteiras da arquitetura-alvo, organizados por namespace</sup>

</div>

```mermaid
classDiagram
    direction TB

    namespace APIDashboard {
        class AutenticacaoSessaoB {
            <<interface>>
            +obterSessao() Sessao
            +iniciarLogin() RedirectUrl
            +concluirCallback(code: String, state: String) Sessao
            +encerrarSessao() void
        }
        class VisaoGeralIncidentesEventosB {
            <<interface>>
            +consultarVisaoGeral() VisaoGeralDTO
            +consultarIncidente(incidentId: String) IncidenteDTO
            +consultarDiagnostico(incidentId: String) DiagnosticoDTO
        }
        class RevisaoHipoteseB {
            <<interface>>
            +revisarHipotese(hypothesisId: String, status: String, expectedVersion: Number, idempotencyKey: String) DecisaoRevisao
        }
        class ImportacaoDumpB {
            <<interface>>
            +iniciarImportacao() ImportJob
            +concluirImportacao(importId: String, idempotencyKey: String) ImportJob
            +consultarImportacao(importId: String) ImportJob
        }
        class ReanaliseB {
            <<interface>>
            +solicitarReanalise(alvoId: String) AnalysisRun
        }
        class MonitoramentoB {
            <<interface>>
            +consultarSaudeTelemetria(window: String, source: String[], worker: String[]) MonitoringOverviewDTO
        }
    }

    namespace ServicosDeAplicacao {
        class ServicoAutorizacao {
            <<control>>
            +resolverSessao(cookie: String) Operador
            +verificarPermissao(operador: Operador, permissao: String) Boolean
        }
        class ServicoImportacao {
            <<control>>
            +criarImportJob(operador: Operador) ImportJob
            +concluirUpload(importJob: ImportJob, operador: Operador, idempotencyKey: String) ImportJob
        }
        class ServicoRevisao {
            <<control>>
            +aplicarDecisao(hipotese: Hipotese, status: String, expectedVersion: Number, operador: Operador) AuditoriaRevisao
            +promoverGoldenCase(auditoria: AuditoriaRevisao) GoldenCase
        }
    }

    namespace WorkerDeAnalise {
        class AnalysisOrchestrator {
            <<control>>
            +orquestrarAnalise(mensagem: AnalysisRun) void
        }
        class AnomalyDetector {
            <<control>>
            +detectarAnomalia(janela: Janela) Boolean
        }
        class QoEForecastModel {
            <<control>>
            +preverRisco(janela: Janela) Previsao
        }
        class DiagnosticAgent {
            <<control>>
            +diagnosticar(contexto: String) Hipotese[]
        }
    }

    namespace Repositorios {
        class RepositorioOperacional {
            <<repository>>
            +salvarIncidente(incidente: Incidente) void
            +salvarImportJob(job: ImportJob) void
            +buscarDiagnostico(incidentId: String) Diagnostico
        }
        class RepositorioConjuntoReferencia {
            <<repository>>
            +salvarGoldenCase(caso: GoldenCase) void
            +listarGoldenCases() GoldenCase[]
        }
        class RepositorioHistorico {
            <<repository>>
            +consultarParticoes(datasetVersion: DatasetVersion, periodo: Janela) DimensionalMetricAggregate[]
        }
    }

    namespace TiposAuxiliares {
        class Sessao {
            <<value object>>
            +operador: Operador
            +expiresAt: DateTime
        }
        class RedirectUrl {
            <<value object>>
            +url: String
        }
        class VisaoGeralDTO {
            <<DTO>>
            +indicadores: DimensionalMetricAggregate[]
            +incidentesAbertos: Incidente[]
        }
        class IncidenteDTO {
            <<DTO>>
            +incidente: Incidente
            +evidencias: Evidencia[]
            +diagnostico: DiagnosticoDTO?
        }
        class DiagnosticoDTO {
            <<DTO>>
            +diagnostico: Diagnostico
            +hipoteses: Hipotese[]
        }
        class MonitoringOverviewDTO {
            <<DTO>>
            +cobertura: DimensionalMetricAggregate[]
            +degradacoes: String[]
        }
    }

    class Cognito {
        <<external>>
    }
    class AmazonBedrock {
        <<external>>
    }
    class SQSAnalise {
        <<external>>
    }
    class ECSFargate {
        <<external>>
    }
    class ServicoDeIngestao {
        <<external>>
    }

    AutenticacaoSessaoB ..> Sessao
    AutenticacaoSessaoB ..> RedirectUrl
    VisaoGeralIncidentesEventosB ..> VisaoGeralDTO
    VisaoGeralIncidentesEventosB ..> IncidenteDTO
    VisaoGeralIncidentesEventosB ..> DiagnosticoDTO
    MonitoramentoB ..> MonitoringOverviewDTO
    AutenticacaoSessaoB ..> ServicoAutorizacao
    VisaoGeralIncidentesEventosB ..> ServicoAutorizacao
    RevisaoHipoteseB ..> ServicoAutorizacao
    ImportacaoDumpB ..> ServicoAutorizacao
    ReanaliseB ..> ServicoAutorizacao
    MonitoramentoB ..> ServicoAutorizacao
    ServicoAutorizacao ..> Cognito

    RevisaoHipoteseB ..> ServicoRevisao
    ImportacaoDumpB ..> ServicoImportacao
    ReanaliseB ..> SQSAnalise

    ServicoRevisao ..> RepositorioOperacional
    ServicoRevisao ..> RepositorioConjuntoReferencia
    ServicoImportacao ..> ECSFargate
    ServicoImportacao ..> RepositorioOperacional
    VisaoGeralIncidentesEventosB ..> RepositorioOperacional
    VisaoGeralIncidentesEventosB ..> RepositorioHistorico
    MonitoramentoB ..> RepositorioOperacional

    ServicoDeIngestao ..> RepositorioOperacional
    ServicoDeIngestao ..> RepositorioHistorico
    ServicoDeIngestao ..> SQSAnalise

    AnalysisOrchestrator ..> SQSAnalise : consome
    AnalysisOrchestrator ..> AnomalyDetector
    AnalysisOrchestrator ..> QoEForecastModel
    AnalysisOrchestrator ..> DiagnosticAgent
    AnalysisOrchestrator ..> RepositorioOperacional
    AnalysisOrchestrator ..> RepositorioConjuntoReferencia : leitura
    DiagnosticAgent ..> AmazonBedrock
```

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;A Figura 3 apresenta os serviços e as fronteiras da arquitetura-alvo, organizados nos namespaces API do Dashboard, Serviços de Aplicação, Worker de Análise, Repositórios e Tipos auxiliares. A responsabilidade de cada elemento está detalhada na Tabela 6 (item 4.3.2), e suas dependências estão na Tabela 8 (item 4.4).

#### 4.2.3. Mapeamento de persistência

&emsp;A Tabela 4 liga cada classe de domínio à área de armazenamento física correspondente, sem promover tabelas, buckets ou filas a classes de domínio.

<div align="center">

<sup>Tabela 4: Mapeamento das classes de domínio para os repositórios e o armazenamento físico correspondente</sup>

| Classe de domínio | Repositório | Armazenamento físico |
|:---|:---|:---|
| <code>Incidente</code>, <code>Evidencia</code>, <code>Diagnostico</code>, <code>Hipotese</code> | Repositório operacional | DynamoDB <code>monitoracao-operacional</code> (até 30 dias) e arquivo Parquet no S3 para o período histórico da mesma <code>DatasetVersion</code> |
| <code>AuditoriaRevisao</code> | Repositório operacional | DynamoDB <code>monitoracao-operacional</code>, item de auditoria imutável anexo à hipótese |
| <code>AvaliacaoRecuperacao</code> | Repositório operacional | DynamoDB <code>monitoracao-operacional</code>, item vinculado ao incidente avaliado |
| <code>Previsao</code> | Repositório operacional | DynamoDB <code>monitoracao-operacional</code> |
| <code>ImportJob</code> | Repositório operacional | DynamoDB <code>monitoracao-operacional</code>, item de controle de importação, com <code>createdBy</code>, <code>completionRequestedBy</code> e <code>activatedBy</code> |
| <code>Manifesto</code> | Repositório operacional | DynamoDB <code>monitoracao-operacional</code>, item <code>CONTROL#DATASET/ACTIVE</code> |
| <code>GoldenCase</code> | Repositório do conjunto de referência | DynamoDB <code>monitoracao-golden-set</code>, sem TTL |
| <code>Operador</code> | Nenhum — identidade federada | Cognito federado ao SSO da Globo; o View Show não mantém tabela própria de contas nem credenciais |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 4.3. Descrição dos elementos

#### 4.3.1. Modelo de domínio

<div align="center">

<sup>Tabela 5: Elementos do modelo de domínio — tipo e responsabilidade de cada entidade e objeto de valor</sup>

| Elemento | Tipo | Responsabilidade |
|:---|:---|:---|
| <code>Operador</code> | Entidade de domínio | Identidade corporativa autenticada, portadora dos grupos que autorizam operações sensíveis como a importação de dump. |
| <code>Incidente</code> | Entidade de domínio | Agrupa uma degradação efetivamente observada, da detecção ao encerramento. |
| <code>Evidencia</code> | Entidade de domínio | Sinal que sustenta ou contesta uma hipótese diagnóstica. |
| <code>Diagnostico</code> | Entidade de domínio | Agrega de zero a muitas hipóteses candidatas de um incidente ou de uma previsão de risco elevado; permanece sem hipóteses enquanto não estiver <code>ready</code>. |
| <code>Hipotese</code> | Entidade de domínio | Causa provável ranqueada por confiança, sujeita a revisão humana. |
| <code>DecisaoRevisao</code> | Objeto de valor | Estado atual da revisão de uma hipótese, com concorrência otimista por versão. |
| <code>AuditoriaRevisao</code> | Entidade de domínio, imutável | Histórico de 0..* transições de revisão de uma hipótese, uma por decisão registrada. |
| <code>GoldenCase</code> | Entidade de domínio | Diagnóstico confirmado, usado como referência para análises futuras. |
| <code>Previsao</code> | Entidade de domínio | Estimativa de risco de degradação para a janela horária seguinte. |
| <code>Janela</code> | Objeto de valor | Intervalo temporal e granularidade de uma previsão ou de uma avaliação de recuperação. |
| <code>AvaliacaoRecuperacao</code> | Entidade de domínio | Registro do marco temporal, das janelas comparadas e da conclusão de uma avaliação de recuperação após correção. |
| <code>ImportJob</code> | Entidade de domínio | Acompanha o upload, a restauração e a ativação de um dump do ARGUS, com auditoria de autoria e horário em cada etapa. |
| <code>DatasetVersion</code> | Objeto de valor | Identifica a versão física de um conjunto de dados. |
| <code>Manifesto</code> | Entidade de domínio | Aponta a <code>DatasetVersion</code> ativa e a fronteira entre as camadas quente e histórica. |
| <code>AnalysisRun</code> | Entidade de domínio | Execução idempotente de uma mensagem de análise; evita duplicar incidentes ou previsões em reentregas. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

#### 4.3.2. Serviços e fronteiras

<div align="center">

<sup>Tabela 6: Serviços e fronteiras da aplicação — camada e responsabilidade de cada elemento</sup>

| Elemento | Camada | Responsabilidade |
|:---|:---|:---|
| Autenticação e sessão | Fronteira (boundary) | Conclui o fluxo OIDC com o Cognito e emite o cookie de sessão. |
| Visão geral, incidentes e eventos | Fronteira (boundary) | Expõe consultas de leitura sobre o Repositório operacional e o Repositório histórico. |
| Revisão de hipótese | Fronteira (boundary) | Recebe a decisão humana e delega ao Serviço de revisão. |
| Importação de dump | Fronteira (boundary) | Inicia e acompanha o <code>ImportJob</code>. |
| Reanálise | Fronteira (boundary) | Publica uma solicitação <code>REANALYSIS_REQUESTED</code> na SQS de Análise. |
| Monitoramento | Fronteira (boundary) | Expõe a saúde das fontes e do pipeline de ingestão e análise. |
| Serviço de autorização | Serviço (control) | Resolve a sessão corporativa e verifica permissões como <code>data:import</code>. |
| Serviço de importação | Serviço (control) | Cria o <code>ImportJob</code>, gera URLs pré-assinadas e inicia a tarefa Fargate. |
| Serviço de revisão | Serviço (control) | Aplica a concorrência otimista da <code>DecisaoRevisao</code>, grava a <code>AuditoriaRevisao</code> e promove o <code>GoldenCase</code>. |
| Analysis Orchestrator | Serviço (control), interno ao Worker | Decide quando investigar, reúne contexto e aciona o agente diagnóstico. |
| Anomaly Detector | Serviço (control), interno ao Worker | Aplica MAD e distância de Mahalanobis à janela de 15 minutos. |
| QoE Forecast Model | Serviço (control), interno ao Worker | Estima o risco de degradação da hora seguinte. |
| Diagnostic Agent | Serviço (control), interno ao Worker | Estrutura o contexto enviado ao Bedrock e ranqueia as hipóteses recebidas. |
| Repositório operacional | Repositório | Única porta de acesso à tabela <code>monitoracao-operacional</code>. |
| Repositório do conjunto de referência | Repositório | Única porta de acesso à tabela <code>monitoracao-golden-set</code>; leitura pelo Worker, escrita pelo Serviço de revisão. |
| Repositório histórico | Repositório | Encapsula as consultas ao Athena sobre o arquivo Parquet do S3. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

#### 4.3.3. Estados e enumerações

<div align="center">

<sup>Tabela 7: Estados e enumerações do modelo e suas transições relevantes</sup>

| Elemento | Estados possíveis | Transição relevante |
|:---|:---|:---|
| <code>Incidente.status</code> | <code>detected</code>, <code>investigating</code>, <code>confirmed</code>, <code>resolved</code>, <code>closed</code> | Criado como <code>detected</code> pelo Analysis Orchestrator ao correlacionar uma anomalia; demais transições dependem da investigação e da revisão humana. |
| <code>Diagnostico.status</code> | <code>not_started</code>, <code>processing</code>, <code>ready</code>, <code>failed</code> | Avança para <code>processing</code> quando há qualidade suficiente para investigar; <code>failed</code> preserva evidências já produzidas. |
| <code>DecisaoRevisao.status</code> | <code>pending</code>, <code>confirmed</code>, <code>refuted</code>, <code>inconclusive</code> | <code>confirmed</code> e <code>refuted</code> são terminais; toda transição, incluindo <code>inconclusive → confirmed/refuted</code>, grava uma <code>AuditoriaRevisao</code>; apenas a transição para <code>confirmed</code> cria um <code>GoldenCase</code>. |
| <code>Previsao.classificationOutcome</code> | <code>TP</code>, <code>FP</code>, <code>TN</code>, <code>FN</code>, <code>UNKNOWN</code> | Calculado ao avaliar a previsão anterior contra o valor efetivamente observado na janela seguinte. |
| <code>ImportJob.status</code> | <code>UPLOADING</code>, <code>PROCESSING</code>, <code>COMPLETED</code>, <code>FAILED</code> | <code>ImportJob.stage</code> detalha <code>PROCESSING</code> em <code>VALIDATING</code>, <code>RESTORING</code>, <code>INGESTING</code> e <code>ACTIVATING</code>. |
| <code>AnalysisRun.status</code> | <code>PROCESSING</code>, <code>RETRY_PENDING</code>, <code>SUCCEEDED</code>, <code>FAILED</code> | Uma execução <code>SUCCEEDED</code> confirma a mensagem sem reprocessar; uma execução incompleta retoma a partir da última etapa persistida. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 4.4. Relacionamentos e dependências

<div align="center">

<sup>Tabela 8: Relacionamentos entre os elementos do modelo, com multiplicidade e justificativa</sup>

| Origem | Relação | Destino | Multiplicidade | Justificativa |
|:---|:---|:---|:---|:---|
| <code>Incidente</code> | Associação | <code>Evidencia</code> | <code>1 — 0..*</code> | Um incidente reúne todas as evidências coletadas em seu favor ou contra suas hipóteses. |
| <code>Incidente</code> | Associação | <code>Diagnostico</code> | <code>1 — 0..1</code> | Um incidente possui, no máximo, um diagnóstico em andamento ou concluído. |
| <code>Previsao</code> | Associação | <code>Diagnostico</code> | <code>1 — 0..1</code> | Uma previsão com risco elevado pode originar um diagnóstico preventivo, sem se tornar um incidente. |
| <code>Diagnostico</code> | Associação | <code>Hipotese</code> | <code>1 — 0..*</code> | O agente diagnóstico ranqueia zero ou mais hipóteses candidatas por confiança; permanece vazio enquanto o diagnóstico não estiver <code>ready</code> (UC-03, 4a. "Nenhuma hipótese disponível"). |
| <code>Hipotese</code> | Associação | <code>Evidencia</code> | <code>1 — 0..*</code> | Cada hipótese cita as evidências que a sustentam. |
| <code>Hipotese</code> | Composição | <code>DecisaoRevisao</code> | <code>1 — 1</code> | O estado atual da revisão só existe enquanto a hipótese existir. |
| <code>Hipotese</code> | Associação | <code>AuditoriaRevisao</code> | <code>1 — 0..*</code> | Cada transição de revisão, inclusive as intermediárias em <code>inconclusive</code>, grava um registro imutável no histórico. |
| <code>AuditoriaRevisao</code> | Dependência | <code>GoldenCase</code> | — | A auditoria que registra a transição para <code>confirmed</code> cria o caso na mesma transação; as demais não o alteram. |
| <code>Operador</code> | Associação | <code>AuditoriaRevisao</code> | <code>1 — 0..*</code> | A identidade do revisor de cada decisão vem exclusivamente da sessão autenticada. |
| <code>Operador</code> | Associação | <code>AvaliacaoRecuperacao</code> | <code>1 — 0..*</code> | A identidade de quem registra a avaliação vem exclusivamente da sessão autenticada. |
| <code>Operador</code> | Associação | <code>ImportJob</code> | <code>1 — 0..*</code> | Um operador com <code>data:import</code> cria e conclui a importação; <code>createdBy</code>, <code>completionRequestedBy</code> e <code>activatedBy</code> guardam a autoria de cada etapa. |
| <code>Previsao</code> | Composição | <code>Janela</code> | <code>1 — 1</code> | A janela-alvo é parte inseparável da previsão. |
| <code>Incidente</code> | Associação | <code>AvaliacaoRecuperacao</code> | <code>1 — 0..*</code> | Um incidente pode ser avaliado mais de uma vez após correções ou ajustes sucessivos. |
| <code>AvaliacaoRecuperacao</code> | Composição | <code>Janela</code> | <code>1 — 2</code> | A janela de base e a janela de comparação são partes inseparáveis da avaliação. |
| <code>Incidente</code>, <code>Previsao</code> | Associação | <code>DatasetVersion</code> | <code>* — 1</code> | Toda previsão ou incidente é produzido sob uma versão específica do conjunto de dados. |
| <code>ImportJob</code> | Associação | <code>DatasetVersion</code> | <code>1 — 1</code> | O job ativa sua <code>candidateDatasetVersion</code> somente após validar as duas camadas. |
| <code>Manifesto</code> | Associação | <code>DatasetVersion</code> | <code>1 — 1</code> | O manifesto aponta exatamente uma versão ativa por vez. |
| <code>AnalysisRun</code> | Associação | <code>Incidente</code> | <code>1 — 0..1</code> | Uma detecção reativa correlaciona ou cria, no máximo, um incidente. |
| <code>AnalysisRun</code> | Associação | <code>Previsao</code> | <code>1 — 0..1</code> | Uma previsão preventiva produz, no máximo, uma previsão. |
| Fronteiras da API do dashboard | Dependência | Serviço de autorização | — | Nenhuma fronteira acessa dados sem validar sessão e permissões antes. |
| Analysis Orchestrator | Dependência | Anomaly Detector, QoE Forecast Model, Diagnostic Agent | — | O orquestrador combina os três módulos internos do Worker de Análise. |
| Analysis Orchestrator, Serviço de revisão | Dependência | Repositório do conjunto de referência | — | O Worker apenas lê; somente o Serviço de revisão escreve. |
| Diagnostic Agent | Dependência | Amazon Bedrock | — | O agente delega a geração das hipóteses candidatas ao modelo gerenciado. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 4.5. Regras, garantias e limitações

<div align="center">

<sup>Tabela 9: Regras, garantias e limitações do modelo estrutural (INV, REG, GAR e LIM)</sup>

| ID | Elemento(s) | Regra, garantia ou limitação |
|:---|:---|:---|
| INV-01 | <code>Operador</code> | Nenhuma senha, hash ou credencial é persistida pelo View Show; a autenticação é sempre delegada ao Cognito federado ao SSO da Globo (RF04, RNF04, RIE01, RESTR01). |
| INV-02 | <code>AuditoriaRevisao</code>, <code>GoldenCase</code> | A promoção ao conjunto de referência ocorre somente quando a auditoria registra <code>newStatus = confirmed</code>, na mesma transação que grava a decisão; o Worker de Análise não possui permissão de escrita nesse repositório. |
| INV-03 | <code>DecisaoRevisao</code> | <code>confirmed</code> e <code>refuted</code> são estados finais e não podem ser sobrescritos; <code>inconclusive</code> admite nova revisão com a versão vigente. |
| INV-04 | <code>Incidente</code>, <code>Previsao</code> | Uma previsão nunca é registrada como incidente observado; um incidente só é criado ou atualizado quando uma anomalia efetivamente observada o sustenta. |
| INV-05 | <code>AuditoriaRevisao</code> | Todo registro de auditoria é imutável: uma vez gravado, não é editado nem removido, inclusive os registros de transições intermediárias em <code>inconclusive</code>. |
| REG-05 | <code>DecisaoRevisao</code> | Toda escrita exige a versão esperada (<code>expectedVersion</code>); uma versão obsoleta é rejeitada por concorrência otimista, sem alterar a hipótese. |
| REG-06 | <code>ImportJob</code>, <code>Manifesto</code> | A <code>candidateDatasetVersion</code> só se torna a versão ativa do manifesto depois de validar as camadas quente e histórica; uma falha preserva a versão anterior. |
| REG-07 | <code>Operador</code>, <code>ImportJob</code> | Criar ou concluir um <code>ImportJob</code> exige a permissão <code>data:import</code>, concedida pelo grupo Cognito <code>data-operator</code>; a identidade e a autorização vêm exclusivamente da sessão, nunca de claims no corpo da requisição. Essa identidade é o que preenche <code>createdBy</code>, <code>completionRequestedBy</code> e <code>activatedBy</code>. |
| GAR-01 | <code>Diagnostico</code> | Uma falha na chamada ao Bedrock não remove a previsão, o incidente ou as evidências já produzidas; o diagnóstico é marcado como recuperável. |
| LIM-01 | <code>GoldenCase</code> | Um caso confirmado referencia a hipótese de origem para fins de auditoria, mas não mantém vínculo estrutural com o incidente original, pois serve como referência atemporal para análises futuras. |
| GAR-02 | <code>AnalysisRun</code> | Mensagens duplicadas ou fora de ordem são identificadas por <code>idempotencyKey</code>; uma execução já <code>SUCCEEDED</code> é confirmada sem reprocessar e sem criar um segundo <code>Incidente</code> ou uma segunda <code>Previsao</code>. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 4.6. Decisões de modelagem

- **Arquitetura-alvo como única fonte.** Todas as classes, estados e relacionamentos desta seção vêm da arquitetura-alvo aprovada e dos contratos já consolidados nas Seções 2, 3 e 5 deste artefato, nunca dos arquivos, rotas ou módulos atualmente implementados.
- **Três visões para não misturar naturezas distintas.** Domínio, aplicação e persistência foram separados porque cada um responde a uma pergunta diferente: o que existe, quem opera sobre o que existe e onde isso é fisicamente guardado. Fundi-las produziria um diagrama denso e menos rastreável às decisões arquiteturais de origem.
- **Autenticação sem estado local.** <code>Operador</code> não possui atributo de senha nem tabela própria porque a arquitetura-alvo delega toda a autenticação ao Cognito/SSO; qualquer implementação com sessão local ou hash de senha é uma divergência a ser corrigida, não uma variação válida do modelo.
- **Previsão e incidente como conceitos distintos.** Separar <code>Previsao</code> de <code>Incidente</code> evita que uma estimativa de risco seja tratada como uma degradação confirmada, preservando a distinção normativa entre previsão preventiva e detecção reativa.
- **Estado atual separado do histórico de revisão.** <code>DecisaoRevisao</code> modela apenas o estado atual da hipótese, necessário para a concorrência otimista por <code>version</code>; cada transição — inclusive as intermediárias em <code>inconclusive</code>, que o DS-02B permite reabrir para <code>confirmed</code> ou <code>refuted</code> — grava uma <code>AuditoriaRevisao</code> imutável e independente. Um único objeto de valor não poderia representar as duas coisas sem perder o histórico a cada sobrescrita ou sem deixar de ser um objeto de valor.
- **Nomenclatura única para o conjunto de referência.** A classe usa o nome <code>GoldenCase</code> de forma consistente com os diagramas de sequência DS-02B e DS-04 desta seção, para que não exista um segundo nome (<code>CasoGoldenSet</code>) para o mesmo conceito dentro do próprio artefato.
- **Diagnóstico sem hipótese não é uma exceção.** A multiplicidade <code>0..*</code> entre <code>Diagnostico</code> e <code>Hipotese</code> reflete os estados <code>not_started</code>, <code>processing</code> e <code>failed</code>, nos quais nenhuma hipótese existe ainda, e o fluxo alternativo "4a. Nenhuma hipótese disponível" do UC-03; a cardinalidade <code>1..*</code> presumiria incorretamente que todo diagnóstico chega a ter ao menos uma hipótese.
- **Avaliação de recuperação como entidade, não como resultado efêmero de consulta.** O DS-02C armazena o marco temporal, as janelas comparadas, a conclusão e a autoria da avaliação; <code>AvaliacaoRecuperacao</code> torna esse dado persistido visível no modelo estrutural, reaproveitando o objeto de valor <code>Janela</code> já definido para <code>Previsao</code> em vez de duplicá-lo.
- **Operações típadas nas classes com comportamento relevante.** Entidades cujo ciclo de vida é regido por uma regra de negócio explícita nesta seção — transições de <code>Incidente</code> e <code>Diagnostico</code>, registro de decisão em <code>Hipotese</code>, avanço de etapas em <code>ImportJob</code>, confirmação idempotente em <code>AnalysisRun</code> — recebem operações com assinatura tipada; objetos de valor e entidades puramente descritivas (<code>Operador</code>, <code>Janela</code>, <code>DatasetVersion</code>, <code>GoldenCase</code>) permanecem apenas com atributos, por não possuírem comportamento normatizado além da leitura.
- **Serviços e fronteiras como classDiagram, não como flowchart.** A Seção 4.2.2 usa um <code>classDiagram</code> com estereótipos <code>&lt;&lt;interface&gt;&gt;</code>, <code>&lt;&lt;control&gt;&gt;</code> e <code>&lt;&lt;repository&gt;&gt;</code> e operações tipadas derivadas dos endpoints e mensagens já contratados nos diagramas de sequência da Seção 5, para que o princípio de tipar atributos e operações também se aplique à visão de aplicação, e não somente ao modelo de domínio.
- **Infraestrutura mapeada, não modelada como domínio.** DynamoDB, S3/Parquet, Glue, Athena, SQS e ECS aparecem apenas na visão de aplicação, como dependências externas, e no mapeamento de persistência da Seção 4.2.3 — nunca como classes com atributos e operações próprias.
- **Ingestão tratada como fronteira, não repetida em detalhe.** O contrato interno do Serviço de Ingestão possui detalhamento técnico próprio fora deste artefato; por isso, esta modelagem se reserva à representação estrutural de mais alto nível, sem duplicar esse contrato.

---

## 5. Diagramas de sequência

&emsp;Os diagramas de sequência são diagramas de interação da UML utilizados para representar, em ordem temporal, as mensagens trocadas entre os participantes de um comportamento. A disposição das linhas de vida e das mensagens permite identificar responsabilidades, dependências e caminhos alternativos durante a realização de um cenário. Essa representação segue os conceitos de interação definidos pela especificação UML 2.5.1 (OBJECT MANAGEMENT GROUP, 2017) e a abordagem apresentada por Larman (2007).

&emsp;Larman (2007) diferencia os Diagramas de Sequência do Sistema, que tratam o sistema como uma caixa-preta, dos diagramas de interação empregados no projeto orientado a objetos, que detalham os participantes internos e suas mensagens. Nesta seção, adota-se a segunda perspectiva em nível de componentes e serviços. Por esse motivo, os diagramas apresentam elementos internos do View Show, como o Backend, os workers, as filas e os serviços de armazenamento.

&emsp;No View Show, esses diagramas descrevem como os dados saem do ARGUS, tornam-se informações analisáveis e chegam aos usuários. A seção contempla a ingestão periódica e por snapshot, a autenticação, a consulta, a revisão humana, a previsão de degradações, a detecção de incidentes e a recuperação de falhas. Cada diagrama é acompanhado por uma explicação de seu objetivo e das decisões arquiteturais necessárias para compreender o fluxo.

&emsp;Os diagramas apresentam a arquitetura-alvo do View Show e especificam as responsabilidades dos participantes em cada cenário. As interações são descritas independentemente do estágio de implementação dos componentes.

> **Aviso de estágio de implementação.** O worker batch, S3/Glue/Athena,
> DynamoDB e a outbox estão implementados, testados localmente e passaram pelo
> smoke reduzido no Learner Lab em 12/09/2026. O candidato dessa execução não
> foi ativado. O gate e o controle do sync live estão implementados e testados
> localmente, mas conectividade/operação com o ARGUS live ainda não possuem
> evidência AWS. Importação pela interface, prova com volume representativo e o
> Worker de Análise integrado à AWS permanecem futuros.

### 5.1 Catálogo de diagramas de sequência

&emsp;Os nove diagramas foram organizados por cenário e vinculados aos casos de uso que realizam ou apoiam. A Tabela 10 funciona como índice da seção e diferencia as interações iniciadas pelo usuário dos processos técnicos executados de forma assíncrona.

<div align="center">

<sup>Tabela 10: Catálogo dos diagramas de sequência e seu vínculo com os casos de uso</sup>

| ID | Cenário | Casos de uso relacionados | Tipo de fluxo |
| --- | --- | --- | --- |
| DS-01A | Sincronização controlada com o MySQL vivo | UC-01, UC-03, UC-04, UC-06, UC-07, UC-08 | Controle implementado; operação AWS pendente |
| DS-01B | Backfill operacional/manual de snapshot | UC-01, UC-03, UC-04, UC-06, UC-07, UC-08 | Operação inicial |
| DS-02A | Autenticação federada e consulta | UC-01, UC-02 | Básico |
| DS-02B | Revisão concorrente e promoção ao conjunto de referência | UC-03, UC-04 | Concorrente |
| DS-02C | Avaliação da recuperação após correção ⚠️ *(fluxo proposto, sem contrato de API formalizado)* | UC-05 | Básico/alternativo |
| DS-03A | Previsão preventiva e validação posterior | UC-06 | Suporte técnico/assíncrono |
| DS-03B | Detecção reativa e diagnóstico por IA | UC-03, UC-04, UC-06 | Suporte técnico/assíncrono |
| DS-03C | Falha, novas tentativas, DLQ e reanálise | UC-04, UC-07 | Exceção/alternativo |
| DS-04 | Visão geral ponta a ponta | UC-01, UC-02, UC-03, UC-04, UC-06 | Resumo |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;Os diagramas automáticos de ingestão e análise representam mecanismos técnicos que viabilizam os objetivos dos usuários. Por isso, sua relação com os casos de uso é de suporte. A importação de snapshot e a solicitação de reanálise são apresentadas como variações operacionais dos fluxos de disponibilização e análise dos dados.

### 5.2 Convenções

&emsp;As mensagens estão dispostas de cima para baixo na ordem em que ocorrem. Os fragmentos `alt`, `opt`, `loop` e `par` indicam, respectivamente, alternativas exclusivas, comportamentos condicionais, repetições e atividades concorrentes. As mensagens enviadas à SQS representam comunicação assíncrona; retornos e chamadas diretas representam comunicação síncrona. Horários são registrados em UTC e as operações repetíveis empregam identificadores idempotentes, de modo que uma mesma solicitação possa ser repetida sem duplicar seu efeito.

&emsp;Os diagramas representam componentes lógicos da aplicação. Os participantes identificam papéis ou serviços responsáveis por cada interação, enquanto as mensagens expressam as responsabilidades exercidas no cenário. Elementos como sub-redes, rotas, ALB e NAT Gateway pertencem ao diagrama de implantação e foram omitidos para preservar a legibilidade. O termo `Prediction` identifica uma previsão de risco futuro, enquanto `Incident` identifica uma degradação já observada nos dados.

### 5.3 Ingestão e disponibilização dos dados

&emsp;A ingestão ARGUS 2.0 transforma dados físicos em fatos e projeções
canônicos. O contrato fechado tem 23 datasets e está em
[Ingestão e dados](../arquitetura/ingestao-e-dados.md). O procedimento inicial é
manual: o operador usa o uploader e `RunTask`; UI de importação e `ImportJob`
são evolução futura, não participantes desta sequência. Esses fluxos dão suporte
ao UC-08 e fornecem dados aos demais casos de uso.

#### 5.3.1 DS-01A — Sincronização controlada com o MySQL vivo

&emsp;O modo `sync`, o gate DynamoDB e o controle autenticado estão implementados.
A agenda `g05-s3-ingestion-sync` nasce em estado `DISABLED`, e item ausente em
`CONTROL#ARGUS`/`LIVE_SYNC` bloqueia novas leituras. Qualquer sessão autenticada
pode alterar os dois estados pelo botão em Configurações, sem novo deploy. Isso
não prova conectividade com a origem: rede autorizada, segredo live e evidência
operacional ainda são pré-requisitos para habilitar a integração na AWS.

<div align="center">

<sup>Figura 4: DS-01A — sincronização controlada com o MySQL vivo</sup>

</div>

```mermaid
sequenceDiagram
    autonumber
    actor U as Usuário autenticado
    participant UI as Configurações
    participant API as Backend
    participant SCH as Scheduler
    participant ECS as ECS/Fargate
    participant ING as Serviço batch
    participant MYSQL as MySQL ARGUS live
    participant DB as DynamoDB
    participant Q as SQS

    U->>UI: Habilitar integração ARGUS
    UI->>API: PATCH enabled=true
    API->>SCH: GetSchedule + UpdateSchedule(ENABLED)
    API->>DB: Put CONTROL#ARGUS/LIVE_SYNC=true
    API-->>UI: Estado confirmado
    loop A cada 15 minutos
        SCH->>ECS: RunTask(sync)
        ECS->>ING: executar sync
        ING->>DB: leitura consistente do gate
        alt Gate habilitado e origem autorizada
            ING->>MYSQL: ler incremento autenticado
            ING->>DB: materializar janela e outbox
            ING->>Q: publicar pendências
        else Gate ausente ou desligado
            ING-->>ECS: SKIPPED_DISABLED
        end
    end
```

&emsp;Quando autorizado, o sync usa lease, checkpoint e a mesma normalização do
snapshot. Desligar grava primeiro o gate e depois pausa o Scheduler; uma task
que já passou pelo gate pode terminar. O controle implementado não prova
disponibilidade do MySQL live antes da validação operacional da origem.

#### 5.3.2 DS-01B — Backfill operacional/manual de snapshot

&emsp;O backfill é a operação inicial. O operador fornece `SNAPSHOT`
(`argus_dump.sql.gz` ou ZIP que o contém) ao uploader, com bucket, conta e
região, e conserva o resultado em `upload-result.json`. O uploader calcula o
SHA-256 dos bytes compactados, publica `dumps/<sha256>/argus_dump.sql.gz` e
obtém `VersionId`. Em seguida, `RunTask` consome `terraform-output.json` e
`upload-result.json`, injetando somente bucket, chave, versão, checksum e a
data de extração explicitamente atestada pelo operador. A
senha do MySQL é gerada e entregue pelo Secrets Manager, nunca por argumento ou
log.

<div align="center">

<sup>Figura 5: DS-01B — backfill manual de snapshot ARGUS 2.0</sup>

</div>

```mermaid
sequenceDiagram
    autonumber
    actor O as Operador
    participant UP as upload_snapshot.py
    participant RT as run_task.py
    participant S3 as S3 versionado
    participant ECS as ECS/Fargate
    participant MYSQL as mysql-snapshot efêmero
    participant ING as ingestion batch
    participant DB as DynamoDB
    participant GLUE as Glue
    participant ATH as Athena
    participant Q as SQS

    O->>UP: arquivo .sql.gz ou ZIP
    UP->>UP: extrair só argus_dump.sql.gz e SHA-256 streaming
    UP->>S3: multipart dumps/<sha256>/argus_dump.sql.gz
    S3-->>UP: VersionId, tamanho e checksum
    O->>RT: --terraform-output + --snapshot + --no-activate
    RT->>ECS: RunTask com clientToken determinístico
    ECS->>MYSQL: iniciar MySQL 8 e segredo runtime
    ECS->>ING: iniciar após health check
    ING->>DB: STARTING; adquirir lease e candidata
    ING->>S3: conferir checksum do objeto
    ING->>MYSQL: RESTORING, stream S3 → gzip → MySQL
    ING->>MYSQL: VALIDATING schema físico 2.0
    ING->>DB: INGESTING registros canônicos por página
    ING->>DB: PROJECTING read models
    ING->>S3: ARCHIVING Parquet em staging/canonical
    ING->>GLUE: catalogar uma tabela/partição por dataset
    ING->>ATH: reconciliar contagem e schema
    Note over O,RT: Após validação, execução separada com --activate, ACTIVATE_CANDIDATE=true e clientToken ECS distinto
    ING->>DB: ACTIVATING manifesto por compare-and-swap
    ING->>DB: PUBLISHING watermark + outbox
    alt SQS confirma
        ING->>Q: publicar evento idempotente
        ING->>DB: SUCCEEDED e outbox PUBLISHED
    else SQS falha após ativação
        ING->>DB: PARTIAL; conservar outbox PENDING
    end
    ECS->>MYSQL: encerrar e descartar volume
```

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;A ordem é obrigatória: `STARTING` → `RESTORING` → `VALIDATING` →
`INGESTING` → `PROJECTING` → `ARCHIVING` → `ACTIVATING` →
`PUBLISHING` → `SUCCEEDED` ou `PARTIAL`. Falha antes de `ACTIVATING`
termina em `FAILED` e preserva o manifesto ativo. Se outro run retiver o
lease, o resultado é `SKIPPED_LOCKED`. A segunda execução do mesmo
bucket/chave/versão/checksum deve produzir a mesma `datasetVersion`, sem novos
fatos, objetos canônicos ou eventos lógicos.

&emsp;O MySQL é transitório; S3 é a cópia durável. O archive passa por
`STAGING`, `UPLOADED`, `CATALOGED`, `VALIDATED` e `AVAILABLE`. Somente
depois da reconciliação Athena a TTL da cópia quente pode ser elegível. O
manifesto expõe `availableIntervals`: a política de até 12 meses não permite
afirmar uma cobertura que o snapshot não contenha.

&emsp;O dump reduzido determinístico cobre as 23 tabelas e serve para smoke do
caminho funcional. Ele não valida capacidade nem substitui uma execução
representativa do dump real. O smoke reduzido na AWS foi concluído em
12/09/2026; a prova de capacidade continua pendente.

### 5.4 Backend, autenticação e revisão

&emsp;Os fluxos do Backend representam as interações iniciadas pelos usuários corporativos. O primeiro garante uma sessão autenticada antes de disponibilizar o dashboard; o segundo registra a decisão humana sobre uma hipótese diagnóstica; o terceiro compara os indicadores anteriores e posteriores a uma correção externa. Essas interações realizam os casos de uso UC-01, UC-02, UC-03, UC-04 e UC-05. O Dashboard atua como interface, enquanto o Backend concentra a validação da sessão, a consulta aos dados e a aplicação das regras de revisão e comparação.

> **Divergência tecnológica/temporária.** O DS-02A a seguir modela a federação alvo (Cognito ↔ SSO corporativo por OIDC/SAML). No runtime atual, o Cognito realiza login direto por usuário e senha, e as rotas de federação retornam `503`.

#### 5.4.1 DS-02A — Autenticação federada e consulta

&emsp;A autenticação federada permite que o View Show reconheça a identidade corporativa sem armazenar senhas. Quando não existe sessão válida, o Backend direciona o usuário ao Cognito, que delega a autenticação ao SSO da Globo. Somente depois da validação do retorno o sistema cria a sessão e consulta o modelo de leitura da visão geral.

<div align="center">

<sup>Figura 6: DS-02A — autenticação federada via Cognito e SSO corporativo, seguida da consulta ao dashboard</sup>

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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;O SSO da Globo autentica o usuário, enquanto o Cognito atua como intermediário de identidade e emite tokens assinados no formato JWT. O Backend conclui o fluxo OAuth segundo o padrão *Backend for Frontend* (BFF). O padrão PKCE (*Proof Key for Code Exchange*) vincula o pedido de autenticação à troca posterior do código, reduzindo o risco de sua utilização indevida. O navegador recebe somente um cookie `HttpOnly`, `Secure` e `SameSite`, inacessível ao JavaScript. As respostas públicas também ocultam chaves e detalhes físicos das camadas de armazenamento.

&emsp;Uma sessão inexistente, expirada ou associada a uma identidade não autorizada interrompe a consulta antes do acesso aos dados. As falhas são registradas sem credenciais ou tokens e o usuário é direcionado novamente ao processo de autenticação.

#### 5.4.2 DS-02B — Revisão concorrente e promoção ao conjunto de referência

&emsp;A revisão de hipóteses permite que uma pessoa confirme, refute ou marque como inconclusiva a causa provável apresentada pelo sistema. Como dois usuários podem abrir o mesmo diagnóstico, o Backend utiliza a versão conhecida pelo revisor para aceitar somente a decisão compatível com o estado e a versão atuais. Uma hipótese confirmada passa a integrar o *golden set*, isto é, o conjunto de diagnósticos humanos confirmados que serve como referência para análises futuras. Uma decisão inconclusiva permanece revisável e não promove a hipótese.

<div align="center">

<sup>Figura 7: DS-02B — revisão concorrente de hipóteses com controle de versão e promoção ao conjunto de referência</sup>

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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;A identidade do revisor vem da sessão. A requisição informa `Idempotency-Key` e `expectedVersion`; a escrita exige a versão esperada e aceita `PENDING` ou `INCONCLUSIVE`. `CONFIRMED` e `REFUTED` são terminais. `INCONCLUSIVE` grava uma decisão humana, mas não é terminal: outra revisão pode decidir `CONFIRMED` ou `REFUTED` com nova `Idempotency-Key` e a versão atual. Somente `CONFIRMED` inclui a criação do `GoldenCase` na transação; `REFUTED` e `INCONCLUSIVE` permanecem no histórico operacional.

&emsp;Requisições sem a versão esperada são rejeitadas sem alterar a hipótese. Uma requisição com versão obsoleta recebe `REVIEW_VERSION_CONFLICT`; uma tentativa de alterar `CONFIRMED` ou `REFUTED` com a versão atual recebe `REVIEW_FINAL_STATE_CONFLICT`. Toda decisão grava auditoria imutável. A chave de idempotência permite devolver o mesmo resultado quando uma requisição é repetida, sem duplicar a auditoria ou o caso confirmado.

#### 5.4.3 DS-02C — Avaliação da recuperação após correção

&emsp;A avaliação de recuperação ocorre depois de uma correção realizada fora do View Show. A Engenheira de Software ou a Product Manager seleciona o incidente, confirma o marco temporal da intervenção e solicita a comparação de janelas equivalentes. O fluxo realiza UC-05 sem atribuir ao sistema a implantação da correção nem transformar uma associação temporal em afirmação de causalidade.

> **Fluxo proposto.** Diferentemente dos demais diagramas desta seção, o DS-02C ainda não possui contrato de endpoint formalizado. As mensagens abaixo representam a solução proposta para UC-05, sujeita a ajuste quando o contrato for consolidado.

<div align="center">

<sup>Figura 8: DS-02C — avaliação da recuperação após correção externa, por comparação de janelas equivalentes (fluxo proposto)</sup>

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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;O componente responsável pela comparação deverá devolver os períodos, os tamanhos das amostras e as variações absolutas e percentuais para que o resultado permaneça auditável. Consultas de até 30 dias utilizam o DynamoDB, enquanto períodos anteriores são obtidos pelo Athena a partir dos arquivos Parquet no S3. No MVP, a classificação conclusiva exige janelas de mesma duração, os mesmos filtros de segmento e ao menos 20 observações em cada janela; nos demais cenários, a interface informa a limitação e preserva o contexto para ajuste ou repetição posterior.

&emsp;A conclusão registrada representa a interpretação do ator a partir dos indicadores disponíveis. O View Show não executa implantação ou reversão e não afirma que a correção causou a variação observada. Essa delimitação mantém o diagrama coerente com a fronteira funcional definida em UC-05.

### 5.5 Worker de Análise

&emsp;O Worker de Análise consome de forma assíncrona as janelas materializadas pela ingestão e coordena três responsabilidades: antecipar degradações, reconhecer anomalias já observadas e recuperar processamentos interrompidos. Essas atividades não são iniciadas diretamente pelos atores, mas fornecem previsões, incidentes, evidências, hipóteses e informações operacionais para os casos de uso UC-03, UC-04, UC-06 e UC-07.

&emsp;O orquestrador de análise permanece um módulo interno do Worker. Ele combina os resultados dos modelos, recupera informações do DynamoDB e consulta casos humanos confirmados antes de solicitar ao agente diagnóstico uma explicação para o risco ou incidente. O Amazon Bedrock apoia a geração das hipóteses, mas não substitui a decisão humana.

#### 5.5.1 DS-03A — Previsão preventiva e validação posterior

&emsp;A previsão preventiva estima, a cada janela horária completa, o risco de degradação da experiência na hora seguinte. Antes de produzir uma nova previsão, o Worker compara a estimativa anterior com o valor efetivamente observado. Essa validação permite acompanhar a qualidade do modelo e registrar se ele reconheceu corretamente a ocorrência ou a ausência de uma degradação.

<div align="center">

<sup>Figura 9: DS-03A — previsão preventiva da janela horária seguinte e validação da previsão anterior</sup>

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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;A previsão executa após uma janela horária completa e registra o limiar e a versão do modelo. A mesma execução compara a previsão anterior com o valor observado e classifica o resultado como `TP`, `FP`, `TN`, `FN` ou `UNKNOWN`. Risco normal não aciona o agente; risco elevado exige qualidade mínima. Uma hipótese preventiva não é um incidente e continua sujeita à revisão humana. As classificações `TP`, `FP`, `TN` e `FN` representam, respectivamente, verdadeiro positivo, falso positivo, verdadeiro negativo e falso negativo; `UNKNOWN` indica que os dados disponíveis não permitem avaliar a previsão.

#### 5.5.2 DS-03B — Detecção reativa e diagnóstico por IA

&emsp;A detecção reativa examina cada nova janela de 15 minutos para identificar alterações relevantes em relação ao comportamento histórico. O detector aplica o desvio absoluto mediano (MAD) às séries individuais e a distância de Mahalanobis ao conjunto de variáveis correlacionadas. A primeira técnica identifica valores afastados do padrão de uma métrica; a segunda verifica se a combinação entre várias métricas se tornou atípica.

<div align="center">

<sup>Figura 10: DS-03B — detecção reativa por MAD e distância de Mahalanobis, com diagnóstico automático por IA</sup>

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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;MAD e Mahalanobis permanecem módulos internos do mesmo Worker. O detector produz scores e evidências; o `Analysis Orchestrator` cria ou correlaciona o incidente. O resultado estatístico torna-se uma evidência associada ao incidente. Quando há qualidade e cobertura suficientes, o agente consulta o contexto de até cinco horas anteriores à falha e o conjunto de casos confirmados para produzir hipóteses justificadas. Eventos individuais ficam restritos ao mesmo dispositivo; quando existirem apenas agregados, são usadas métricas do segmento afetado e o diagnóstico recebe qualidade limitada. O incidente permanece disponível mesmo quando o diagnóstico por IA não pode ser concluído.

#### 5.5.3 DS-03C — Recuperação de falhas, mensagens não processadas e reanálise

&emsp;A recuperação de falhas evita que uma indisponibilidade transitória descarte o resultado já produzido. O Worker registra cada tentativa e retoma a partir da última etapa persistida. Entre as tentativas, aplica-se uma espera progressiva, denominada *backoff*, para reduzir a pressão sobre a dependência indisponível. Depois do limite configurado, a mensagem segue para a *Dead-Letter Queue* (DLQ), fila separada que conserva mensagens não processadas para inspeção e reenvio controlado. O mesmo fluxo permite que um usuário autenticado solicite uma nova análise do incidente.

<div align="center">

<sup>Figura 11: DS-03C — recuperação de falhas do Worker, fila de mensagens não processadas (DLQ) e reanálise</sup>

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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;Os valores iniciais adotados para a fila foram reunidos na Tabela 11. Eles delimitam o tempo concedido a cada processamento, o número de tentativas e o período disponível para uma recuperação manual.

<div align="center">

<sup>Tabela 11: Parâmetros operacionais iniciais da fila de análise</sup>

| Configuração | Valor inicial |
| --- | ---: |
| Tipo da fila | SQS Standard |
| Tempo de invisibilidade da mensagem | 5 minutos |
| Renovação durante o processamento | A cada 60 segundos |
| Máximo de recebimentos | 5 |
| Retenção da fila principal | 14 dias |
| Retenção da DLQ | 14 dias |
| Espera máxima por novas mensagens | 20 segundos |
| Alarme | Uma ou mais mensagens na DLQ |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;Mensagens duplicadas são tratadas por idempotência. O Worker retoma da última etapa persistida, e uma falha no Bedrock não remove previsão, incidente ou evidências nem produz uma hipótese artificial. Erros permanentes seguem diretamente para a DLQ; falhas transitórias usam a espera progressiva e o reenvio automático após o quinto recebimento.

&emsp;Ao concluir uma solicitação, o Worker registra a execução como `SUCCEEDED`. Cada previsão preserva a versão do modelo, o limiar, a janela-alvo e, quando disponível, o resultado de sua validação. Toda anomalia persistida permanece associada à evidência que a fundamenta e, quando aplicável, a um incidente. As hipóteses continuam pendentes até a revisão humana, enquanto mensagens que não puderam ser processadas permanecem recuperáveis na DLQ.

### 5.6 Visão geral ponta a ponta

&emsp;O fluxo ponta a ponta sintetiza como os processos anteriores se conectam. Ele começa quando o ARGUS ou um snapshot disponibiliza dados, acompanha sua normalização e análise e termina quando o usuário consulta o resultado e decide sobre uma hipótese. Essa visão não substitui os diagramas detalhados; sua função é evidenciar a continuidade entre a origem operacional, o processamento automático e a intervenção humana.

<div align="center">

<sup>Figura 12: DS-04 — visão geral ponta a ponta do View Show, da disponibilização dos dados até a decisão sobre a hipótese</sup>

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
    ING->>S3: Arquivar Parquet canônico conforme partições disponíveis
    ING->>GLUE: Registrar e validar partições históricas
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

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp;Na primeira parte, o DS-01A detalha a sincronização do MySQL e o DS-01B detalha a importação de snapshots. Depois da publicação na fila, o DS-03A descreve a previsão horária, o DS-03B apresenta a detecção de incidentes e o DS-03C mostra a recuperação de falhas. A interação do usuário é aprofundada no DS-02A, para autenticação e consulta, no DS-02B, para revisão de hipóteses, e no DS-02C, para avaliação posterior a uma correção externa.

&emsp;Ao final do percurso, a camada quente mantém até 30 dias e o S3 mantém
Parquet canônico sob o mesmo `datasetVersion`; os intervalos consultáveis são
os declarados no manifesto. A política de retenção pode chegar a 12 meses, sem
afirmar que o snapshot atual cubra toda essa duração. Uma previsão continua
distinta de um incidente observado, enquanto uma anomalia pode criar ou reforçar
um incidente. As hipóteses permanecem pendentes até a decisão humana e somente
as confirmadas passam a integrar o conjunto de referência; decisões refutadas
podem registrar a causa alternativa informada, e decisões inconclusivas
permanecem revisáveis. O `traceId`, identificador de correlação propagado entre
os componentes, permite acompanhar uma execução ao longo de todo o fluxo.

### 5.7 Rastreabilidade interna

&emsp;Para evitar que os processos técnicos sejam interpretados como casos de uso independentes, a Tabela 12 registra a natureza de cada relação. Ela também resume a principal decisão arquitetural demonstrada por cada diagrama.

<div align="center">

<sup>Tabela 12: Rastreabilidade dos diagramas de sequência aos casos de uso e às decisões arquiteturais</sup>

| Diagrama | Casos de uso | Natureza da relação | Decisão principal |
| --- | --- | --- | --- |
| DS-01A | UC-01, UC-03, UC-04, UC-06, UC-07, UC-08 | Suporte técnico controlado | Gate autoritativo, Scheduler coordenado e persistência operacional da telemetria |
| DS-01B | UC-01, UC-03, UC-04, UC-06, UC-07, UC-08 | Operação manual | Upload por script, MySQL sidecar, validação Athena e ativação versionada |
| DS-02A | UC-01, UC-02 | Realização | SSO federado com Backend for Frontend |
| DS-02B | UC-03, UC-04 | Realização | Concorrência otimista, auditoria e promoção transacional |
| DS-02C | UC-05 | Realização | Comparação auditável de janelas equivalentes sem inferência indevida de causalidade |
| DS-03A | UC-06 | Suporte técnico | Previsão horária e validação posterior |
| DS-03B | UC-03, UC-04, UC-06 | Suporte técnico | Detecção a cada 15 minutos e diagnóstico por IA |
| DS-03C | UC-04, UC-07 | Exceção e alternativa | Repetição controlada, DLQ e reanálise |
| DS-04 | UC-01, UC-02, UC-03, UC-04, UC-06 | Síntese | Continuidade do dado até a decisão humana |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

---

## 6. Rastreabilidade da modelagem

A rastreabilidade relaciona os casos de uso aos requisitos, às necessidades de usuário e aos demais elementos da modelagem. Essa relação permite verificar a origem de cada comportamento e identificar os conceitos que participam de sua realização.

<div align="center">

<sup>Tabela 13: Rastreabilidade dos casos de uso aos requisitos, às telas e aos elementos conceituais</sup>

| Área | Caso de uso | Requisitos | Histórias ou telas relacionadas | Elementos conceituais | Sequências relacionadas |
| --- | --- | --- | --- | --- | --- |
| Login e acesso | UC-02 | RF04, RNF04, RIE01, RESTR01 | Tela de Login | Usuário corporativo, sessão e provedor de identidade | DS-02A |
| Visão Geral, filtros e exportação | UC-01 | RF07, RF08, RF09, RF10, RNF07, RNF14 | Visão Geral | Dashboard, consulta, filtro e exportação | DS-01A, DS-01B, DS-02A, DS-04 |
| Análise e revisão de incidente | UC-03 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 | US-N1-01 a US-N1-05 | Incidente, hipótese, evidência e decisão de revisão | DS-01A, DS-01B, DS-02B, DS-03B, DS-04 |
| Investigação técnica | UC-04 | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 | US-ENG-01 a US-ENG-04 | Incidente, evento, linha do tempo, hipótese e evidência | DS-01A, DS-01B, DS-02B, DS-03B, DS-04 |
| Avaliação posterior a uma correção | UC-05 | RF07, RF08, RF09, RNF05, RNF14 | US-ENG-05 e US-PM-04 | Incidente, marco temporal, janela de comparação e indicador | DS-02C |
| Indicadores, segmentos e histórico de QoE | UC-06 | RF07, RF08, RF09, RNF05, RNF14, RNF15 | US-PM-01 a US-PM-05 | Indicador de QoE, segmento, série temporal e degradação | DS-01A, DS-01B, DS-03A, DS-03B, DS-04 |
| Integridade da telemetria | UC-07 | RF07, RF08, RNF01, RNF02, RNF03, RNF09, RNF15 | US-ENG-06 e tela de Monitoramento | Fonte de telemetria, métrica operacional, cobertura e alerta | DS-01A, DS-01B, DS-03C |
| Sincronização e normalização dos dados do ARGUS | UC-08 | RF01, RF02, RF03, RIE02 | Não modelado: o temporizador e o ARGUS são atores técnicos, sem persona de usuário associada | Registro do ARGUS, checkpoint, watermark e outbox | DS-01A, DS-01B |
| Início da importação manual de snapshot | UC-09 | RF01, RF02, RF03, RNF04, RIE02 | Tela de Importações | Operador, ImportJob e upload multipart | DS-01B |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 6.1 Conceitos da matriz e sua representação estrutural

&emsp;Nem todo conceito citado na coluna "Elementos conceituais" da Tabela 13 corresponde a uma classe adicional do diagrama de classes: vários já são cobertos por classes existentes, por registros canônicos com contrato normativo em outro documento (Seção 4.1) ou por projeções calculadas em tempo de leitura. A Tabela 14 evita que essa ausência pareça uma omissão ao explicitar, para cada conceito, onde ele está representado ou por que permanece fora do modelo estrutural.

<div align="center">

<sup>Tabela 14: Justificativa estrutural dos conceitos da matriz de rastreabilidade</sup>

| Conceito | Caso de uso | Representação no modelo estrutural |
| --- | --- | --- |
| Evento | UC-04 | Corresponde ao `SignalObservation`, o registro canônico de ingestão; permanece fora da Seção 4 por decisão explícita de 4.1, que reserva esse contrato à documentação técnica de ingestão para não duplicá-lo. |
| Linha do tempo | UC-04 | Não é uma entidade persistida adicional: é uma ordenação, por `startedAt`/`observedAt`, de `Incidente` e `Evidencia`, já modelados em 4.2.1, servida pela fronteira "Visão geral, incidentes e eventos" (4.2.2). |
| Indicador de QoE | UC-06 | Corresponde ao `DimensionalMetricAggregate`, registro canônico de ingestão; consumido pela mesma fronteira de leitura, sem duplicar o contrato nesta seção (Seção 4.1). |
| Segmento | UC-06 | Dimensão de filtro (`device`, `region`, `version`, entre outras) sobre o `DimensionalMetricAggregate`; é um parâmetro de consulta da fronteira de leitura, não uma classe de domínio própria do View Show. |
| Fonte de telemetria | UC-07 | Corresponde ao campo `source` do contrato físico `signal_bucket`, que também identifica o `SignalObservation`; a saúde por fonte é uma projeção calculada em tempo de leitura pela fronteira de Monitoramento (4.2.2), sem persistência própria como classe de domínio do View Show. |
| Cobertura | UC-07 | Métrica calculada (`coverageRatio`/`measurement.status`) na resposta da fronteira de Monitoramento; não é um atributo persistido de nenhuma classe de domínio, e sim um valor derivado a cada consulta. |
| Alerta | UC-07 | Corresponde ao `status` calculado dos KPIs de monitoramento (mesmo contrato acima); o View Show não persiste uma entidade de alerta própria nesta versão — permanece como questão em aberto para uma versão futura. |
| Marco temporal | UC-05 | Modelado como o atributo `milestoneAt` da entidade `AvaliacaoRecuperacao` (4.2.1), persistida ao final do DS-02C. |
| Janela de comparação | UC-05 | Modelada pelas duas composições `AvaliacaoRecuperacao *-- Janela` (janela base e janela de comparação, 4.2.1 e 4.4), reaproveitando o objeto de valor já definido para `Previsao`. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

---

## 7. Referências

LARMAN, Craig. *Utilizando UML e padrões: uma introdução à análise e ao projeto orientados a objetos e ao desenvolvimento iterativo*. 3. ed. Porto Alegre: Bookman, 2007. E-book. Disponível em: https://integrada.minhabiblioteca.com.br/reader/books/9788577800476. Acesso em: 6 set. 2026.

OBJECT MANAGEMENT GROUP. *OMG Unified Modeling Language (OMG UML)*. Version 2.5.1. 2017. Disponível em: https://www.omg.org/spec/UML/2.5.1. Acesso em: 6 set. 2026.
