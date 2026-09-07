# Especificação de Requisitos: Monitoramento de Frontend Globoplay

> Este documento descreve a **especificação de requisitos** do sistema de [descrever brevemente o sistema] desenhado para o parceiro **Globo**. O foco aqui é amarrar as necessidades de negócio levantadas na elicitação com os artefatos técnicos de engenharia de software: requisitos funcionais (RF), requisitos não funcionais (RNF) baseados na norma ISO/IEC 25010 e seus respectivos planos de teste.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Requisitos Funcionais (RF)](#2-requisitos-funcionais-rf)
3. [Alinhamento com a elicitação do parceiro](#3-alinhamento-com-a-elicitação-do-parceiro)
4. [Requisitos Não Funcionais (RNF) e Planos de Teste](#4-requisitos-não-funcionais-rnf-e-planos-de-teste)
   - 4.1. [Atributos de Qualidade](#41-atributos-de-qualidade)
   - 4.2. [Requisitos de Interface Externa (RIE)](#42-requisitos-de-interface-externa-rie)
   - 4.3. [Restrições (RESTR)](#43-restrições-restr)
5. [Procedimento de testes e validação](#5-procedimento-de-testes-e-validação)
6. [Referências](#6-referências)

---

## 1. Visão geral

&emsp; O sistema é uma plataforma distribuída de telemetria proprietária, desenvolvida para o Globoplay, com o objetivo de coletar, normalizar e diagnosticar eventos operacionais e de qualidade de experiência (QoE) emitidos pelos frontends do produto, independentemente de dispositivo, sistema operacional ou protocolo de comunicação. A solução existe porque as plataformas de monitoração de mercado assumem protocolos modernos e homogêneos e não cobrem a base real de dispositivos em uso pelo Globoplay, que inclui Smart TVs legadas (fabricadas entre 2013 e 2026), com pouca capacidade de processamento e sem suporte a SDKs modernos de telemetria.

&emsp; Dois conceitos aparecem no fluxo abaixo e merecem definição antes do diagrama. Armazenamento hot e cold são dois níveis de armazenamento com custo e velocidade de acesso diferentes: o hot guarda os dados mais recentes em um meio rápido (e mais caro), usado nas consultas do dia a dia; o cold guarda o histórico mais antigo em um meio mais barato (e mais lento), usado apenas quando é preciso investigar um evento passado. Já o modelo de ML (Machine Learning, ou aprendizado de máquina) é o componente que analisa os registros recentes de um dispositivo com falha e sugere automaticamente a causa raiz mais provável, reduzindo o trabalho manual de investigação.

<div align="center">

<sup>Diagrama 1: Fluxo de dados da plataforma de telemetria</sup>

```text
┌────────────────────────────┐
│ Frontends multiplataforma  │  Emitem eventos (request, vitals, screen_view,
│ (Smart TV, mobile, web)    │  video_view, session, error)
└──────────────┬─────────────┘
               │ protocolo moderno ou legado
               ▼
┌────────────────────────────┐
│ API de Ingestão            │  Recebe e valida o payload bruto,
│                             │  publica na fila sem perda de dados
└──────────────┬─────────────┘
               │ mensagem enfileirada
               ▼
┌────────────────────────────┐
│ Worker de Normalização     │  Converte cada schema de origem para o
│                             │  formato interno padronizado (signal_point)
└──────────────┬─────────────┘
               │ evento normalizado
      ┌────────┴────────┐
      ▼                 ▼
┌───────────────┐ ┌───────────────────┐
│ Armazenamento │ │ Modelo de ML       │  Diagnóstico de causa raiz
│ hot (30d) /   │ │ (janela de 5h de   │  usando as últimas 5h de logs
│ cold (11m)    │ │ logs do device)    │  do dispositivo com falha
└───────┬───────┘ └─────────┬──────────┘
        └────────┬──────────┘
                  ▼
      ┌────────────────────────┐
      │ Dashboard / API         │  Filtros cumulativos, alertas
      │ de consulta             │  operacionais, exportação (CSV/XLSX/PDF)
      └────────────────────────┘
```

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

&emsp; O fluxo começa nos frontends, que emitem eventos brutos para uma API única de ingestão, capaz de aceitar tanto protocolos modernos quanto legados. Cada evento é publicado em uma fila, garantindo que picos de tráfego (ex: estreias, jogos ao vivo) não gerem perda de dados mesmo com o consumo acontecendo de forma assíncrona. Um worker consome a fila e normaliza o payload, independente da plataforma de origem, para um esquema interno padronizado (signal_point), que alimenta tanto o armazenamento (hot para os últimos 30 dias, cold para o restante do histórico de 1 ano) quanto o modelo de ML responsável por inferir a causa raiz de falhas a partir da janela recente de logs do dispositivo afetado. O resultado fica disponível no dashboard e nas APIs de consulta, usados pelas equipes de engenharia, observabilidade e produto para diagnóstico e acompanhamento de qualidade. O desenho segue as práticas de arquitetura cloud native descritas por Hassan (2024): fila assíncrona entre ingestão e processamento, workers stateless e serviços empacotados em contêineres independentes, o que sustenta diretamente os requisitos de escala do RNF01 e de portabilidade do RNF06.

---

## 2. Requisitos Funcionais (RF)

&emsp; Os requisitos funcionais (RF) a seguir descrevem as funcionalidades que o sistema deve oferecer para atender à necessidade de observabilidade do Globoplay apresentada na Seção 1. Cada requisito recebe um ID sequencial (RF01 a RF10) e é acompanhado da evidência de elicitação que o originou, coletada nas reuniões com os especialistas da Globo; a Seção 3 detalha como esse conjunto de requisitos se conecta às dores levantadas com o parceiro.

<div align="center">

<sup>Tabela 1: Conjunto de Requisitos Funcionais (RF)</sup>

| ID | Descrição do Requisito | Alinhamento com a Elicitação (Globo) |
|:---|:---|:---|
| **RF01** | Ingestão de eventos multiplataforma: o sistema deve receber e armazenar eventos de frontend do Globoplay oriundos de diferentes dispositivos e plataformas (TVs, mobile, web), incluindo dispositivos com suporte limitado a padrões atuais de coleta de telemetria. | A solução deve contemplar plataformas distintas como iOS, Android, Android TV, webOS, Fire TV, tvOS e navegadores web (Quicksilver), com suporte a Smart TVs fabricadas entre 2013 e 2026. O campo App Target das amostras confirma a heterogeneidade real: dom-philco-netrange-2021, dom-samsung-tizen-2017, dom-panasonic_s-linux-unknown, dom-tcl-linux-2018, dom-lg-webos-2017, plataformas com pouca memória/CPU e sem suporte a SDKs modernos de telemetria. |
| **RF02** | Ingestão de eventos: o sistema deve receber e armazenar os eventos publicados pelas aplicações frontend do Globoplay. | Eventos podem chegar duplicados, com pequenas diferenças de timestamp, exigindo regra de tolerância temporal no pipeline. O consumo via fila/camada intermediária, em quase tempo real, é a arquitetura adotada para viabilizar este requisito (ver Seção 1), uma decisão de arquitetura/tecnologia, não parte da descrição funcional. A meta de escala sem perda de dados sob picos de acesso está quantificada no RNF01 (Capacidade) e no RNF03 (Tolerância a Falhas), para não duplicar aqui uma meta de qualidade que já tem requisito próprio. |
| **RF03** | Normalização dos dados: o sistema deve normalizar os eventos recebidos, independentemente do protocolo/formato de origem, para um formato padronizado interno antes de armazená-los. | Cada área técnica tem seu próprio padrão de monitoração (Prometheus, NewRelic, Apollo GraphQL etc.). Os 6 exemplos de evento já compartilham um envelope comum (Timestamp, App Bucket, App Env, App Target, App Version, Device Id, Device Manufacturer, Device Model, Device Model Year, Device Os, Device Os Version, Event Name, Session Id), o que facilita a normalização. |
| **RF04** | Autenticação corporativa: o sistema deve permitir que usuários autorizados do domínio corporativo da Globo iniciem e encerrem uma sessão por meio do provedor de identidade corporativo, sem cadastro ou validação local de senha. | A regra funcional foi alinhada à autenticação centralizada estabelecida em RNF04, RIE01 e RESTR01. Formulários locais de e-mail e senha existentes no protótipo constituem uma limitação transitória da implementação e não representam uma alternativa válida para o produto-alvo. |
| **RF05** | Visualização de dados brutos e normalizados: o sistema deve permitir a visualização tanto dos dados injetados (brutos) quanto dos dados já normalizados. | "Bruto" é o evento como chegou pela API de ingestão; "normalizado" é o dado no esquema padronizado (signal_point). Visualizar o dado bruto ajuda a auditar se a normalização preservou o significado original de cada campo. |
| **RF06** | Cobertura mínima de eventos (MVP): o sistema deve coletar, no mínimo, request (status e latência), vitals (ANR), screen_view (carregamento de página e tempo), video_view (carregamento de mídia, status e tempo), session (início/app startup) e error (todo tipo de erro, incluindo falhas originadas nos demais eventos). | Confirmado com amostras reais (uma por tipo), batendo com a lista mínima do MVP. Campos específicos incluem Duration, Route Params/Path, Media Id/Kind, Error Message/Name/Stack, entre outros. Nenhuma amostra trouxe região/UF/POP; campos unknown aparecem de fato nos dados (Device Os Version, Device Model Year). |
| **RF07** | Dashboard de navegação em eventos: o sistema deve disponibilizar um dashboard para navegação e visualização gráfica dos eventos coletados. | Apontar o problema, a origem provável, as evidências e o recorte afetado, com aprofundamento progressivo. Evitar o uso de métricas brutas. Uso de filtros cumulativos com sugestão de valores recebidos é requisitado. |
| **RF08** | Métricas e alertas operacionais: o sistema deve disponibilizar métricas operacionais e alertas relacionados à qualidade de experiência e à ocorrência de falhas, para apoiar equipes de engenharia e observabilidade. | Um alerta deve conter, sem dado PII: modelo do dispositivo, versão do SO e do app, identificador anonimizado, conteúdo/série/episódio, região/POP, sinal, métricas de saúde (ex.: p95/p99 de latência) e estimativa de usuários afetados. |
| **RF09** | Consultas para análise de falhas críticas: o sistema deve disponibilizar consultas simples e filtradas voltadas à identificação e análise de falhas críticas nos eventos armazenados. | Evitando erros como freezing de TV, transição IPv4/IPv6 e falha de DNS em modelo específico. |
| **RF10** | Exportação de dados: o sistema deve permitir a exportação dos dados consultados/filtrados. | Seguindo os formatos planilha (CSV/XLSX) e PDF. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

---

## 3. Alinhamento com a elicitação do parceiro

&emsp; Os requisitos funcionais apresentados na Seção 2 foram derivados diretamente das dores e necessidades levantadas nas reuniões de elicitação com os especialistas do Grupo Globo (times de engenharia, observabilidade e produto do Globoplay) e formalizadas no Termo de Abertura de Projeto (TAPI) assinado com o parceiro. A Tabela 2 resume essa rastreabilidade, ligando cada dor elicitada aos RFs que a endereçam.

<div align="center">

<sup>Tabela 2: Rastreabilidade entre a elicitação com a Globo e os Requisitos Funcionais</sup>

| Dor / necessidade elicitada com a Globo | RFs relacionados | Impacto de negócio esperado |
|:---|:---|:---|
| Alta diversidade de dispositivos, SOs e protocolos que as ferramentas de monitoração de mercado não cobrem (Smart TVs de 2013 a 2026, com pouca memória/CPU e sem SDKs modernos de telemetria) | RF01, RF03, RF06 | Visibilidade sobre 100% da base instalada e redução de custo com ferramentas externas que hoje não atendem à realidade do produto |
| Falta de visibilidade operacional do frontend, aumentando o tempo de diagnóstico de incidentes e dificultando a análise de experiência do usuário | RF02, RF07, RF08, RF09 | Aceleração da resolução de incidentes, aumento da eficiência operacional e contribuição ao cumprimento dos níveis de serviço (SLA) |
| Necessidade de confiar que a normalização preserva o significado original de cada campo, dado que cada área técnica hoje usa um padrão próprio de monitoração | RF05 | Confiabilidade do diagnóstico apresentado no dashboard e capacidade de auditoria do pipeline |
| Restrição contratual de não compartilhar dados e desafios do projeto com terceiros | RF04 | Controle de acesso restrito ao domínio corporativo da Globo, sem exposição de dados para fora da organização |
| Necessidade das equipes de produto e observabilidade de levar recortes de dados para análises e relatórios fora da plataforma | RF10 | Autonomia das equipes de observabilidade e produto na investigação de incidentes |

<sup>Fonte: Material produzido pelos autores (2026), com base na elicitação e no TAPI do parceiro.</sup>

</div>

&emsp; Em conjunto, esses requisitos endereçam o problema central levantado pela Globo: a ausência de uma ferramenta de monitoração proprietária capaz de cobrir toda a base heterogênea de dispositivos do Globoplay eleva o tempo de diagnóstico de incidentes e o custo com soluções externas que não atendem integralmente à realidade do produto. Ao resolver essa lacuna, o sistema proposto viabiliza a detecção precoce de degradações, a identificação de padrões não perceptíveis em métricas agregadas e a redução do tempo até a causa raiz, justificando o investimento tanto pela redução de custo operacional quanto pelo ganho direto em qualidade de experiência para o usuário final.

---

## 4. Requisitos Não Funcionais (RNF) e Planos de Teste

&emsp; Os requisitos não funcionais a seguir estabelecem sob que condições o sistema deve operar e o que limita as alternativas de solução do projeto. Seguindo a estrutura de especificação de requisitos da ISO/IEC/IEEE 29148 (2018), estão separados em atributos de qualidade (Seção 4.1), requisitos de interface externa (Seção 4.2) e restrições (Seção 4.3), cada um acompanhado do critério que comprova seu atendimento. Como o projeto está em fase de ideação e será construído em um prazo de 10 semanas, os planos de teste descritos abaixo assumem um ambiente simulado, com dados sintéticos, e utilizam janelas de validação compactadas (da ordem de horas a no máximo 3 dias corridos), em vez de monitoramento de produção em larga escala.

### 4.1. Atributos de Qualidade

&emsp; Os atributos de qualidade a seguir foram definidos com base nas características da norma ISO/IEC 25010 (INTERNATIONAL ORGANIZATION FOR STANDARDIZATION, 2011), cobrindo Eficiência de Desempenho, Confiabilidade, Segurança, Portabilidade, Adequação Funcional, Usabilidade, Compatibilidade e Manutenibilidade. Mantêm o identificador RNF já referenciado nas Seções 1, 2 e 5.

<div align="center">

<sup>Tabela 3: Atributos de Qualidade e Planos de Teste (ISO 25010)</sup>

| ID | Categoria (ISO 25010) | Descrição do Requisito | Plano de Teste (Validação) |
|:---|:---|:---|:---|
| **RNF01** | **Eficiência de Desempenho** *(Capacidade)* | O serviço consumidor (worker) deve escalar horizontalmente para processar picos massivos na fila, equivalentes a 50 milhões de eventos simultâneos (semelhante à final do BBB), sem gerar acúmulo crítico de mensagens. | **Teste de Carga Simulada:** injetar lotes massivos de mensagens sintéticas na fila em ambiente de homologação (staging) e monitorar as métricas do consumidor; o teste passa se o sistema aciona novas instâncias automaticamente e estabiliza o consumo sem acúmulo crescente. |
| **RNF02** | **Eficiência de Desempenho** *(Comportamento Temporal)* | O tempo total entre a captura do evento na fila, sua normalização, a inferência pelo modelo de ML e a gravação final para consulta não deve ultrapassar 2 minutos. | **Teste de Latência Ponta a Ponta:** injetar um evento de teste com timestamp conhecido na fila e consultar continuamente a API do dashboard; o teste passa se o dado aparecer na query com delta de tempo de até 120 segundos. |
| **RNF03** | **Confiabilidade** *(Tolerância a Falhas)* | O worker de normalização não deve falhar ou parar o consumo ao encontrar payloads inválidos ou corrompidos: o processamento do lote deve continuar, isolando apenas a(s) mensagem(ns) problemática(s). | **Teste de Isolamento de Falhas:** publicar intencionalmente mensagens corrompidas (ex: JSON quebrado) misturadas a mensagens válidas; o teste passa se o sistema isola as mensagens corrompidas (ex.: via Dead Letter Queue) sem interromper o processamento do lote. |
| **RNF04** | **Segurança** *(Confidencialidade)* | O painel de visualização e as APIs de consulta devem permitir acesso apenas via autenticação centralizada (SSO), restrita exclusivamente aos e-mails do domínio corporativo da Globo. | **Teste de Controle de Acesso:** realizar tentativas automatizadas de login com e-mails externos e chamadas sem token; o teste passa se o sistema barrar o acesso e retornar erro HTTP 401/403 em todos os casos. |
| **RNF05** | **Eficiência de Desempenho** *(Utilização de Recursos)* | O sistema deve manter dados de até 30 dias em armazenamento de acesso rápido (Hot Storage) e os 11 meses restantes em armazenamento de baixo custo (Cold Storage), viabilizando histórico de 1 ano. | **Teste de Política de Ciclo de Vida:** analisar os scripts de infraestrutura (IaC) e validar se as políticas de ciclo de vida (Lifecycle Policies) do banco de dados/armazenamento estão configuradas para transição automática dos dados após 30 dias. |
| **RNF06** | **Portabilidade** *(Adaptabilidade)* | Os serviços de normalização e ML devem ser empacotados em contêineres independentes, permitindo execução em infraestruturas elásticas na nuvem sem dependência de hardware específico. | **Teste de Compilação Limpa (Build):** gerar a imagem do contêiner (Docker) em ambiente limpo, sem configurações prévias; o teste passa se a aplicação iniciar usando apenas variáveis de ambiente, sem exigir configuração manual no sistema operacional. |
| **RNF07** | **Eficiência de Desempenho** *(Comportamento Temporal)* | A interface web do dashboard deve carregar seus componentes principais e filtros visuais em menos de 30 segundos, medidos pela métrica de Primeira Renderização de Conteúdo (First Contentful Paint - FCP). | **Teste de Performance de Frontend:** executar auditorias com as ferramentas Google Lighthouse ou Playwright; o teste passa se o tempo de Primeira Renderização de Conteúdo (FCP) for ≤ 30,0s mesmo com os gráficos renderizados. |
| **RNF08** | **Adequação Funcional** *(Correção Funcional)* | O modelo de ML deve atingir um F1-Score ≥ 80% na classificação da causa raiz da falha, garantindo confiabilidade do diagnóstico exibido no dashboard. | **Teste de Métricas do Modelo:** avaliar o modelo contra um conjunto de validação reservado para teste (holdout), sintético, construído a partir dos cenários de falha simulados no projeto, calculando as métricas de Precisão (Precision), Sensibilidade (Recall) e F1-Score; o teste passa se o F1-Score for ≥ 80%. |
| **RNF09** | **Confiabilidade** *(Disponibilidade)* | O dashboard e as APIs de consulta devem manter disponibilidade mínima de 99,9%. | **Teste de Disponibilidade Simulada:** dado o prazo do projeto (10 semanas) e o uso de dados simulados nesta fase, executar verificações de integridade (health-checks) automatizadas a cada 1 minuto durante uma janela contínua de até 12 horas em ambiente de homologação (staging), provocando ao menos 3 falhas induzidas (encerramento forçado do contêiner); o teste passa se a disponibilidade observada na janela for ≥ 99,9% e o serviço se recuperar automaticamente em até 2 minutos após cada falha induzida. |
| **RNF10** | **Usabilidade** *(Operacionalidade)* | Um operador deve conseguir localizar a causa raiz de uma falha reportada em até 5 cliques a partir da tela inicial do dashboard. | **Teste de Usabilidade Guiada:** executar um cenário de falha simulada com um usuário operador e medir o número de cliques até a identificação da causa raiz; o teste passa se a causa for encontrada em até 5 cliques. |
| **RNF11** | **Compatibilidade** *(Interoperabilidade)* | O worker de normalização deve aceitar e converter eventos de múltiplas plataformas (Smart TV, iOS, Android, Web) com estruturas de dados (schemas) distintas, sem exigir alteração de código por cliente. | **Teste de Normalização Multi-Formato:** enviar payloads (pacotes de dados) de exemplo simulando cada plataforma-alvo com estrutura diferente; o teste passa se todos forem convertidos corretamente para o formato interno padronizado, sem erros ou perda de campos. |
| **RNF12** | **Manutenibilidade** *(Testabilidade)* | Os serviços de normalização e ML devem manter cobertura mínima de testes automatizados de 70%, permitindo manutenção segura por múltiplos desenvolvedores. | **Teste de Cobertura na Integração Contínua (CI):** executar a ferramenta de cobertura de testes (ex: Jest, coverage.py) na pipeline de Integração Contínua (CI) a cada push (envio de código); o teste passa se o percentual reportado for ≥ 70% e o pipeline bloquear a integração automaticamente quando a cobertura cair abaixo do limite. |
| **RNF13** | **Eficiência de Desempenho** *(Utilização de Recursos)* | O modelo de ML deve utilizar, como contexto para o diagnóstico, somente os registros de log (logs) das últimas 5 horas do dispositivo que reportou a falha, limitando o volume de dados processado por diagnóstico e mantendo o custo computacional previsível. | **Teste de Janela de Contexto Temporal:** injetar um histórico de logs sintético com mais de 5 horas de duração para um dispositivo de teste e verificar, por meio de instrumentação do worker de ML, quais registros são efetivamente enviados ao modelo; o teste passa se apenas os eventos dentro da janela das 5 horas anteriores ao evento de falha forem considerados no diagnóstico. |
| **RNF14** | **Eficiência de Desempenho** *(Comportamento Temporal)* | O dashboard e as APIs de consulta devem retornar os resultados de uma busca filtrada em até 2 segundos para 95% das solicitações (P95). | **Teste de Latência de Consulta:** disparar um lote de buscas filtradas sintéticas (variando dispositivo, período e tipo de evento) contra o ambiente de homologação e medir o tempo de resposta de cada uma; o teste passa se o percentil 95 (P95) do tempo de resposta for ≤ 2 segundos. |
| **RNF15** | **Confiabilidade** *(Capacidade de Recuperação)* | Uma degradação de qualidade de experiência (ex.: aumento anormal de erros ou de latência) deve ser sinalizada ao operador em até 30 segundos após o recebimento dos eventos que permitam sua detecção. | **Teste de Tempo de Alerta:** injetar uma sequência de eventos sintéticos que caracterize uma degradação (ex.: pico de erros de um modelo de dispositivo) e cronometrar o intervalo entre o último evento injetado e o disparo do alerta correspondente; o teste passa se o alerta for emitido em até 30 segundos. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 4.2. Requisitos de Interface Externa (RIE)

&emsp; Os requisitos de interface externa a seguir descrevem os pontos de troca de dados entre o sistema e aplicações mantidas fora do projeto, cujo comportamento não pode ser alterado por ele, definindo o dado trocado e a resposta esperada em cada sentido. O RIE01 viabiliza o controle de acesso de RF04 e RNF04; o RIE02 é a porta de entrada dos eventos tratados em RF01, RF02 e RF03.

<div align="center">

<sup>Tabela 4: Requisitos de Interface Externa e Planos de Teste</sup>

| ID | Sistema externo | Descrição do Requisito | Plano de Teste (Validação) |
|:---|:---|:---|:---|
| **RIE01** | Serviço corporativo de autenticação da Globo (SSO) | O sistema deve enviar as credenciais do usuário ao serviço corporativo de autenticação por meio de requisição HTTPS e receber como resposta o token de sessão e o e-mail institucional associado, utilizados para autorizar o acesso ao dashboard e às APIs de consulta. | **Teste de Integração com o Provedor de Identidade:** substituir o serviço real por um simulador (mock) configurado para devolver token válido, token expirado e credencial de domínio externo; o teste passa se o acesso for liberado apenas na primeira situação e o sistema responder HTTP 401/403 nas demais, sem persistir credencial em base local. |
| **RIE02** | Frontends do Globoplay (Smart TV, mobile, web) | O sistema deve expor uma API de ingestão que recebe os eventos de telemetria emitidos pelos frontends do Globoplay nos protocolos moderno e legado descritos na Seção 1, respondendo confirmação de recebimento ao emissor somente após a publicação do evento na fila. | **Teste de Contrato da API de Ingestão:** enviar payloads de exemplo de cada plataforma-alvo pelos dois protocolos suportados e inspecionar o conteúdo da fila; o teste passa se todo evento confirmado ao emissor estiver presente na fila e se payloads fora do contrato forem rejeitados com erro explícito, sem confirmação de recebimento. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

### 4.3. Restrições (RESTR)

&emsp; As restrições a seguir delimitam o espaço de solução do projeto antes de qualquer decisão de arquitetura e, por descreverem propriedades da solução construída e não comportamentos observáveis em execução, são verificadas por inspeção. As decisões de plataforma de implantação, como banco de dados, sistema operacional dos servidores e linguagem da aplicação, permanecem em aberto nesta fase e serão incorporadas à tabela quando definidas.

<div align="center">

<sup>Tabela 5: Restrições e Formas de Verificação</sup>

| ID | Origem | Descrição do Requisito | Verificação |
|:---|:---|:---|:---|
| **RESTR01** | Organizacional (política de acesso corporativo da Globo) | A autenticação de usuários deve ser delegada ao serviço corporativo de autenticação já existente na Globo, não cabendo ao sistema armazenar senhas nem implementar rotina própria de validação de credencial. | **Inspeção de Arquitetura e do Esquema de Dados:** revisar o módulo de autenticação e o modelo do banco de dados; a verificação passa se não houver campo de senha persistido nem rotina própria de hash ou validação de credencial, e se todo fluxo de login delegar ao provedor corporativo especificado no RIE01. |
| **RESTR02** | Técnica (base instalada de dispositivos do Globoplay) | O sistema deve processar os eventos no formato em que os dispositivos clientes já os emitem, não podendo condicionar seu funcionamento à atualização do sistema operacional, do firmware ou do aplicativo instalado nesses dispositivos. | **Inspeção do Contrato de Ingestão:** confrontar os formatos aceitos pelo pipeline com as amostras reais de evento das plataformas legadas listadas no RF01; a verificação passa se nenhuma delas exigir alteração no dispositivo emissor para ser aceita e normalizada. |

<sup>Fonte: Material produzido pelos autores (2026).</sup>

</div>

---

## 5. Procedimento de testes e validação

&emsp; Os planos de teste descritos nas Tabelas 3 a 5 (Seção 4) são executados em ambiente de homologação (staging, um ambiente de testes separado do ambiente usado pelos usuários reais), com dados sintéticos (dados fictícios, gerados propositalmente para simular o cenário de uso, sem envolver usuários reais), dado que o projeto está em fase de ideação e tem prazo de 10 semanas. A validação está organizada em cinco frentes, cada uma com ferramenta e cadência próprias:

- **Pipeline de integração e entrega contínua (CI/CD, a cada push de código):** cobertura mínima de testes automatizados (RNF12, medida com ferramentas como Jest ou coverage.py) e build (processo de compilação e empacotamento) limpo dos contêineres de normalização e ML (RNF06); ambos bloqueiam a integração automaticamente quando o critério não é atendido.
- **Carga e disponibilidade (janelas de até 12 horas corridas, em staging):** capacidade de escala do worker sob picos massivos (RNF01) e latência ponta a ponta (RNF02), medidas com ferramentas de teste de carga que simulam grandes volumes de requisições (K6 ou JMeter); disponibilidade do dashboard e das APIs (RNF09), com verificações automáticas de integridade (health-checks) a cada 1 minuto e falhas induzidas (desligamento forçado de um contêiner); a política de ciclo de vida do armazenamento hot/cold definido na Seção 1 (RNF05), validada por inspeção do código que descreve a infraestrutura (IaC, sigla de Infraestrutura como Código); latência de busca no dashboard (RNF14), medida com o mesmo tipo de ferramenta de carga sobre a API de consulta; e tempo de sinalização de degradação ao operador (RNF15), cronometrado sobre o pipeline de alertas.
- **Modelo de ML e frontend (execução manual, antes de cada entrega):** qualidade do diagnóstico de causa raiz (RNF08), avaliada em um notebook Jupyter (ambiente interativo de execução de código Python) contra um conjunto de dados separado exclusivamente para teste e nunca usado no treinamento do modelo, chamado de conjunto de holdout, calculando as métricas de precisão, sensibilidade e F1-Score já descritas na Tabela 3; performance de carregamento do dashboard (RNF07), auditada com ferramentas de análise automática de páginas web (Google Lighthouse ou Playwright); e usabilidade do fluxo de diagnóstico (RNF10), validada com uma sessão guiada com um operador real do sistema.
- **Segurança e compatibilidade (execução manual, antes de cada entrega):** controle de acesso restrito ao domínio Globo (RNF04), testado com tentativas automatizadas de login externo e chamadas sem token de autenticação; tolerância a payloads (pacotes de dados recebidos) corrompidos (RNF03), testada com mensagens em formato inválido misturadas ao lote de mensagens válidas; e normalização multi-formato (RNF11), testada com pacotes de exemplo de cada plataforma-alvo.
- **Interfaces externas e restrições (testes de integração/revisão de arquitetura, antes de cada entrega):** autenticação via SSO corporativo (RIE01, RESTR01), testada com mocks (simulações) do serviço de autenticação retornando respostas válidas e inválidas; recebimento de eventos pela API de ingestão (RIE02), testado com o mesmo lote de payloads multi-plataforma usado na validação do RNF11; e ausência de exigência de modificação do sistema operacional dos dispositivos clientes (RESTR02), validada por inspeção da especificação de coleta (SDK/agente de telemetria) frente aos dispositivos legados citados no RF01.

&emsp; A execução é responsabilidade do time técnico do grupo. Para os requisitos com maior risco de negócio, RNF04 (segurança/confidencialidade) e RNF08 (qualidade do diagnóstico exibido ao parceiro), os resultados dos testes são revisados também com o líder técnico da Globo, garantindo que os critérios de aceite reflitam o contexto real de uso do Globoplay e não apenas o ambiente simulado do projeto.

---

## 6. Referências

HASSAN, Abdullah Abu. **Step by step practical guide to architecting cloud native applications**. Microsoft Tech Community, 15 fev. 2024. Disponível em: https://techcommunity.microsoft.com/blog/appsonazureblog/step-by-step-practical-guide-to-architecting-cloud-native-applications/4057960. Acesso em: 10 ago. 2026.

INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. **ISO/IEC 25010:2011**: systems and software engineering — systems and software quality requirements and evaluation (SQuaRE) — system and software quality models. Geneva: ISO/IEC, 2011.

INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. **ISO/IEC/IEEE 29148:2018**: systems and software engineering — life cycle processes — requirements engineering. Geneva: ISO/IEC/IEEE, 2018.
