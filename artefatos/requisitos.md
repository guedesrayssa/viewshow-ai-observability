# Especificação de Requisitos: Monitoramento de Frontend Globoplay

> Este documento descreve a **especificação de requisitos** do sistema de [descrever brevemente o sistema] desenhado para o parceiro **Globo**. O foco aqui é amarrar as necessidades de negócio levantadas na elicitação com os artefatos técnicos de engenharia de software: requisitos funcionais (RF), requisitos não funcionais (RNF) baseados na norma ISO/IEC 25010 e seus respectivos planos de teste.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Alinhamento com a elicitação do parceiro](#2-alinhamento-com-a-elicitação-do-parceiro)
3. [Requisitos Funcionais (RF)](#3-requisitos-funcionais-rf)
4. [Requisitos Não Funcionais (RNF) e Planos de Teste](#4-requisitos-não-funcionais-rnf-e-planos-de-teste)
5. [Procedimento de testes e validação](#5-procedimento-de-testes-e-validação)
6. [Itens avaliados](#6-itens-avaliados)

---

## 1. Visão geral

&emsp; [Descreva brevemente o que é o sistema, seu propósito principal e como ele se insere no contexto da Globo/Globoplay.]

```text
┌──────────────────────────┐
│  [Componente 1]          │   [Descrição do componente]
│  [Ex: Front-end]         │   - [Responsabilidade principal]
└──────────┬───────────────┘
           │ [Ação/Comunicação]
           ▼
┌──────────────────────────┐
│  [Componente 2]          │   [Descrição do componente]
│  [Ex: Back-end API]      │   - [Responsabilidade principal]
└──────────┬───────────────┘
           │ [Ação/Comunicação]
           ▼
┌──────────────────────────┐
│  [Componente 3]          │   [Descrição do componente]
│  [Ex: Modelo de ML]      │   - [Responsabilidade principal]
└──────────────────────────┘
```

&emsp; [Adicione um parágrafo explicando brevemente o fluxo de dados ou a interação entre os blocos ilustrados no diagrama acima.]

---

## 2. Alinhamento com a elicitação do parceiro

&emsp; [Descreva como os requisitos levantados se conectam com as dores e necessidades mapeadas durante as reuniões com os especialistas da Globo. Mencione os problemas atuais e como o sistema proposto visa resolvê-los.]

&emsp; [Detalhe os impactos esperados no negócio (ex: redução de tempo de triagem, automação) que justificam a construção da solução.]

---

## 3. Requisitos Funcionais (RF)

&emsp; [Breve texto introdutório explicando que a tabela a seguir lista as funcionalidades principais que o sistema deve executar para atender ao negócio.]

<div align="center">

<sup>Tabela 1: Conjunto de Requisitos Funcionais (RF)</sup>

| ID | Descrição do Requisito | Alinhamento com a Elicitação (Globo) |
|:---|:---|:---|
| **RF01** | [O que o sistema deve fazer. Ex: Prover endpoint para ingestão de logs...] | [Por que a Globo precisa disso.] |
| **RF02** | [O que o sistema deve fazer. Ex: Processar logs em um modelo de ML...] | [Por que a Globo precisa disso.] |
| **RF03** | [O que o sistema deve fazer. Ex: Exibir dashboard estilo Grafana...] | [Por que a Globo precisa disso.] |
| **RF04** | [O que o sistema deve fazer.] | [Por que a Globo precisa disso.] |
| **RF05** | [O que o sistema deve fazer.] | [Por que a Globo precisa disso.] |

<sup>Fonte: material produzido pelos autores (2026).</sup>

</div>

---

## 4. Requisitos Não Funcionais (RNF) e Planos de Teste

&emsp; Os requisitos não funcionais a seguir foram definidos com base nas características de qualidade da norma ISO/IEC 25010, cobrindo Eficiência de Desempenho, Confiabilidade, Segurança, Portabilidade, Adequação Funcional, Usabilidade, Compatibilidade e Manutenibilidade. Como o projeto está em fase de ideação e será construído em um prazo de 10 semanas, os planos de teste descritos abaixo assumem um ambiente simulado, com dados sintéticos. Testes de carga, disponibilidade e volume utilizam janelas de validação compactadas (da ordem de horas a no máximo 3 dias corridos), em vez de monitoramento de produção em larga escala.

<div align="center">

<sup>Tabela 2: Requisitos Não Funcionais e Planos de Teste (ISO 25010)</sup>

| ID | Categoria (ISO 25010) | Descrição do Requisito | Plano de Teste (Validação) |
|:---|:---|:---|:---|
| **RNF01** | **Eficiência de Desempenho** *(Capacidade)* | O serviço consumidor (worker) deve escalar horizontalmente para processar picos massivos na fila, equivalentes a 50 milhões de eventos simultâneos (semelhante à final do BBB), sem gerar acúmulo crítico de mensagens. | **Teste de Carga Simulada:** injetar lotes massivos de mensagens sintéticas na fila em ambiente de homologação (staging) e monitorar as métricas do consumidor; o teste passa se o sistema aciona novas instâncias automaticamente e estabiliza o consumo sem acúmulo crescente. |
| **RNF02** | **Eficiência de Desempenho** *(Comportamento Temporal)* | O tempo total entre a captura do evento na fila, sua normalização, a inferência pelo modelo de ML e a gravação final para consulta não deve ultrapassar 2 minutos. | **Teste de Latência Ponta a Ponta:** injetar um evento de teste com timestamp conhecido na fila e consultar continuamente a API do dashboard; o teste passa se o dado aparecer na query com delta de tempo de até 120 segundos. |
| **RNF03** | **Confiabilidade** *(Tolerância a Falhas)* | O worker de normalização não deve falhar ou parar o consumo ao encontrar payloads inválidos ou corrompidos, devendo redirecionar essas mensagens para uma Dead Letter Queue (DLQ). | **Teste de Isolamento de Falhas:** publicar intencionalmente mensagens corrompidas (ex: JSON quebrado) misturadas a mensagens válidas; o teste passa se o sistema move as mensagens corrompidas para a DLQ sem interromper o processamento do lote. |
| **RNF04** | **Segurança** *(Confidencialidade)* | O painel de visualização e as APIs de consulta devem permitir acesso apenas via autenticação centralizada (SSO), restrita exclusivamente aos e-mails do domínio corporativo da Globo. | **Teste de Controle de Acesso:** realizar tentativas automatizadas de login com e-mails externos e chamadas sem token; o teste passa se o sistema barrar o acesso e retornar erro HTTP 401/403 em todos os casos. |
| **RNF05** | **Eficiência de Desempenho** *(Utilização de Recursos)* | O sistema deve manter dados de até 30 dias em armazenamento de acesso rápido (Hot Storage) e os 11 meses restantes em armazenamento de baixo custo (Cold Storage), viabilizando histórico de 1 ano. | **Teste de Política de Ciclo de Vida:** analisar os scripts de infraestrutura (IaC) e validar se as políticas de ciclo de vida (Lifecycle Policies) do banco de dados/armazenamento estão configuradas para transição automática dos dados após 30 dias. |
| **RNF06** | **Portabilidade** *(Adaptabilidade)* | Os serviços de normalização e ML devem ser empacotados em contêineres independentes, permitindo execução em infraestruturas elásticas na nuvem sem dependência de hardware específico. | **Teste de Compilação Limpa (Build):** gerar a imagem do contêiner (Docker) em ambiente limpo, sem configurações prévias; o teste passa se a aplicação iniciar usando apenas variáveis de ambiente, sem exigir configuração manual no sistema operacional. |
| **RNF07** | **Eficiência de Desempenho** *(Comportamento Temporal)* | A interface web do dashboard deve carregar seus componentes principais e filtros visuais em menos de 30 segundos, medidos pela métrica de Primeira Renderização de Conteúdo (First Contentful Paint - FCP). | **Teste de Performance de Frontend:** executar auditorias com as ferramentas Google Lighthouse ou Playwright; o teste passa se o tempo de Primeira Renderização de Conteúdo (FCP) for ≤ 30,0s mesmo com os gráficos renderizados. |
| **RNF08** | **Adequação Funcional** *(Correção Funcional)* | O modelo de ML deve atingir um F1-Score ≥ 80% na classificação da causa raiz da falha, garantindo confiabilidade do diagnóstico exibido no dashboard. | **Teste de Métricas do Modelo:** avaliar o modelo contra um conjunto de validação reservado para teste (holdout), sintético, construído a partir dos cenários de falha simulados no projeto, calculando as métricas de Precisão (Precision), Sensibilidade (Recall) e F1-Score; o teste passa se o F1-Score for ≥ 80%. |
| **RNF09** | **Confiabilidade** *(Disponibilidade)* | O dashboard e as APIs de consulta devem manter disponibilidade mínima de 99,9%. | **Teste de Disponibilidade Simulada:** dado o prazo do projeto (10 semanas) e o uso de dados simulados nesta fase, executar verificações de integridade (health-checks) automatizadas a cada 1 minuto durante uma janela contínua de até 3 dias (72h) em ambiente de homologação (staging), provocando ao menos 3 falhas induzidas (encerramento forçado do contêiner); o teste passa se a disponibilidade observada na janela for ≥ 99,9% e o serviço se recuperar automaticamente em até 2 minutos após cada falha induzida. |
| **RNF10** | **Usabilidade** *(Operacionalidade)* | Um operador deve conseguir localizar a causa raiz de uma falha reportada em até 5 cliques a partir da tela inicial do dashboard. | **Teste de Usabilidade Guiada:** executar um cenário de falha simulada com um usuário operador e medir o número de cliques até a identificação da causa raiz; o teste passa se a causa for encontrada em até 5 cliques. |
| **RNF11** | **Compatibilidade** *(Interoperabilidade)* | O worker de normalização deve aceitar e converter eventos de múltiplas plataformas (Smart TV, iOS, Android, Web) com estruturas de dados (schemas) distintas, sem exigir alteração de código por cliente. | **Teste de Normalização Multi-Formato:** enviar payloads (pacotes de dados) de exemplo simulando cada plataforma-alvo com estrutura diferente; o teste passa se todos forem convertidos corretamente para o formato interno padronizado, sem erros ou perda de campos. |
| **RNF12** | **Manutenibilidade** *(Testabilidade)* | Os serviços de normalização e ML devem manter cobertura mínima de testes automatizados de 70%, permitindo manutenção segura por múltiplos desenvolvedores. | **Teste de Cobertura na Integração Contínua (CI):** executar a ferramenta de cobertura de testes (ex: Jest, coverage.py) na pipeline de Integração Contínua (CI) a cada push (envio de código); o teste passa se o percentual reportado for ≥ 70% e o pipeline bloquear a integração automaticamente quando a cobertura cair abaixo do limite. |
| **RNF13** | **Eficiência de Desempenho** *(Utilização de Recursos)* | O modelo de ML deve utilizar, como contexto para o diagnóstico, somente os registros de log (logs) das últimas 5 horas do dispositivo que reportou a falha, limitando o volume de dados processado por diagnóstico e mantendo o custo computacional previsível. | **Teste de Janela de Contexto Temporal:** injetar um histórico de logs sintético com mais de 5 horas de duração para um dispositivo de teste e verificar, por meio de instrumentação do worker de ML, quais registros são efetivamente enviados ao modelo; o teste passa se apenas os eventos dentro da janela das 5 horas anteriores ao evento de falha forem considerados no diagnóstico. |

<sup>Fonte: material produzido pelos autores (2026).</sup>

</div>

---

## 5. Procedimento de testes e validação

&emsp; [Descreva de forma geral como e onde os testes listados na Seção 4 serão executados ao longo do projeto. Mencione possíveis ferramentas a serem utilizadas (ex: JMeter, K6, notebooks Jupyter para o ML, Lighthouse para o frontend).]

&emsp; [Adicione detalhes sobre quando essa validação será feita (ex: durante a pipeline de CI/CD, validação manual, etc).]

---

## 6. Itens avaliados

&emsp; [Texto opcional mapeando a entrega aos critérios da rubrica para facilitar a correção da faculdade. Exemplo:]
1. **(RF):** [Indique onde os requisitos funcionais estão e como estão numerados]
2. **(Elicitação):** [Indique como o alinhamento com a Globo foi garantido]
3. **(RNF / ISO 25010):** [Indique a tabela que mapeia as categorias da ISO 25010]
4. **(Planos de teste):** [Indique onde os planos textuais podem ser encontrados]