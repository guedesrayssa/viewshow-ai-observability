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

A modelagem de casos de uso contempla a aplicação web interna do View Show, utilizada por equipes do Globoplay para consultar telemetria, analisar e encaminhar incidentes, investigar falhas técnicas e acompanhar a qualidade da experiência (QoE). O recorte corresponde às telas de Login, Visão Geral, Incidentes, Evidências, Eventos e Monitoramento previstas para o MVP e para a Sprint 3.

Não fazem parte da modelagem de casos de uso:

- a emissão de telemetria pelos frontends do Globoplay;
- os processos internos de ingestão, enfileiramento, normalização e armazenamento;
- a execução de correções, deploys ou rollbacks em produção.

Esses elementos viabilizam o produto, mas não são metas iniciadas diretamente pelas personas na interface. Integrações e componentes técnicos são tratados nos artefatos de arquitetura, backend e requisitos. A observação de sua saúde, por outro lado, constitui o objetivo de usuário descrito em UC-21.

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

&emsp;Esse critério orientou a revisão da granularidade dos casos de uso do View Show. Ações como aplicar um filtro, consultar uma evidência ou comparar dois períodos são necessárias para alcançar objetivos mais amplos, mas não produzem, isoladamente, um resultado de negócio completo. Por essa razão, elas foram incorporadas aos fluxos dos casos principais. O diagrama permanece responsável por apresentar atores, fronteira e objetivos; a Seção 3 registra como cada objetivo é realizado.

### 2.1 Atores

&emsp;Um ator representa um papel exercido na interação com o sistema, e não uma pessoa específica. O papel **Usuário corporativo** foi definido como abstrato para concentrar as capacidades comuns de acesso e consulta. Analista de Atendimento Técnico N1, Engenheira de Software e Product Manager especializam esse papel e acrescentam objetivos próprios de suas responsabilidades. O provedor de identidade é mantido como ator secundário porque participa da troca de informações necessária à autenticação, embora esteja fora da fronteira do View Show.

<div align="center">

<strong>Tabela x: Atores do diagrama de casos de uso</strong>

</div>

| ID | Ator | Tipo | Responsabilidade principal |
| --- | --- | --- | --- |
| AT-01 | Usuário corporativo | Primário, abstrato | Acessar o View Show e consultar informações comuns aos perfis autorizados. |
| AT-02 | Analista de Atendimento Técnico N1 | Especialização de AT-01 | Priorizar incidentes e preparar seu encaminhamento com contexto suficiente. |
| AT-03 | Engenheira de Software | Especialização de AT-01 | Validar hipóteses, investigar falhas, avaliar recuperações e monitorar a telemetria. |
| AT-04 | Product Manager | Especialização de AT-01 | Analisar QoE, priorizar problemas e avaliar resultados posteriores a correções. |
| AT-05 | Provedor de identidade/SSO | Secundário | Autenticar a conta corporativa e devolver a identidade validada. |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

### 2.2 Catálogo de casos de uso

&emsp;O catálogo reúne sete objetivos observáveis para os usuários do View Show. Os identificadores oriundos do levantamento inicial foram preservados quando o comportamento permaneceu como objetivo independente. O identificador UC-21 foi acrescentado para representar o monitoramento da saúde da telemetria, objetivo documentado nas jornadas e telas do projeto que não possuía correspondência explícita no diagrama anterior.

<div align="center">

<strong>Tabela x: Catálogo dos casos de uso</strong>

</div>

| ID | Caso de uso | Ator principal | Requisitos relacionados |
| --- | --- | --- | --- |
| UC-01 | Consultar dashboard | Usuário corporativo | RF07, RF08, RF09, RF10, RNF07, RNF14 |
| UC-02 | Autenticar-se | Usuário corporativo | RF04, RNF04, RIE01, RESTR01 |
| UC-05 | Analisar e preparar encaminhamento de incidente | Analista de Atendimento Técnico N1 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 |
| UC-10 | Investigar falha técnica | Engenheira de Software | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 |
| UC-15 | Avaliar recuperação após correção | Engenheira de Software e Product Manager | RF07, RF08, RF09, RNF05, RNF14 |
| UC-16 | Analisar qualidade da experiência | Product Manager | RF07, RF08, RF09, RNF05, RNF14, RNF15 |
| UC-21 | Monitorar saúde da telemetria | Engenheira de Software | RF07, RF08, RNF01, RNF02, RNF03, RNF09, RNF15 |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A consolidação não elimina comportamentos previstos na versão anterior. Ela os posiciona no nível adequado da narrativa: filtros e exportação integram UC-01; priorização, hipóteses, evidências e preparação do resumo integram UC-05; validação da hipótese, inspeção de eventos e comparação integram UC-10; UC-15 reúne a verificação técnica e a avaliação de produto posteriores a uma correção; indicadores, segmentos e histórico integram UC-16. UC-21 complementa o conjunto com a observação da integridade das fontes e do pipeline de telemetria.

### 2.3 Diagrama

&emsp;O Diagrama x sintetiza a fronteira funcional do View Show e as associações entre os atores e seus objetivos. Os pormenores de cada interação permanecem nas descrições textuais para que a representação visual conserve a função de oferecer uma visão geral do sistema.

<div align="center">

<strong>Diagrama x: Casos de uso do View Show</strong>

![Diagrama de casos de uso do View Show](../../assets/modelagem/casos-de-uso.svg)

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A versão editável está disponível no [arquivo-fonte do diagrama](../../assets/modelagem/casos-de-uso.puml), o que permite atualizar atores, associações e casos de uso sem reconstruir a imagem manualmente.

### 2.4 Critérios de construção e leitura

&emsp;A fronteira **Sistema View Show** contém as funcionalidades percebidas pelos atores durante o uso da aplicação. Ingestão, enfileiramento, normalização, armazenamento, implantação e reversão de versões permanecem fora do diagrama porque correspondem a mecanismos internos ou a atividades realizadas em outros sistemas. Esses processos continuam documentados nos artefatos de arquitetura e nos diagramas de sequência.

&emsp;Os sete casos representam objetivos completos. Filtrar, exportar, consultar hipóteses, verificar evidências e comparar períodos aparecem nas descrições textuais como passos ou extensões condicionais. A avaliação posterior a uma correção foi mantida como objetivo independente porque ocorre em outro momento da jornada, após uma intervenção realizada fora do View Show. Essa organização evita empregar a relação `include` para indicar ordem temporal, uso que não corresponde à semântica definida pela UML (OBJECT MANAGEMENT GROUP, 2017).

&emsp;A autenticação também não é repetida como inclusão obrigatória em cada objetivo. Nas demais descrições, a existência de uma sessão válida constitui uma pré-condição. UC-02 concentra o comportamento necessário para criar ou renovar essa sessão e registra separadamente as situações de recusa ou indisponibilidade do provedor.

### 2.5 Relações principais

&emsp;A Tabela x explicita as associações e generalizações utilizadas no diagrama. Não foram empregadas relações `include` ou `extend`, pois os comportamentos condicionais identificados nesta versão podem ser expressos com maior precisão nos fluxos alternativos das descrições.

<div align="center">

<strong>Tabela x: Relações representadas no diagrama</strong>

</div>

| Origem | Relação | Destino | Justificativa |
| --- | --- | --- | --- |
| AT-02 | Generalização | AT-01 | O Analista N1 também executa os objetivos comuns de um usuário corporativo. |
| AT-03 | Generalização | AT-01 | A Engenheira de Software também executa os objetivos comuns. |
| AT-04 | Generalização | AT-01 | A Product Manager também executa os objetivos comuns. |
| AT-01 | Associação | UC-01 e UC-02 | Todo perfil autorizado pode autenticar-se e consultar o dashboard. |
| AT-02 | Associação | UC-05 | O Analista N1 inicia a análise e prepara os insumos para o encaminhamento externo. |
| AT-03 | Associação | UC-10, UC-15 e UC-21 | A Engenheira investiga falhas, avalia a recuperação e monitora a telemetria. |
| AT-04 | Associação | UC-15 | A Product Manager avalia o resultado técnico posterior a uma correção. |
| AT-04 | Associação | UC-16 | A Product Manager inicia a análise de QoE. |
| AT-05 | Associação | UC-02 | O provedor externo participa da autenticação corporativa. |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

---

## 3. Descrições dos casos de uso

&emsp;As descrições adotam o estilo completo apresentado por Larman (2007), em especial a organização utilizada no exemplo “Processar venda” e a definição das seções discutida pelo autor. Nesse formato, o caso de uso funciona como um contrato: identifica o objetivo e os participantes, estabelece as condições que devem existir antes e depois da interação e descreve tanto o cenário de sucesso quanto as variações relevantes.

&emsp;O nível de detalhamento foi ajustado à complexidade dos cenários do View Show. Preservaram-se todas as seções solicitadas para a entrega, mas foram registradas somente regras que contribuem para compreender o comportamento externo do sistema. Decisões ainda não confirmadas são apresentadas em **Problemas em aberto**, evitando que hipóteses de implementação sejam tratadas como requisitos consolidados.

### 3.1 UC-01 — Consultar dashboard

&emsp;Este caso de uso reúne a consulta compartilhada pelos três perfis corporativos. O objetivo é permitir que o usuário construa um recorte coerente dos dados e obtenha informações que possam ser aprofundadas nas análises de incidente, de investigação técnica ou de qualidade da experiência.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Usuário corporativo.
- **Atores secundários:** Nenhum.

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

- A exportação será implementada nesta versão ou planejada para uma entrega posterior?
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

- Qual provedor corporativo será utilizado na implementação do SSO?
- Qual será o plano de migração do mecanismo local existente para o acesso exclusivamente centralizado exigido por RNF04 e RESTR01?

### 3.3 UC-05 — Analisar e preparar encaminhamento de incidente

&emsp;Este caso de uso descreve a atividade de triagem conduzida pelo Atendimento N1. O sistema organiza o impacto, as hipóteses e as evidências, mas preserva a responsabilidade humana pela escolha da equipe que receberá o incidente.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Analista de Atendimento Técnico N1.
- **Atores secundários:** Nenhum.

#### Interessados e interesses

- **Analista N1:** identificar a prioridade e a equipe responsável com um número reduzido de interações.
- **Engenharia:** receber um encaminhamento com hipótese, evidências e recorte afetado.
- **Globo:** reduzir encaminhamentos incorretos e o tempo de diagnóstico.

#### Pré-condições

- O analista está autenticado.
- Existe ao menos um incidente detectado.

#### Pós-condições

- **Em caso de sucesso:** o sistema registra a equipe ou fila escolhida e disponibiliza um resumo contextualizado pronto para encaminhamento externo.
- **Garantia mínima:** o sistema preserva o incidente e não escolhe nem aciona automaticamente uma equipe responsável.

#### Fluxo Básico

1. O analista acessa a área de incidentes.
2. O sistema apresenta os incidentes por severidade e impacto.
3. O analista seleciona um incidente.
4. O sistema apresenta o recorte afetado e as hipóteses de causa provável.
5. O sistema apresenta confiança, justificativas e evidências de cada hipótese.
6. O analista aplica filtros para delimitar o problema.
7. O sistema prepara um resumo com incidente, impacto, hipótese e evidências.
8. O analista revisa o resumo, escolhe a equipe ou fila de destino e confirma a preparação do encaminhamento.
9. O sistema registra o destino e disponibiliza o resumo para cópia, sem afirmar que uma ferramenta externa o recebeu.

#### Fluxos alternativos

- **4a. Hipótese inconclusiva:** o sistema informa que não há evidência suficiente e segue para o passo 6.
- **5a. Evidências incompletas:** o sistema identifica as fontes ausentes ou atrasadas e segue para o passo 6.
- **6a. Nenhum resultado para o recorte:** o sistema mantém o incidente aberto e permite remover filtros. O fluxo retorna ao passo 6.
- **8a. Mais de um componente envolvido:** o resumo apresenta todos os componentes para decisão do analista.
- **8b. Preparação cancelada:** o fluxo termina sem alterar o incidente.

#### Requisitos especiais

- A causa provável deve ser localizável em até cinco cliques, conforme RNF10.
- As hipóteses exibidas devem ser produzidas por um modelo com F1-Score igual ou superior a 80%, conforme RNF08.
- O contexto fornecido ao modelo deve conter somente os registros das cinco horas anteriores à falha, conforme RNF13.
- A incerteza da hipótese deve ser apresentada explicitamente.
- O incidente não deve expor PII.
- Degradações devem ser sinalizadas conforme RNF15.

#### Lista de variantes

- **2a. Ordenação dos incidentes:** severidade, impacto ou recência.
- **6a. Recorte do incidente:** período, dispositivo, versão, região ou conteúdo.
- **8a. Destino:** uma equipe ou uma fila de atendimento.
- **9a. Forma de encaminhamento:** cópia do resumo ou integração com ferramenta externa.

#### Frequência de ocorrência

Diária, podendo tornar-se contínua durante incidentes críticos.

#### Problemas em aberto

- Qual ferramenta receberá o encaminhamento do incidente?
- Qual nível mínimo de evidência permitirá sugerir uma equipe responsável?

### 3.4 UC-10 — Investigar falha técnica

&emsp;Este caso de uso descreve o aprofundamento técnico realizado após a triagem. A investigação articula hipótese, eventos correlacionados, linha do tempo e comparações entre recortes para que a engenheira registre uma conclusão fundamentada. A avaliação posterior a uma intervenção foi separada em UC-15 porque depende de uma correção executada fora do View Show e pode ocorrer em outro momento.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Engenheira de Software, no papel operacional responsável pela observabilidade da plataforma.
- **Atores secundários:** Nenhum.

#### Interessados e interesses

- **Engenharia:** confirmar ou refutar uma hipótese com evidências rastreáveis.
- **Atendimento N1:** receber uma conclusão técnica sobre o encaminhamento.
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

Sempre que um incidente for encaminhado para investigação técnica.

#### Problemas em aberto

- Quando a fonte de eventos individuais estará disponível para consulta?
- Qual política será adotada para resolver revisões concorrentes de uma mesma hipótese?

### 3.5 UC-15 — Avaliar recuperação após correção

&emsp;Este caso de uso registra a avaliação realizada depois de uma correção externa. A separação em relação a UC-10 e UC-16 preserva a unidade do objetivo: a investigação e a priorização podem terminar antes da intervenção, enquanto a verificação de recuperação exige um marco temporal posterior e dados suficientes para uma comparação válida.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Atores principais:** Engenheira de Software ou Product Manager.
- **Atores secundários:** Nenhum.

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
- Para o MVP, cada janela deve conter ao menos 20 observações, em conformidade com o limiar `min_samples` vigente no serviço de análise.
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

- O limiar inicial de 20 observações precisa ser recalibrado por tipo de indicador após a validação com dados representativos de produção?
- Como a correção externa será associada ao incidente correspondente?

### 3.6 UC-16 — Analisar qualidade da experiência

&emsp;Este caso de uso representa a análise agregada realizada pela área de produto. O objetivo é reconhecer problemas recorrentes, comparar segmentos afetados e acompanhar a evolução dos indicadores para apoiar a priorização. A avaliação posterior a uma correção pertence a UC-15.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Product Manager.
- **Atores secundários:** Nenhum.

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

### 3.7 UC-21 — Monitorar saúde da telemetria

&emsp;Este caso de uso explicita um objetivo já presente nas jornadas de engenharia e na tela de monitoramento do projeto: verificar se a ingestão e o processamento fornecem dados íntegros e suficientemente atuais para as análises do View Show. Ele não transforma as etapas internas do pipeline em objetivos de usuário; registra apenas a observação e o diagnóstico de sua saúde operacional.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Engenheira de Software.
- **Atores secundários:** Nenhum.

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
- **4a. Atualização da interface:** releitura automática a cada 20 segundos ou atualização manual solicitada pela engenheira.

#### Frequência de ocorrência

Várias consultas ao dia, com acompanhamento prolongado durante incidentes e eventos ao vivo; enquanto a tela permanece aberta, os dados são relidos automaticamente a cada 20 segundos.

#### Problemas em aberto

- Quais limites operacionais produzirão alertas para cada componente?
- Quais canais receberão os alertas de saúde da telemetria?
- Qual equipe será responsável por cada tipo de degradação?

### 3.8 Síntese das descrições

&emsp;A consolidação resultou em sete narrativas orientadas a objetivos, sem eliminar as funcionalidades identificadas no levantamento anterior. Os comportamentos mais específicos foram reposicionados nos fluxos básicos, alternativos ou nas listas de variantes. A verificação posterior à correção foi preservada como UC-15 por ocorrer em momento distinto da investigação e da priorização, enquanto UC-21 tornou explícito o monitoramento da integridade dos dados utilizados pelos demais casos. Desse modo, o diagrama apresenta uma visão sintética das interações, enquanto as descrições preservam as condições, garantias e exceções necessárias para orientar análise, implementação e teste.

&emsp;A organização também mantém a separação entre intenção e solução técnica defendida por Larman (2007). As descrições registram o que os atores esperam do View Show e quais resultados o sistema deve garantir; decisões sobre serviços, bancos de dados, filas e mecanismos de implantação permanecem nos artefatos de arquitetura e nos diagramas de sequência.

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

A rastreabilidade abaixo registra a origem funcional, a realização arquitetural e o estado de implementação de cada objetivo. As classes e os componentes referem-se à modelagem mantida na branch de diagrama de classes; os identificadores DS referem-se à branch de diagramas de sequência e devem ser preservados na integração final.

<div align="center">

<strong>Tabela x: Rastreabilidade dos casos de uso</strong>

</div>

| Área | Caso de uso | Requisitos | Histórias ou telas de origem | Classes ou componentes principais | Sequências | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Login e acesso | UC-02 | RF04, RNF04, RIE01, RESTR01 | [Tela de Login](../sprint1/entendimento_ux.md#41-login) | `Usuario`, `userService`, `session`; integração SSO ainda pendente | DS-02A | Parcial: o protótipo local não atende ao SSO obrigatório |
| Visão Geral, filtros e exportação | UC-01 | RF07, RF08, RF09, RF10, RNF07, RNF14 | [Visão Geral](../sprint1/entendimento_ux.md#42-visão-geral) | rota `dashboard`, `EvidenceService`, modelos de leitura | DS-01A, DS-01B, DS-02A, DS-04 | Parcial: consultas existem; exportação ainda não está implementada |
| Triagem e preparação do encaminhamento | UC-05 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 | [US-N1-01 a US-N1-05](../sprint1/entendimento_ux.md#32-user-stories-da-persona-1) | `Incidente`, `Evidencia`, `Hipotese`, `RelatorioDiagnostico` | DS-01A, DS-01B, DS-02B, DS-03B, DS-04 | Parcial: o resumo pode ser preparado, mas não há integração de destino definida |
| Investigação de hipótese e eventos | UC-10 | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 | [US-ENG-01 a US-ENG-04](../sprint1/entendimento_ux.md#33-user-stories-da-persona-2) | `Incidente`, `Evidencia`, `Hipotese`, `CasoGoldenSet`, orquestrador | DS-01A, DS-01B, DS-02B, DS-03B, DS-04 | Parcial: revisão e diagnóstico existem; eventos individuais dependem de fonte publicada |
| Avaliação posterior a uma correção | UC-15 | RF07, RF08, RF09, RNF05, RNF14 | [US-ENG-05](../sprint1/entendimento_ux.md#us-eng-05---verificar-a-recuperação-após-uma-correção) e [US-PM-04](../sprint1/entendimento_ux.md#us-pm-04---avaliar-a-evolução-após-uma-correção) | Componente de comparação ainda não implementado | DS-02C | Proposto: comportamento especificado, contrato técnico pendente |
| Indicadores, segmentos e histórico de QoE | UC-16 | RF07, RF08, RF09, RNF05, RNF14, RNF15 | [US-PM-01 a US-PM-05](../sprint1/entendimento_ux.md#34-user-stories-da-persona-3) | modelos de leitura do dashboard e DTOs de QoE | DS-01A, DS-01B, DS-03A, DS-03B, DS-04 | Parcial: indicadores existem; ranking e histórico completo dependem da evolução do produto |
| Saúde operacional da telemetria | UC-21 | RF07, RF08, RNF01, RNF02, RNF03, RNF09, RNF15 | [US-ENG-06](../sprint1/entendimento_ux.md#us-eng-06---monitorar-a-saúde-da-telemetria) e [tela de Monitoramento](../sprint1/entendimento_ux.md#46-monitoramento) | `TelemetryRepository`, serviços de análise e tela `/monitoramento` | DS-01A, DS-01B, DS-03C | Parcial: a tela existe; parte das fontes utiliza dados de demonstração ou contratos ainda incompletos |
| Ingestão e normalização internas | Não constitui caso de uso de usuário | RF01, RF02, RF03, RNF06, RNF11, RNF12, RIE02, RESTR02 | [Escopo da modelagem](#12-escopo-da-modelagem) | API Flask, `TelemetryRepository`, normalização e persistência | DS-01A, DS-01B, DS-03A, DS-03B, DS-03C | Suporte técnico aos objetivos, fora da fronteira do diagrama de casos de uso |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

---

## 7. Validação e consistência

### 7.1 Lista de verificação

#### Casos de uso

- [x] Todos os atores possuem objetivos claros.
- [x] Todos os casos de uso do diagrama possuem descrição textual.
- [x] Cada descrição possui as doze seções solicitadas para o estilo completo.
- [x] Os fluxos básicos terminam nas pós-condições declaradas.
- [x] Os fluxos alternativos identificam o passo de origem ou o encerramento.
- [x] Relações `include` e `extend` não são usadas para representar ordem temporal.
- [x] Os casos de uso estão ligados a requisitos existentes.

#### Diagrama de classes

- [ ] As classes representam conceitos ou componentes relevantes.
- [ ] Atributos e operações possuem tipos.
- [ ] Associações possuem multiplicidades.
- [ ] Composição, agregação, herança e dependência foram usadas corretamente.
- [ ] As classes mencionadas nos diagramas de sequência existem no diagrama.
- [ ] O diagrama é consistente com a implementação ou explicita diferenças.

#### Diagramas de sequência

- [ ] Cada diagrama referencia um caso de uso e um fluxo específico.
- [ ] As mensagens aparecem em ordem temporal.
- [ ] Chamadas síncronas, assíncronas e retornos estão diferenciados.
- [ ] Alternativas e exceções usam fragmentos combinados.
- [ ] Participantes correspondem a atores, interfaces, serviços ou classes reais.
- [ ] O resultado final corresponde às pós-condições do caso de uso.

### 7.2 Pendências consolidadas

| ID | Pendência | Impacto | Responsável | Prazo | Status |
| --- | --- | --- | --- | --- | --- |
| P-01 | Substituir a autenticação local do protótipo pela federação obrigatória com o SSO corporativo. | Alto | Equipes de Frontend e Arquitetura | Antes da homologação de acesso | Aberta |
| P-02 | Validar com dados representativos se o limiar inicial de 20 observações é adequado para cada indicador de recuperação. | Médio | Equipes de Dados, Engenharia e Produto | Antes da implementação de UC-15 | Aberta |
| P-03 | Definir a ferramenta e o contrato de entrega do resumo preparado em UC-05. | Médio | Equipes de Atendimento e Arquitetura | Antes da integração externa | Aberta |
| P-04 | Especificar e implementar o contrato técnico de comparação e registro apresentado conceitualmente em DS-02C. | Médio | Equipes de Backend e Arquitetura | Antes da implementação de UC-15 | Aberta |

### 7.3 Revisão cruzada

| Entrega | Autor principal | Revisor | Resultado |
| --- | --- | --- | --- |
| Casos de uso e descrições | Equipe de modelagem | Revisão cruzada de requisitos e UX | Revisado; sete casos possuem as doze seções do estilo completo |
| Diagrama de classes | Equipe de backend | Revisão cruzada de implementação | Produzido em MR próprio; integração ainda pendente |
| Diagramas de sequência | Equipe de arquitetura | Revisão cruzada com os casos de uso | Revisado; identificadores alinhados e DS-02C marcado como proposto |
| Rastreabilidade e consistência final | Equipe do projeto | Equipe do projeto | Pendente da integração dos MRs de casos de uso, classes e sequências |

---

## 8. Referências

LARMAN, Craig. *Utilizando UML e padrões: uma introdução à análise e ao projeto orientados a objetos e ao desenvolvimento iterativo*. 3. ed. Porto Alegre: Bookman, 2007. E-book. Disponível em: https://integrada.minhabiblioteca.com.br/reader/books/9788577800476. Acesso em: 6 set. 2026.

OBJECT MANAGEMENT GROUP. *OMG Unified Modeling Language (OMG UML)*. Version 2.5.1. 2017. Disponível em: https://www.omg.org/spec/UML/2.5.1. Acesso em: 6 set. 2026.

GRUPO 05 — OS BIG BROTHERS. *Especificação de requisitos: Monitoramento de Frontend Globoplay*. 2026. Disponível em: [requisitos.md](../sprint1/requisitos.md).
