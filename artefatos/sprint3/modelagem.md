# Modelagem do Sistema

> Este documento apresenta a modelagem estrutural e comportamental do View Show
> por meio de diagramas UML e descrições textuais. A modelagem foi construída com
> base nos requisitos funcionais, não funcionais e decisões arquiteturais do projeto.

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

Este artefato tem como objetivo modelar o sistema View Show com base nos
requisitos e funcionalidades definidos nas etapas anteriores do projeto.

A modelagem utiliza diagramas UML e descrições textuais para representar:

- as interações entre os atores e o sistema;
- os fluxos principais, alternativos e de exceção;
- a estrutura lógica das classes;
- as interações temporais entre componentes;
- a rastreabilidade entre requisitos e elementos da modelagem.

### 1.2 Escopo da modelagem

A modelagem de casos de uso contempla a aplicação web interna do View Show,
utilizada por equipes do Globoplay para consultar telemetria, analisar e encaminhar
incidentes, investigar falhas técnicas e acompanhar a qualidade da experiência
(QoE). O recorte corresponde às telas de Login, Visão Geral, Incidentes,
Evidências, Eventos e Monitoramento previstas para o MVP e para a Sprint 3.

Não fazem parte da modelagem de casos de uso:

- a emissão de telemetria pelos frontends do Globoplay;
- os processos internos de ingestão, enfileiramento, normalização e armazenamento;
- a execução de correções, deploys ou rollbacks em produção.

Esses elementos viabilizam o produto, mas não são metas iniciadas diretamente
pelas personas na interface. Integrações e componentes técnicos são tratados nos
artefatos de arquitetura, backend e requisitos.

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
- Cada diagrama deve possuir título, fonte e uma descrição que explique como
  interpretá-lo.
- Sempre que possível, a fonte editável do diagrama e sua versão em SVG devem
  ser versionadas no repositório.

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
| AT-02 | Analista de Atendimento Técnico N1 | Especialização de AT-01 | Priorizar e encaminhar incidentes com contexto suficiente. |
| AT-03 | Engenheira de Software | Especialização de AT-01 | Validar hipóteses e investigar tecnicamente as falhas. |
| AT-04 | Product Manager | Especialização de AT-01 | Analisar QoE e priorizar problemas pelo impacto na audiência. |
| AT-05 | Provedor de identidade/SSO | Secundário | Autenticar a conta corporativa e devolver a identidade validada. |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

### 2.2 Catálogo de casos de uso

&emsp;O catálogo reúne cinco objetivos observáveis para os usuários do View Show. Os identificadores foram preservados em relação ao levantamento original para manter a correspondência com os demais artefatos produzidos na sprint. A eventual renumeração deve ser realizada de forma conjunta com a matriz de rastreabilidade e com os diagramas de sequência.

<div align="center">

<strong>Tabela x: Catálogo dos casos de uso</strong>

</div>

| ID | Caso de uso | Ator principal | Requisitos relacionados |
| --- | --- | --- | --- |
| UC-01 | Consultar dashboard | Usuário corporativo | RF07, RF08, RF09, RF10, RNF07, RNF14 |
| UC-02 | Autenticar-se | Usuário corporativo | RF04, RNF04, RIE01, RESTR01 |
| UC-05 | Analisar e encaminhar incidente | Analista de Atendimento Técnico N1 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 |
| UC-10 | Investigar falha técnica | Engenheira de Software | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 |
| UC-16 | Analisar qualidade da experiência | Product Manager | RF07, RF08, RF09, RNF05, RNF14, RNF15 |

<div align="center">

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A consolidação não elimina comportamentos previstos na versão anterior. Ela apenas os posiciona no nível adequado da narrativa: filtros e exportação passam a integrar UC-01; priorização, hipóteses, evidências e preparação do resumo integram UC-05; validação da hipótese, inspeção de eventos, comparação e verificação da recuperação integram UC-10; indicadores, segmentos, histórico e avaliação posterior à correção integram UC-16.

### 2.3 Diagrama

&emsp;O Diagrama x sintetiza a fronteira funcional do View Show e as associações entre os atores e seus objetivos. As notas vinculadas aos casos de uso resumem comportamentos internos das respectivas narrativas; elas não introduzem novos casos de uso.

<div align="center">

<strong>Diagrama x: Casos de uso do View Show</strong>

![Diagrama de casos de uso do View Show](../../assets/modelagem/casos-de-uso.svg)

Fonte: Material produzido pelos autores (2026).

</div>

&emsp;A versão editável está disponível no [arquivo-fonte do diagrama](../../assets/modelagem/casos-de-uso.puml), o que permite atualizar atores, associações e casos de uso sem reconstruir a imagem manualmente.

### 2.4 Critérios de construção e leitura

&emsp;A fronteira **Sistema View Show** contém as funcionalidades percebidas pelos atores durante o uso da aplicação. Ingestão, enfileiramento, normalização, armazenamento, implantação e reversão de versões permanecem fora do diagrama porque correspondem a mecanismos internos ou a atividades realizadas em outros sistemas. Esses processos continuam documentados nos artefatos de arquitetura e nos diagramas de sequência.

&emsp;Os cinco casos representam objetivos completos. Filtrar, exportar, consultar hipóteses, verificar evidências, comparar períodos e verificar a recuperação aparecem nas descrições textuais como passos ou extensões condicionais. Essa organização evita empregar a relação `include` para indicar ordem temporal, uso que não corresponde à semântica definida pela UML (OBJECT MANAGEMENT GROUP, 2017).

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
| AT-02 | Associação | UC-05 | O Analista N1 inicia a análise e decide o encaminhamento. |
| AT-03 | Associação | UC-10 | A Engenheira inicia a investigação técnica. |
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
5. O usuário consulta os detalhes de uma ocorrência ou conjunto de eventos.

#### Fluxos alternativos

- **2a. Fonte indisponível:** o sistema identifica os componentes sem dados e mantém disponíveis os componentes carregados corretamente.
- **4a. Nenhum resultado:** o sistema apresenta um estado vazio e permite alterar os filtros. O fluxo retorna ao passo 3.
- **5a. Exportação solicitada:** o sistema gera CSV, XLSX ou PDF com o período e os filtros utilizados.
- **5b. Exportação indisponível:** o sistema informa a falha e preserva a consulta atual.

#### Requisitos especiais

- Acesso restrito a usuários autorizados, conforme RNF04.
- Carregamento dos componentes principais conforme RNF07.
- Buscas filtradas com P95 de até dois segundos, conforme RNF14.
- Os resultados devem excluir informações pessoalmente identificáveis (PII).

#### Lista de variantes

- Perfil do usuário: Analista N1, Engenheira de Software ou Product Manager.
- Período e filtros aplicados à consulta.
- Formato de exportação: CSV, XLSX ou PDF.

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
- **6a. Sessão expirada:** o sistema solicita nova autenticação.

#### Requisitos especiais

- Acesso restrito ao domínio corporativo, conforme RNF04 e RESTR01.
- Chamadas sem autenticação ou sem autorização retornam 401 ou 403.
- Credenciais não são expostas nem armazenadas pela interface web.

#### Lista de variantes

- Autenticação por SSO.
- Autenticação por credencial local, caso essa opção permaneça no escopo.

#### Frequência de ocorrência

No início de cada sessão e após sua expiração.

#### Problemas em aberto

- Qual provedor corporativo será utilizado na implementação do SSO?
- O cadastro com senha local continuará disponível após a integração com o provedor corporativo?

### 3.3 UC-05 — Analisar e encaminhar incidente

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

- **Em caso de sucesso:** o sistema disponibiliza um resumo contextualizado para o encaminhamento decidido pelo analista.
- **Garantia mínima:** o sistema preserva o incidente e não escolhe nem aciona automaticamente uma equipe responsável.

#### Fluxo Básico

1. O sistema apresenta os incidentes por severidade e impacto.
2. O analista seleciona um incidente.
3. O sistema apresenta o recorte afetado e as hipóteses de causa provável.
4. O sistema apresenta confiança, justificativas e evidências de cada hipótese.
5. O analista aplica filtros para delimitar o problema.
6. O sistema prepara um resumo com incidente, impacto, hipótese e evidências.
7. O analista revisa o resumo e escolhe a equipe ou fila de destino.

#### Fluxos alternativos

- **3a. Hipótese inconclusiva:** o sistema informa que não há evidência suficiente e segue para o passo 5.
- **4a. Evidências incompletas:** o sistema identifica as fontes ausentes ou atrasadas e segue para o passo 5.
- **5a. Nenhum resultado para o recorte:** o sistema mantém o incidente aberto e permite remover filtros. O fluxo retorna ao passo 5.
- **7a. Mais de um componente envolvido:** o resumo apresenta todos os componentes para decisão do analista.
- **7b. Encaminhamento cancelado:** o fluxo termina sem alterar o incidente.

#### Requisitos especiais

- A causa provável deve ser localizável em até cinco cliques, conforme RNF10.
- A incerteza da hipótese deve ser apresentada explicitamente.
- O incidente não deve expor PII.
- Degradações devem ser sinalizadas conforme RNF15.

#### Lista de variantes

- Severidade e estado do incidente.
- Filtros utilizados para delimitar o recorte.
- Um ou mais componentes possivelmente envolvidos.
- Resumo copiado ou registrado para encaminhamento.

#### Frequência de ocorrência

Diária, podendo tornar-se contínua durante incidentes críticos.

#### Problemas em aberto

- Qual ferramenta receberá o encaminhamento do incidente?
- Qual nível mínimo de evidência permitirá sugerir uma equipe responsável?

### 3.4 UC-10 — Investigar falha técnica

&emsp;Este caso de uso descreve o aprofundamento técnico realizado após a triagem. A investigação articula hipótese, eventos correlacionados, linha do tempo e comparações entre recortes para que a engenheira registre uma conclusão fundamentada, sem executar alterações no ambiente de produção.

#### Escopo

Sistema View Show.

#### Nível

Objetivo do usuário.

#### Atores

- **Ator principal:** Engenheira de Software.
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
7. Após uma correção externa, a engenheira compara os indicadores anteriores e posteriores.

#### Fluxos alternativos

- **3a. Evento bruto indisponível:** o sistema informa que a comparação com o evento normalizado não pode ser realizada.
- **4a. Marcação temporal inconfiável:** o sistema sinaliza a limitação e não afirma uma ordem precisa para os eventos.
- **5a. Evidências conflitantes:** a hipótese permanece inconclusiva e o fluxo segue para o passo 6.
- **7a. Correção ainda não executada:** a verificação de recuperação é omitida.
- **7b. Amostra insuficiente:** a recuperação é classificada como inconclusiva.

#### Requisitos especiais

- Suporte aos eventos definidos no RF06.
- Visualização de dados brutos e normalizados, conforme RF05.
- Janela de diagnóstico de cinco horas, conforme RNF13.
- Histórico de até um ano, conforme RNF05.
- Registro da autoria e do momento da conclusão.

#### Lista de variantes

- Tipo de evento inspecionado.
- Versão, dispositivo ou período utilizado na comparação.
- Hipótese confirmada, refutada ou inconclusiva.
- Recuperação total, parcial, ausente ou inconclusiva.

#### Frequência de ocorrência

Sempre que um incidente for encaminhado para investigação técnica.

#### Problemas em aberto

- Quando a fonte de eventos individuais estará disponível para consulta?
- Quais critérios objetivos caracterizarão a recuperação do incidente?

### 3.5 UC-16 — Analisar qualidade da experiência

&emsp;Este caso de uso representa a análise agregada realizada pela área de produto. O objetivo é reconhecer segmentos afetados, acompanhar a evolução dos indicadores e avaliar resultados posteriores a uma correção, sem interpretar correlação temporal como evidência suficiente de causalidade.

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

- **Em caso de sucesso:** os segmentos prioritários e a evolução da QoE são apresentados; quando houver correção, seu resultado é classificado.
- **Garantia mínima:** amostras insuficientes ou períodos não comparáveis são identificados como inconclusivos.

#### Fluxo Básico

1. A Product Manager acessa os indicadores de QoE.
2. O sistema apresenta buffering, inicialização, latência e erros no período.
3. A Product Manager seleciona plataformas, dispositivos, versões ou regiões.
4. O sistema compara os segmentos utilizando os mesmos indicadores.
5. A Product Manager consulta degradações anteriores do segmento.
6. Quando aplicável, a Product Manager seleciona uma correção concluída.
7. O sistema compara janelas equivalentes antes e depois da correção.

#### Fluxos alternativos

- **2a. Indicador indisponível:** o sistema identifica a lacuna sem inferir valores.
- **4a. Amostra insuficiente:** o segmento é marcado como inconclusivo.
- **5a. Histórico em armazenamento de longo prazo:** o sistema informa que a recuperação pode levar mais tempo.
- **6a. Correção inexistente:** o fluxo termina com a análise histórica.
- **7a. Períodos não comparáveis:** o sistema solicita janelas equivalentes e retorna ao passo 6.

#### Requisitos especiais

- Cada indicador deve apresentar definição, unidade, período e tamanho da amostra.
- Buscas filtradas devem atender ao RNF14.
- Os dados devem permanecer anonimizados.
- O histórico deve seguir a política definida no RNF05.

#### Lista de variantes

- Indicador analisado.
- Plataforma, dispositivo, versão, região ou conteúdo.
- Período histórico ou comparação anterior/posterior à correção.

#### Frequência de ocorrência

Diária ou semanal e após incidentes ou eventos relevantes.

#### Problemas em aberto

- Qual será a amostra mínima aceita em uma comparação?
- Quais critérios tornarão dois períodos equivalentes?
- Como uma correção será associada ao incidente correspondente?

### 3.6 Síntese das descrições

&emsp;A consolidação resultou em cinco narrativas orientadas a objetivos, sem eliminar as funcionalidades identificadas no levantamento anterior. Os comportamentos mais específicos foram reposicionados nos fluxos básicos, alternativos ou nas listas de variantes. Desse modo, o diagrama apresenta uma visão sintética das interações, enquanto as descrições preservam as condições, garantias e exceções necessárias para orientar análise, implementação e teste.

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

A rastreabilidade abaixo registra a origem funcional dos casos de uso. As
ligações com classes e diagramas de sequência serão acrescentadas quando as
Seções 4 e 5 forem concluídas.

| Área ou origem funcional | Casos de uso | Requisitos relacionados | Evidência |
| --- | --- | --- | --- |
| Login e acesso | UC-02 | RF04, RNF04, RIE01, RESTR01 | [Seção 3.2](#32-uc-02--autenticar-se) |
| Visão Geral, filtros e exportação | UC-01 | RF07, RF08, RF09, RF10, RNF07, RNF14 | [Seção 3.1](#31-uc-01--consultar-dashboard) |
| Incidentes, hipóteses e evidências para triagem | UC-05 | RF07, RF08, RF09, RNF08, RNF10, RNF13, RNF15 | [Seção 3.3](#33-uc-05--analisar-e-encaminhar-incidente) |
| Investigação, eventos e recuperação | UC-10 | RF05, RF06, RF07, RF08, RF09, RNF05, RNF08, RNF10, RNF13, RNF14 | [Seção 3.4](#34-uc-10--investigar-falha-técnica) |
| Indicadores, segmentos e histórico de QoE | UC-16 | RF07, RF08, RF09, RNF05, RNF14, RNF15 | [Seção 3.5](#35-uc-16--analisar-qualidade-da-experiência) |
| Pipeline de telemetria | Não representado neste diagrama | RF01, RF02, RF03, RNF01, RNF02, RNF03, RNF06, RNF11, RNF12, RIE02, RESTR02 | Excluído da fronteira conforme a [Seção 1.2](#12-escopo-da-modelagem) |

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
| P-01 | [PENDÊNCIA] | Alto/Médio/Baixo | [Nome] | DD/MM | Aberta |
| P-02 | [PENDÊNCIA] | Alto/Médio/Baixo | [Nome] | DD/MM | Aberta |

### 7.3 Revisão cruzada

| Entrega | Autor principal | Revisor | Resultado |
| --- | --- | --- | --- |
| Casos de uso e descrições | Pessoa 1 | Pessoa 2 | [PENDENTE/APROVADO] |
| Diagrama de classes | Pessoa 2 | Pessoa 3 | [PENDENTE/APROVADO] |
| Diagramas de sequência | Pessoa 3 | Pessoa 1 | [PENDENTE/APROVADO] |
| Rastreabilidade e consistência final | Equipe | Equipe | [PENDENTE/APROVADO] |

---

## 8. Referências

LARMAN, Craig. *Utilizando UML e padrões: uma introdução à análise e ao projeto
orientados a objetos e ao desenvolvimento iterativo*. 3. ed. Porto Alegre:
Bookman, 2007. E-book. Disponível em:
https://integrada.minhabiblioteca.com.br/reader/books/9788577800476. Acesso em:
6 set. 2026.

OBJECT MANAGEMENT GROUP. *OMG Unified Modeling Language (OMG UML)*. Version
2.5.1. 2017. Disponível em:
https://www.omg.org/spec/UML/2.5.1. Acesso em: 6 set. 2026.

GRUPO 05 — OS BIG BROTHERS. *Especificação de requisitos: Monitoramento de
Frontend Globoplay*. 2026. Disponível em:
[requisitos.md](../sprint1/requisitos.md).
