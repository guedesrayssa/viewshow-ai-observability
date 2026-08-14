# Entendimento da Experiência do Usuário

<div align="center">
  <img src="../assets/view-show.png" alt="Imagem de apresentação do produto View Show em um notebook" style="max-width:900px;height:auto;">
  <p><em>Imagem de abertura - Apresentação visual da plataforma. Fonte: Autoria própria (2026).</em></p>
</div>

[**Protótipo navegável no Figma**](https://www.figma.com/design/kbq8niIkBCHz7oVr1t0Ogp/G05---View-Show?node-id=219-1437&t=nvQLc8FQxxXWXLwt-1)

_<strong>Por favor, dar ênfase no protótipo de alta fidelidade.</strong>_

## Sumário

- [1. Introdução](#1-introdução)
- [2. Personas](#2-personas)
  - [2.1 Persona 1 - Matheus Souza](#21-persona-1--matheus-souza)
  - [2.2 Persona 2 - Giovanna Matsu](#22-persona-2--giovanna-matsu)
  - [2.3 Persona 3 - Fernanda Oliveira](#23-persona-3--fernanda-oliveira)
- [3. User Stories](#3-user-stories)
  - [3.1 Critérios INVEST](#31-critérios-invest)
  - [3.2 User Stories da Persona 1](#32-user-stories-da-persona-1)
  - [3.3 User Stories da Persona 2](#33-user-stories-da-persona-2)
  - [3.4 User Stories da Persona 3](#34-user-stories-da-persona-3)
  - [3.5 Priorização](#35-priorização)
- [4. Wireframes](#4-wireframes)
- [5. Protótipo de alta fidelidade](#5-protótipo-de-alta-fidelidade)
- [6. Fluxos de uso](#6-fluxos-de-uso)
- [7. Decisões de UX e UI](#7-decisões-de-ux-e-ui)
- [8. Usabilidade e acessibilidade](#8-usabilidade-e-acessibilidade)
- [9. Referências](#9-referências)

## 1. Introdução

O Globoplay opera em um ecossistema heterogêneo, formado por navegadores, dispositivos móveis, televisores e diferentes versões de sistemas operacionais. Nesse cenário, uma falha pode atingir somente um recorte específico da audiência e permanecer oculta em indicadores agregados. Além disso, os dados necessários ao diagnóstico podem estar distribuídos entre diferentes fontes, com granularidades e vocabulários distintos.

A solução proposta centraliza eventos de telemetria, normaliza os dados e apoia a investigação de incidentes. Sua interface deve permitir que as pessoas usuárias compreendam o impacto de uma degradação, consultem hipóteses de causa provável e suas evidências, aprofundem a análise até os eventos e sessões relacionados e acompanhem a recuperação dos indicadores após uma correção.

Foram mapeadas três personas complementares, apresentadas na ordem de participação na jornada: atendimento técnico N1, engenharia de software e gestão de produto. Cada uma possui uma decisão central diferente:

1. O atendimento N1 precisa identificar a prioridade e encaminhar o incidente à equipe mais provável, com evidências.
2. A engenharia precisa validar tecnicamente a hipótese, investigar a causa e verificar a recuperação.
3. A gestão de produto precisa priorizar problemas de experiência e acompanhar melhorias mensuráveis.

## 2. Personas

### 2.1 Persona 1 - Matheus Souza

**Cargo:** Analista de Atendimento Técnico N1

**Classificação:** Persona operacional primária

**Responsabilidade:** Receber incidentes, interpretar evidências, estimar a criticidade e direcionar cada caso ao time adequado.

Matheus trabalha em regime operacional, inclusive durante plantões com pouca disponibilidade de especialistas. Recebe incidentes por telefone, e-mail, WhatsApp, alertas e registros internos. Frequentemente precisa tomar decisões a partir de informações incompletas e consultar diferentes ferramentas de telemetria para compreender a jornada do usuário e buscar a causa raiz.

<div align="center">
	<img src="../assets/persona1.png" alt="Imagem da Persona 1">
	<p><em>Figura 1 - Descrição da Persona 1. Fonte: Autoria própria, 2026.</em></p>
</div>

#### Principais dores

- Interpretar informações incompletas enviadas por usuários.
- Consultar várias ferramentas de telemetria para chegar a um diagnóstico.
- Não possuir uma visão ponta a ponta da jornada afetada.
- Definir a prioridade e a equipe responsável sem evidências consolidadas.

#### Necessidades na solução

- Visualizar incidentes e degradações detectados.
- Identificar quantas sessões ou pessoas usuárias foram afetadas.
- Consultar causas prováveis, níveis de confiança e evidências.
- Segmentar dados por dispositivo, versão, região, conteúdo, sinal, CDN e componente.
- Reunir dados e evidências para identificar a equipe ou fila mais provável.

#### Decisão central

> Para qual equipe devo encaminhar este incidente e quais evidências justificam essa decisão?

Matheus não corrige código, altera métricas nem configura componentes de produção por meio da plataforma.

### 2.2 Persona 2 - Giovanna Matsu

**Cargo:** Engenheira de Software

**Classificação:** Persona técnica primária

**Responsabilidade:** Validar diagnósticos, investigar tecnicamente as falhas, corrigir o componente sob sua responsabilidade e verificar se a experiência foi restabelecida.

Giovanna recebe incidentes encaminhados pelo atendimento N1 e também atua em degradações sistêmicas. Embora o chamado possa conter um pré-diagnóstico, ela precisa revalidar a hipótese, descartar relações com outros componentes e correlacionar dados dispersos em múltiplos sistemas. A investigação pode depender de combinações específicas de dispositivo, sistema, versão, região, conteúdo ou infraestrutura.

<div align="center">
	<img src="../assets/persona2.png" alt="Imagem da Persona 2">
	<p><em>Figura 2 - Descrição da Persona 2. Fonte: Autoria própria, 2026.</em></p>
</div>

#### Principais dores

- Revalidar pré-diagnósticos recebidos de outras equipes.
- Descartar manualmente hipóteses relacionadas a componentes que não originaram a falha.
- Interpretar fontes com métricas, granularidades e vocabulários diferentes.
- Investigar dados dispersos em múltiplos sistemas.
- Identificar falhas concentradas em uma combinação específica do ecossistema.

#### Necessidades na solução

- Acessar as evidências detalhadas de cada hipótese.
- Alternar entre o evento normalizado e a fonte original.
- Comparar versões, releases e períodos.
- Analisar os eventos anteriores e posteriores à falha.
- Confirmar, refutar ou marcar uma hipótese como inconclusiva.
- Comparar indicadores antes e depois de uma correção.

#### Decisão central

> A hipótese apresentada é tecnicamente válida e o que preciso corrigir no meu componente?

A correção, o deploy e o rollback permanecem nos repositórios e pipelines existentes; a plataforma apoia a investigação e a validação.

### 2.3 Persona 3 - Fernanda Oliveira

**Cargo:** Product Manager de Experiência do Globoplay

**Classificação:** Persona secundária, direcionada à evolução posterior ao núcleo técnico

**Responsabilidade:** Priorizar problemas de experiência e acompanhar se as correções produziram melhorias técnicas mensuráveis.

Fernanda acessa a plataforma periodicamente para transformar dados técnicos em uma visão estratégica do produto. Ela precisa compreender quais problemas afetam mais sessões e segmentos, comparar a experiência entre plataformas e acompanhar o histórico de degradações. Sua análise utiliza dados agregados e não exige acesso a logs brutos.

<div align="center">
	<img src="../assets/persona3.png" alt="Imagem da Persona 3">
	<p><em>Figura 3 - Descrição da Persona 3. Fonte: Autoria própria, 2026.</em></p>
</div>

#### Principais dores

- Traduzir falhas técnicas em impacto sobre a experiência.
- Depender da engenharia para obter análises.
- Ter pouca visibilidade sobre quais falhas devem receber prioridade.
- Consultar múltiplas plataformas para construir uma visão consolidada.
- Não possuir uma visão histórica das degradações e correções.

#### Necessidades na solução

- Consultar sessões e segmentos afetados de forma agregada.
- Comparar plataformas, versões, dispositivos e regiões.
- Acompanhar buffering, falhas de inicialização, latência e erros.
- Visualizar problemas recorrentes ordenados por impacto.
- Comparar indicadores antes e depois de uma correção.

#### Decisão central

> Qual problema de experiência deve ser priorizado e quanto a correção melhorou o produto?

A plataforma não deve atribuir causalidade a retenção, conversão, NPS ou satisfação enquanto essas fontes externas não estiverem integradas.

## 3. User Stories

As histórias foram escritas no formato **“como [quem], eu quero [o que], para [por que]”**. Cada história representa uma ação útil, vinculada a uma necessidade específica de uma persona e acompanhada por critérios de aceitação observáveis.

### 3.1 Critérios INVEST

As User Stories foram revisadas conforme os princípios INVEST:

| Critério | Aplicação neste documento |
|---|---|
| **Independente** | Cada história entrega uma capacidade identificável e pode ser priorizada separadamente, ainda que compartilhe dados e componentes com outras histórias. |
| **Negociável** | A história descreve a necessidade e o valor esperado; decisões detalhadas de interface e implementação permanecem abertas à discussão do time. |
| **Valiosa** | O benefício está explícito e associado a uma dor ou decisão da persona. |
| **Estimável** | O escopo e os critérios de aceitação tornam o trabalho compreensível para estimativa. |
| **Pequena** | Cada história se concentra em uma única intenção principal e pode ser entregue incrementalmente. |
| **Testável** | Os critérios de aceitação permitem verificar objetivamente o comportamento esperado. |

### 3.2 User Stories da Persona 1

#### US-N1-01 - Visualizar incidentes priorizados

**User Story:** Como analista de atendimento técnico N1, eu quero visualizar os incidentes e as degradações detectados, ordenados por severidade e quantidade de usuários afetados, para identificar rapidamente quais ocorrências exigem atendimento prioritário.

**Critérios de aceitação:**

- O sistema deve apresentar uma lista de incidentes ativos.
- Cada incidente deve exibir severidade, horário de início, status, quantidade estimada de usuários ou sessões afetadas e plataforma ou componente provavelmente envolvido.
- A lista deve permitir ordenação por severidade, impacto e horário.
- O sistema deve apresentar um gráfico com a evolução do número de sessões afetadas ao longo do tempo.
- O gráfico deve permitir alterar o período de visualização.
- Incidentes sem estimativa confiável devem ser identificados como “impacto ainda não determinado”.

**Fundamentação:** Matheus precisa transformar ocorrências vindas de diferentes canais em uma decisão de encaminhamento. O impacto estimado é um dos elementos centrais para definir a prioridade.

#### US-N1-02 - Consultar hipótese de causa provável

**User Story:** Como analista de atendimento técnico N1, eu quero visualizar a causa provável de um incidente e o nível de confiança dessa hipótese, para direcionar o chamado sem depender exclusivamente de tentativa e erro entre diferentes filas.

**Critérios de aceitação:**

- O sistema deve apresentar pelo menos uma hipótese de causa provável quando houver evidência suficiente.
- Hipóteses múltiplas devem ser ordenadas por probabilidade.
- Cada hipótese deve indicar componente associado, percentual ou faixa de confiança, resumo da justificativa e momento em que foi gerada.
- A interface não deve apresentar uma hipótese como causa confirmada.
- Quando não houver evidência suficiente, o sistema deve informar que a causa permanece inconclusiva.

**Fundamentação:** Um incidente pode circular entre equipes de player, CDN, TV, web, identidade e backend. A hipótese reduz encaminhamentos por tentativa e erro sem eliminar a validação humana.

#### US-N1-03 - Consultar evidências do diagnóstico

**User Story:** Como analista de atendimento técnico N1, eu quero consultar as evidências que sustentam a hipótese apresentada, para justificar o encaminhamento do incidente à equipe responsável.

**Critérios de aceitação:**

- Cada hipótese deve possuir uma seção de evidências associadas.
- As evidências devem indicar fonte, horário e relação com o incidente.
- O sistema deve contemplar evidências como aumento de erros, alteração de latência, queda de sessões e concentrações por dispositivo, versão, região ou CDN.
- Cada evidência deve poder ser expandida para exibir detalhes adicionais.
- Evidências ausentes, atrasadas ou de baixa qualidade devem ser sinalizadas.

**Fundamentação:** O encaminhamento precisa ser justificável mesmo quando a telemetria apresenta perda, atraso, duplicidade ou baixa qualidade.

#### US-N1-04 - Segmentar o incidente

**User Story:** Como analista de atendimento técnico N1, eu quero filtrar um incidente por dispositivo, versão do sistema, versão do aplicativo, região, conteúdo, CDN e componente, para identificar o recorte específico em que a falha está concentrada.

**Critérios de aceitação:**

- O sistema deve disponibilizar filtros cumulativos para período, dispositivo, sistema operacional, versão do aplicativo, região, UF ou POP, ISP, CDN, conteúdo ou sinal, componente e tipo de evento, conforme a disponibilidade dos dados.
- Os filtros devem sugerir apenas valores existentes no conjunto consultado.
- A quantidade de sessões e usuários afetados deve ser atualizada após a aplicação dos filtros.
- A pessoa usuária deve conseguir limpar todos os filtros.
- O recorte aplicado deve permanecer ao navegar entre telas relacionadas ao mesmo incidente.

**Fundamentação:** Médias gerais podem ocultar falhas que atingem uma combinação específica de modelo de TV, versão, região, ISP, conteúdo ou CDN.

#### US-N1-05 - Reunir insumos para o direcionamento

**User Story:** Como analista de atendimento técnico N1, eu quero ter dados e insumos suficientes para identificar a equipe ou fila mais provável para tratar o incidente, para reduzir encaminhamentos incorretos e o tempo gasto nas correções.

**Critérios de aceitação:**

- O sistema deve apresentar a hipótese mais provável, seu nível de confiança e as evidências associadas.
- Os dados devem permitir identificar os componentes possivelmente envolvidos, como player, CDN, backend, identidade, web, iOS, Android ou aplicação de TV.
- A plataforma deve apresentar o recorte afetado, incluindo dispositivo, versão, região, conteúdo ou infraestrutura, conforme a disponibilidade dos dados.
- A pessoa usuária deve poder copiar ou registrar um resumo com hipótese, evidências e recorte afetado.
- Quando as evidências envolverem mais de um componente, a plataforma deve deixar essa relação explícita para apoiar a avaliação do analista.
- A decisão sobre a equipe ou fila de encaminhamento deve permanecer sob responsabilidade do analista N1.
- A plataforma não deve corrigir código, alterar configurações nem publicar mudanças.

**Fundamentação:** O papel do N1 é interpretar as informações disponíveis e decidir o encaminhamento do incidente. A plataforma apoia essa decisão com hipóteses, evidências e contexto, sem assumir automaticamente qual equipe será responsável pelo tratamento.

### 3.3 User Stories da Persona 2

#### US-ENG-01 - Validar tecnicamente uma hipótese

**User Story:** Como engenheira de software especialista de componente, eu quero analisar a hipótese de causa provável e as evidências técnicas associadas, para confirmar ou refutar se o meu componente originou a degradação.

**Critérios de aceitação:**

- O sistema deve apresentar a hipótese, o nível de confiança e os componentes correlacionados ao incidente.
- A engenheira deve conseguir acessar todas as evidências relacionadas à hipótese e identificar suas fontes originais.
- A hipótese deve poder ser registrada como confirmada, refutada ou inconclusiva.
- O feedback não deve alterar automaticamente os dados históricos.
- A plataforma deve manter a decisão, a autoria e o horário do registro para consulta posterior.

**Fundamentação:** Especialistas precisam confirmar ou contestar hipóteses sem que o motor de diagnóstico dependa integralmente de revisão humana para funcionar.

#### US-ENG-02 - Navegar entre dado normalizado e fonte original

**User Story:** Como engenheira de software especialista de componente, eu quero alternar entre o evento normalizado e o dado bruto da fonte original, para verificar se a transformação preservou as informações necessárias ao diagnóstico.

**Critérios de aceitação:**

- O sistema deve disponibilizar a visualização do dado normalizado.
- Quando disponível, o dado bruto correspondente também deve ser acessível.
- A interface deve identificar fonte, entidade, métrica, timestamp, tags e valor.
- O sistema deve preservar a associação entre o registro normalizado e sua origem.
- Dados sem correspondência direta devem ser sinalizados.
- A visualização deve respeitar as regras de anonimização.

**Fundamentação:** A camada normalizada unifica os dados, mas a investigação técnica pode exigir a consulta às fontes detalhadas.

#### US-ENG-03 - Inspecionar a linha do tempo de uma sessão

**User Story:** Como engenheira de software especialista de componente, eu quero visualizar os eventos anteriores e posteriores a uma falha em uma única linha do tempo de sessão, para reconstruir a sequência técnica que levou ao problema.

**Critérios de aceitação:**

- Os eventos devem ser apresentados em ordem cronológica.
- A linha do tempo deve contemplar os tipos mínimos `request`, `vitals`, `screen_view`, `video_view`, `session` e `error`.
- Cada evento deve exibir horário, tipo, origem e principais atributos.
- Eventos correlacionados devem ser visualmente associados.
- Duplicidades, lacunas e atrasos de telemetria devem ser sinalizados.
- A linha do tempo deve permitir filtros por tipo de evento e componente.

**Fundamentação:** A reconstrução cronológica ajuda a compreender o contexto anterior à falha e seus efeitos posteriores.

#### US-ENG-04 - Comparar versões, releases e períodos

**User Story:** Como engenheira de software especialista de componente, eu quero comparar métricas entre versões, releases e períodos diferentes, para identificar se uma alteração recente está associada ao início da degradação.

**Critérios de aceitação:**

- O sistema deve permitir a seleção de dois ou mais períodos para comparação.
- A comparação deve contemplar versão do aplicativo, versão do sistema operacional, modelo de dispositivo e release ou momento de deploy, quando disponível.
- A interface deve apresentar a evolução temporal das métricas e destacar alterações relevantes após uma mudança de versão.
- O mesmo recorte de dispositivo, região ou conteúdo deve ser preservado entre os períodos.
- Quando a amostra for insuficiente, o sistema deve informar a limitação.

**Fundamentação:** Alterações de player ou aplicação podem provocar degradações concentradas em um modelo ou uma versão específica e desaparecer nos indicadores gerais.

#### US-ENG-05 - Verificar a recuperação após uma correção

**User Story:** Como engenheira de software especialista de componente, eu quero acompanhar os indicadores antes e depois da aplicação de uma correção, para verificar se a experiência retornou ao comportamento esperado.

**Critérios de aceitação:**

- A engenheira deve poder informar o momento aproximado da correção ou selecionar um marco registrado.
- O sistema deve comparar janelas anteriores e posteriores equivalentes.
- A comparação deve exibir taxa de erro, latência p95 e p99, tempo de início do vídeo, taxa de buffering, falha de inicialização, sessões afetadas e ANR, conforme a disponibilidade.
- O sistema deve indicar se os indicadores melhoraram, permaneceram estáveis ou pioraram.
- O resultado deve permanecer disponível no histórico do incidente.
- A plataforma não deve realizar rollback, deploy nem alteração de código.

**Fundamentação:** A correção ocorre nas ferramentas de engenharia; a plataforma verifica se os indicadores retornaram ao baseline esperado.

### 3.4 User Stories da Persona 3

As histórias da Persona 3 representam uma evolução posterior ao núcleo técnico. Elas utilizam informações agregadas e não pressupõem correlação comprovada com retenção, conversão, NPS ou satisfação enquanto essas fontes não estiverem integradas.

#### US-PM-01 - Priorizar problemas por impacto técnico

**User Story:** Como Product Manager de Experiência do Globoplay, eu quero visualizar os problemas recorrentes ordenados pelo número de sessões afetadas e pela intensidade da degradação, para priorizar as melhorias com maior impacto técnico sobre a experiência.

**Critérios de aceitação:**

- O sistema deve apresentar um ranking de problemas recorrentes.
- Cada problema deve indicar sessões afetadas, usuários estimados, duração, recorrência, plataformas afetadas e severidade.
- A lista deve permitir ordenação por impacto, frequência ou duração.
- A visão deve utilizar dados agregados e não exigir a leitura de stack traces ou logs brutos.
- O sistema não deve afirmar impacto em retenção, conversão ou NPS sem integração com essas fontes.

**Fundamentação:** Fernanda precisa decidir qual problema deve ser priorizado sem depender da engenharia para traduzir cada falha técnica.

#### US-PM-02 - Comparar a experiência entre segmentos

**User Story:** Como Product Manager de Experiência do Globoplay, eu quero comparar indicadores de experiência entre plataformas, versões, dispositivos e regiões, para identificar segmentos prejudicados mesmo quando os indicadores gerais parecem normais.

**Critérios de aceitação:**

- A interface deve permitir comparações por plataforma, dispositivo, sistema operacional, versão do aplicativo, região ou UF, ISP, CDN e conteúdo ou sinal.
- O sistema deve mostrar o tamanho de cada segmento analisado.
- A comparação deve incluir métricas de qualidade de experiência.
- Segmentos com amostra insuficiente devem ser sinalizados.
- Os resultados devem ser agregados e não expor identificadores individuais.

**Fundamentação:** Indicadores nacionais podem ocultar falhas graves em segmentos que representam uma parcela menor da audiência.

#### US-PM-03 - Acompanhar indicadores de qualidade de experiência

**User Story:** Como Product Manager de Experiência do Globoplay, eu quero acompanhar buffering, tempo de início do vídeo, falhas de inicialização, latência e erros, para avaliar a evolução técnica da experiência de streaming.

**Critérios de aceitação:**

- O sistema deve disponibilizar Video Start Time, Rebuffer Rate, Empty Buffer Video Seconds, bitrate médio, resolução, latência, falhas de inicialização e sessões com erro, conforme a disponibilidade.
- Os indicadores devem ser exibidos ao longo do tempo.
- Filtros globais devem poder ser aplicados à visualização.
- A interface deve informar a definição de cada indicador.
- Os dados devem ser agregados.
- A solução deve separar qualidade técnica de experiência de métricas externas de satisfação.

**Fundamentação:** As fontes de telemetria permitem acompanhar a qualidade técnica percebida sem inferir resultados de negócio ainda não integrados.

#### US-PM-04 - Avaliar a evolução após uma correção

**User Story:** Como Product Manager de Experiência do Globoplay, eu quero comparar os indicadores de experiência antes e depois de uma correção, para verificar se a mudança produziu uma melhoria técnica mensurável no segmento afetado.

**Critérios de aceitação:**

- A PM deve poder selecionar um incidente ou uma correção concluída.
- O sistema deve apresentar períodos comparáveis antes e depois da alteração.
- O mesmo segmento afetado deve ser preservado na comparação.
- A variação absoluta e percentual das métricas deve ser apresentada.
- A interface deve informar quando a diferença não for conclusiva.
- O sistema deve diferenciar correlação temporal de causalidade comprovada.
- A plataforma não deve atribuir melhoria de NPS, retenção ou conversão à correção sem dados externos.

**Fundamentação:** O escopo atual permite demonstrar a evolução técnica da experiência, mas não comprovar efeitos em indicadores externos de produto.

#### US-PM-05 - Consultar o histórico de degradações

**User Story:** Como Product Manager de Experiência do Globoplay, eu quero consultar o histórico de degradações e correções por período, plataforma e segmento, para identificar problemas recorrentes e orientar o planejamento do produto.

**Critérios de aceitação:**

- O sistema deve disponibilizar o histórico de incidentes e degradações.
- A PM deve poder filtrar um período de até um ano, conforme a retenção disponível.
- Cada registro deve apresentar início e fim da degradação, segmento afetado, impacto técnico, causa confirmada ou hipótese final, status da correção e evolução posterior.
- O sistema deve permitir a comparação de períodos sazonais equivalentes.
- Eventos planejados e testes de carga devem ser diferenciados de falhas não planejadas.
- A interface deve permitir identificar reincidências de um mesmo problema.

**Fundamentação:** O histórico possibilita reconhecer recorrências e comparar eventos sazonais, considerando a política de retenção da solução.

### 3.5 Priorização

Criamos uma matriz de priorização para organizar as User Stories em três níveis: essencial, importante e evolução. A priorização considera o valor para a persona, a dependência entre histórias e o esforço estimado.

| Prioridade | User Stories | Justificativa |
|---|---|---|
| **P0 - Essencial** | US-N1-01, US-N1-02, US-N1-03, US-N1-04, US-N1-05, US-ENG-01, US-ENG-02, US-ENG-03 | Forma o fluxo ponta a ponta de identificar, contextualizar, encaminhar e validar tecnicamente um incidente. |
| **P1 - Importante** | US-ENG-04, US-ENG-05 | Aprofunda a investigação e permite verificar a recuperação após uma mudança. |
| **P2 - Evolução** | US-PM-01, US-PM-02, US-PM-03, US-PM-04, US-PM-05 | Amplia o uso para acompanhamento agregado, priorização de produto e análise histórica. |

Essa priorização orienta o desenvolvimento incremental, garantindo que as funcionalidades essenciais sejam entregues primeiro, enquanto as melhorias e análises estratégicas são planejadas para fases posteriores.

## 4. Wireframes

Os wireframes de baixa fidelidade foram utilizados para validar a arquitetura da informação antes da aplicação da identidade visual. Eles definem a distribuição dos elementos, a hierarquia dos dados e as transições essenciais da investigação, sem antecipar decisões de cor ou acabamento. A prancha anexada ao projeto foi documentada abaixo por meio das seis telas que a compõem.

### 4.1 Login

<div align="center">
  <img src="../assets/wr-login.png" alt="Wireframe da tela de Login do View Show" style="max-width:800px;height:auto;">
  <p><em>Figura 4 - Wireframe da tela de Login. Fonte: Autoria própria (2026).</em></p>
</div>

### 4.2 Visão Geral

<div align="center">
  <img src="../assets/wr-visao-geral.png" alt="Wireframe da tela Visão Geral do View Show" style="max-width:800px;height:auto;">
  <p><em>Figura 5 - Wireframe da tela Visão Geral. Fonte: Autoria própria (2026).</em></p>
</div>

### 4.3 Incidentes

<div align="center">
  <img src="../assets/wr-incidentes.png" alt="Wireframe da tela de Incidentes do View Show" style="max-width:800px;height:auto;">
  <p><em>Figura 6 - Wireframe da tela de Incidentes. Fonte: Autoria própria (2026).</em></p>
</div>

### 4.4 Evidências

<div align="center">
  <img src="../assets/wr-evidencias.png" alt="Wireframe da tela de Evidências do View Show" style="max-width:800px;height:auto;">
  <p><em>Figura 7 - Wireframe da tela de Evidências. Fonte: Autoria própria (2026).</em></p>
</div>

### 4.5 Eventos

<div align="center">
  <img src="../assets/wr-eventos.png" alt="Wireframe da tela de Eventos do View Show" style="max-width:800px;height:auto;">
  <p><em>Figura 8 - Wireframe da tela de Eventos. Fonte: Autoria própria (2026).</em></p>
</div>

### 4.6 Monitoramento

<div align="center">
  <img src="../assets/wr-monitoramento.png" alt="Wireframe da tela de Monitoramento do View Show" style="max-width:800px;height:auto;">
  <p><em>Figura 9 - Wireframe da tela de Monitoramento. Fonte: Autoria própria (2026).</em></p>
</div>

## 5. Protótipo de alta fidelidade

O protótipo de alta fidelidade aplica a identidade do View Show aos wireframes e pode ser navegado no [arquivo do Figma](https://www.figma.com/design/kbq8niIkBCHz7oVr1t0Ogp/G05---View-Show?node-id=219-1437&t=nvQLc8FQxxXWXLwt-1). A interface usa navegação lateral persistente, filtros globais, cartões de KPI, gráficos e estados semânticos para manter contexto durante a investigação.

### 5.1 Login e acesso corporativo

<div align="center">
  <img src="../assets/prot-login.png" alt="Protótipo de alta fidelidade da tela de Login" style="max-width:800px;height:auto;">
  <p><em>Figura 10 - Protótipo da tela de Login. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** controlar o acesso à plataforma e identificar a pessoa usuária por meio de credenciais corporativas.

**Funcionalidades:** campos de e-mail e senha, recuperação de senha, entrada convencional e autenticação por SSO Globo. A tela também informa que o acesso é restrito a contas do domínio corporativo e apresenta as políticas internas de segurança.

### 5.2 Visão Geral

<div align="center">
  <img src="../assets/prot-geral.png" alt="Protótipo de alta fidelidade da tela Visão Geral" style="max-width:800px;height:auto;">
  <p><em>Figura 11 - Protótipo da tela Visão Geral. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** oferecer uma leitura rápida do estado do ecossistema e orientar a priorização das investigações.

**Funcionalidades:** cartões com taxa de erros, latência p95 e sessões afetadas; gráfico temporal da saúde da experiência; destaque da janela anômala; busca; filtros por período, dispositivo, região e versão; lista resumida de incidentes; e ações “Ver detalhes” e “Ver todos” para aprofundar a análise. A tela se relaciona principalmente com US-N1-01, US-PM-01 e US-PM-03.

### 5.3 Incidentes

<div align="center">
  <img src="../assets/prot-incidentes.png" alt="Protótipo de alta fidelidade da tela de Incidentes" style="max-width:800px;height:auto;">
  <p><em>Figura 12 - Protótipo da tela de Incidentes. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** reunir e ordenar os incidentes que exigem atenção para facilitar a escolha da ocorrência a ser investigada.

**Funcionalidades:** busca e filtros operacionais; gráfico dos dispositivos afetados por horário; diferenciação visual entre incidentes críticos e de alta severidade; ordenação por urgência; e lista com prioridade P1–P4, título, recorte afetado, número de dispositivos, horário de início e componente relacionado. O botão “Ver detalhes” abre o diagnóstico do incidente selecionado. A tela materializa principalmente US-N1-01 e US-N1-04.

### 5.4 Evidências e hipótese

<div align="center">
  <img src="../assets/prot-evidencias.png" alt="Protótipo de alta fidelidade da tela de Evidências" style="max-width:800px;height:auto;">
  <p><em>Figura 13 - Protótipo da tela de Evidências. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** apresentar a hipótese de causa provável e organizar as evidências que sustentam o diagnóstico do incidente.

**Funcionalidades:** resumo do incidente e das sessões afetadas; severidade e status da investigação; descrição da hipótese; componente associado; percentual de confiança; ações “Confirmar” e “Refutar”; gráfico de buffering; distribuição da concentração afetada; evidências agrupadas por fonte; e linha do tempo com deploys, alterações e eventos correlacionados. A tela se relaciona com US-N1-02 a US-N1-05, US-ENG-01 e US-ENG-04.

### 5.5 Eventos correlacionados

<div align="center">
  <img src="../assets/prot-eventos.png" alt="Protótipo de alta fidelidade da tela de Eventos" style="max-width:800px;height:auto;">
  <p><em>Figura 14 - Protótipo da tela de Eventos. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** permitir a inspeção dos eventos de telemetria relacionados à degradação e reconstruir seu contexto técnico.

**Funcionalidades:** busca e filtros globais; abas por tipo de evento (`request`, sinais vitais, tela, vídeo, sessão e erro); gráfico do volume temporal; identificação de janelas anômalas; seleção de fonte; tabela cronológica com horário, tipo, fonte, entidade, resumo e qualidade; rótulos de integridade como “vinculado”, “normalizado”, “atraso” e “possível duplicata”; e ação “Expandir” para consultar os detalhes do registro. A tela se relaciona principalmente com US-ENG-02 e US-ENG-03.

### 5.6 Monitoramento da telemetria

<div align="center">
  <img src="../assets/prot-monitoramento.png" alt="Protótipo de alta fidelidade da tela de Monitoramento" style="max-width:800px;height:auto;">
  <p><em>Figura 15 - Protótipo da tela de Monitoramento. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** acompanhar a saúde do pipeline de telemetria, a qualidade das fontes e a distribuição geográfica das instabilidades.

**Funcionalidades:** filtros por fonte, métrica, worker e janela de tempo; alerta de atraso de fonte; cartões de taxa de ingestão, latência de processamento, profundidade da fila e mensagens na DLQ; gráfico do fluxo de processamento; tabela com atualização, cobertura e estado das fontes; e mapa de concentração geográfica. A tela apoia US-ENG-04, US-ENG-05 e US-PM-02 a US-PM-05.

### 5.7 Configurações

<div align="center">
  <img src="../assets/prot-config.png" alt="Protótipo de alta fidelidade da tela de Configurações" style="max-width:800px;height:auto;">
  <p><em>Figura 16 - Protótipo da tela de Configurações. Fonte: Autoria própria (2026).</em></p>
</div>

**Objetivo:** centralizar os dados da conta, as preferências operacionais e os controles de acesso da pessoa usuária.

**Funcionalidades:** visualização e alteração da foto; dados de nome, e-mail, equipe e fuso horário; seleção do período padrão e da tela inicial; ativação de notificações para incidentes críticos e atrasos de telemetria; consulta e encerramento de sessões ativas; indicação do método de autenticação; e exclusão administrativa da conta na “Zona de risco”.

## 6. Fluxos de uso

### 6.1 Navegação principal

<div align="center">
  <img src="../assets/fluxo-de-uso.png" alt="Diagrama da navegação principal do View Show" style="max-width:1000px;height:auto;">
  <p><em>Figura 17 - Fluxo de uso e navegação principal. Fonte: Autoria própria (2026).</em></p>
</div>

Após a autenticação, a Visão Geral funciona como hub. A pessoa usuária pode seguir para Incidentes e aprofundar a análise em Evidências, ou explorar Eventos e acompanhar a saúde das fontes em Monitoramento. Configurações é uma ramificação transversal. Essa organização adota aprofundamento progressivo: primeiro o estado da operação, depois a ocorrência, em seguida a explicação e, por fim, os registros técnicos.

### 6.2 Priorização pelo atendimento N1

<div align="center">
  <img src="../assets/US-N1-01.png" alt="Fluxo da US-N1-01 entre Visão Geral e Incidentes" style="max-width:1000px;height:auto;">
  <p><em>Figura 18 - Fluxo da US-N1-01: priorização de incidentes. Fonte: Autoria própria (2026).</em></p>
</div>

O fluxo começa com a leitura do estado da operação e da lista resumida. Ao selecionar “Ver todos”, Matheus acessa a lista completa, compara urgência e impacto e escolhe o incidente que exige atendimento imediato.

### 6.3 Diagnóstico e encaminhamento pelo atendimento N1

<div align="center">
  <img src="../assets/US-N1-02 a US-N1-05.png" alt="Fluxo das US-N1-02 a US-N1-05 entre Incidentes e Evidências" style="max-width:1000px;height:auto;">
  <p><em>Figura 19 - Fluxo das US-N1-02 a US-N1-05: diagnóstico e encaminhamento. Fonte: Autoria própria (2026).</em></p>
</div>

Depois de abrir um incidente, Matheus encontra hipótese, nível de confiança, evidências, concentração do impacto e componentes envolvidos. O conjunto reduz encaminhamentos por tentativa e erro, mas preserva a responsabilidade do analista pela decisão final.

### 6.4 Validação e investigação pela engenharia

<div align="center">
  <img src="../assets/US-ENG-01 a US-ENG-03.png" alt="Fluxo das US-ENG-01 a US-ENG-03 entre Evidências e Eventos" style="max-width:1000px;height:auto;">
  <p><em>Figura 20 - Fluxo das US-ENG-01 a US-ENG-03: validação e eventos correlacionados. Fonte: Autoria própria (2026).</em></p>
</div>

Giovanna recebe o diagnóstico, confirma, refuta ou mantém a hipótese inconclusiva e aprofunda a análise em Eventos. A sequência conecta o resumo explicativo aos registros técnicos, reduzindo a troca de contexto entre ferramentas.

### 6.5 Comparação e verificação técnica

<div align="center">
  <img src="../assets/US-ENG-04 e US-ENG-05.png" alt="Fluxo das US-ENG-04 e US-ENG-05 entre Evidências e Monitoramento" style="max-width:1000px;height:auto;">
  <p><em>Figura 21 - Fluxo das US-ENG-04 e US-ENG-05: comparação e verificação. Fonte: Autoria própria (2026).</em></p>
</div>

A linha do tempo destaca mudanças potencialmente correlacionadas, enquanto o Monitoramento apresenta a integridade das fontes e a evolução dos indicadores utilizados na verificação técnica.

## 7. Decisões de UX e UI

### 7.1 Fundamentos visuais

<div align="center">
  <img src="../assets/fundations.png" alt="Fundamentos visuais do View Show" style="max-width:900px;height:auto;">
  <p><em>Figura 22 - Fundamentos de cor, tipografia, superfícies, bordas e raios. Fonte: Autoria própria (2026).</em></p>
</div>

A identidade combina azul (`#0D47D9`) e navy (`#101B46`) com laranja (`#FF6A32`) e vermelho (`#F43F4E`). O gradiente laranja–vermelho marca ações e estados de destaque; superfícies claras separam o conteúdo em cartões; Poppins estabelece uma hierarquia consistente entre títulos, rótulos e textos auxiliares. Bordas de 1 px e raio de 16 px organizam grupos sem aumentar excessivamente o peso visual.

Textos como “Crítico”, “P1” e “Atrasado” complementam as cores quentes e aplicam o princípio de redundância semântica recomendado para acessibilidade (WORLD WIDE WEB CONSORTIUM, 2024).

### 7.2 Marca

<div align="center">
  <img src="../assets/logos.png" alt="Variações da marca View Show" style="max-width:900px;height:auto;">
  <p><em>Figura 23 - Aplicações principal, em fundo escuro e monocromática da marca View Show. Fonte: Autoria própria (2026).</em></p>
</div>

A marca usa uma estrela central associada à ideia de visão e destaque, envolvida por um círculo em gradiente. As três versões garantem aplicação em superfícies claras, escuras e contextos monocromáticos. Na interface, a versão reduzida aparece na navegação lateral e no login, preservando reconhecimento sem competir com os dados operacionais.

### 7.3 Componentes reutilizáveis

<div align="center">
  <img src="../assets/componentes.png" alt="Biblioteca de componentes do View Show" style="max-width:900px;height:auto;">
  <p><em>Figura 24 - Componentes reutilizáveis criados. Fonte: Autoria própria (2026).</em></p>
</div>



## 8. Usabilidade e acessibilidade

As decisões foram analisadas a partir das heurísticas de Nielsen, das regras de ouro de Shneiderman e das WCAG 2.2. O protótipo busca explicar o sistema por meio de status, linguagem operacional, consistência e aprofundamento progressivo (NIELSEN, 1994; NIELSEN, 2024; SHNEIDERMAN et al., 2016).

| Princípio | Aplicação observada |
|---|---|
| **Visibilidade do status do sistema** | KPIs, janelas anômalas, níveis de confiança, estados de fonte e selos de prioridade comunicam a situação atual da operação. |
| **Correspondência com o mundo real** | A interface utiliza termos do domínio, como incidente, sessão afetada, componente, latência p95, deploy e fonte. |
| **Controle e liberdade** | Filtros, navegação persistente e ações de confirmar ou refutar mantêm a pessoa usuária no controle da investigação. |
| **Consistência e padrões** | Cartões, filtros, barra lateral, tipografia, espaçamento e códigos visuais se repetem de modo previsível entre as telas. |
| **Prevenção e recuperação de erros** | Estados de qualidade da telemetria evidenciam fontes atrasadas, parciais ou estáveis durante a análise. |
| **Reconhecimento em vez de memorização** | O contexto do incidente, as evidências e a linha do tempo permanecem visíveis durante o aprofundamento. |
| **Flexibilidade e eficiência** | Busca, filtros globais e aprofundamento progressivo apoiam tanto leituras rápidas quanto investigações técnicas. |
| **Design minimalista** | Cartões e espaços em branco agrupam os dados conforme a decisão apoiada por cada tela. |
| **Ajuda e documentação** | Títulos e subtítulos explicam a finalidade dos gráficos, tabelas, filtros e indicadores. |

Os selos textuais associados às cores, a hierarquia de títulos e a organização consistente dos controles contribuem para a percepção e a compreensão das informações, em alinhamento com as WCAG 2.2 (WORLD WIDE WEB CONSORTIUM, 2024).

## 9. Referências

ADAPTWORKS. **Como escrever as melhores User Stories com INVEST**. 2020. Disponível em: [https://blog.adapt.works/como-escrever-as-melhores-user-stories-com-invest/](https://blog.adapt.works/como-escrever-as-melhores-user-stories-com-invest/). Acesso em: 11 ago. 2026.

NIELSEN, Jakob. Enhancing the explanatory power of usability heuristics. In: CONFERENCE ON HUMAN FACTORS IN COMPUTING SYSTEMS, 1994, Boston. **Proceedings [...]** New York: ACM, 1994. p. 152-158. Disponível em: [https://doi.org/10.1145/191666.191729](https://doi.org/10.1145/191666.191729). Acesso em: 10 ago. 2026.

NIELSEN, Jakob. **10 usability heuristics for user interface design**. Nielsen Norman Group, 2024. Disponível em: [https://www.nngroup.com/articles/ten-usability-heuristics/](https://www.nngroup.com/articles/ten-usability-heuristics/). Acesso em: 11 ago. 2026.

SHNEIDERMAN, Ben et al. **Designing the user interface: strategies for effective human-computer interaction**. 6. ed. Boston: Pearson, 2016.

WORLD WIDE WEB CONSORTIUM. **Web Content Accessibility Guidelines (WCAG) 2.2**. W3C Recommendation, 2024. Disponível em: [https://www.w3.org/TR/WCAG22/](https://www.w3.org/TR/WCAG22/). Acesso em: 11 ago. 2026.
