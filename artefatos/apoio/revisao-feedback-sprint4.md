# Revisão dos apontamentos da Sprint 4 para a Sprint 5

Esta matriz relaciona os apontamentos relevantes aos artefatos da Sprint 5 às
evidências da entrega atual. Uma correção documental não aprova um requisito
reprovado em execução. O vídeo da Sprint 5 está em gravação; seu link e a
demonstração final continuam pendentes.

Os pareceres são G5-Sprint4-AplicacaoConteinerizada.docx,
G5-Sprint4-ArquiteturaFinal.docx e G5-Sprint4-Testes.docx. O
[registro de origem](../../assets/revisao-sprint5/2026-10-07/feedback-sprint4.json)
preserva o texto extraído e o SHA-256 de cada arquivo, sem alterar os originais.
O primeiro parecer apresenta valores diferentes no texto e na tabela de notas;
a revisão considera os apontamentos aplicáveis, sem recalcular a nota histórica.

## 1. Aplicação conteinerizada e arquitetura

| Apontamento da Sprint 4 | Tratamento na Sprint 5 | Estado e evidência |
| --- | --- | --- |
| Dockerfiles mostrados sem explicar escolhas | A aplicação final enumera base, dependências, estágios, cópias, inicialização, usuário, portas e contexto; explica por que os componentes diferem | Documentação corrigida: [seção 2](../sprint5/aplicacao-final.md#2-conteinerização-dos-componentes) |
| Worker sem base fixada por digest | Build e runtime usam o mesmo digest multi-plataforma verificado no registro Docker | Código corrigido em [Dockerfile](../../apps/backend/agentic/Dockerfile); exige nova publicação para mudar a imagem AWS |
| Kubernetes apenas como proposta, sem manifests ou execução | Terraform, renderer e chart Helm versionados; mapa individual de recursos; evidências EKS de nós, Jobs, HPA, probes e admissão | Implementado e medido: [aplicação](../sprint5/aplicacao-final.md), [índice AWS](../../assets/testes-carga/2026-10-06-fechamento-aws/README.md); vídeo atual pendente |
| Falta explicar limites do laboratório | Modo learner-lab-existing e compartilhamento LabRole documentados, separados de IRSA em produção | [Seção 5](../sprint5/aplicacao-final.md#5-implantação-no-aws-academy) |
| Resiliência apenas narrada | Falhas reais S3, MySQL, interrupção, backlog, reentrega e indisponibilidade; recuperação com escopo e tempos | [Resultados](../testes-carga-finais.md#43-resiliência-comportamento-recuperação-e-veredito); provocar falha e mostrar recuperação no vídeo ainda pendente |
| Filtros do contexto de build não identificados | Um .dockerignore por componente, com exclusões enumeradas | [Tabela 1 da aplicação](../sprint5/aplicacao-final.md#24-contextos-de-construção-e-imagem-mysql) |
| Lista de manifests sem conteúdo por arquivo | Cada arquivo ligado aos recursos, seletores, comandos, probes, agendas e componente do diagrama | [Seção 3](../sprint5/aplicacao-final.md#3-organização-dos-recursos-kubernetes), [inventário](testes-carga-inventario.md); valores realmente implementados, sem atribuir Ingress/KEDA ao runtime atual |
| Terraform, scripts e valores Helm complementares não enumerados | Arquivos e versões de controllers identificados; responsabilidades de Terraform e Helm separadas | [Seção 4](../sprint5/aplicacao-final.md#4-infraestrutura-e-configurações-complementares) |
| Restauração sem ponto consistente, troca de tabela e reconciliação | Runbook seleciona timestamp, restaura para tabela nova, confere S3/versionId/checkpoints, troca referências e IAM, valida e só então retoma | Procedimento corrigido: [recuperação](../../apps/kubernetes/RECUPERACAO.md); ensaio de desastre ainda não executado, PITR não declarado na IaC atual |
| Probes sem endpoint, períodos, timeouts ou limiares | Tabela explicita os parâmetros e diferencia reinício, progresso e limite de execução | [Seção 7 da aplicação](../sprint5/aplicacao-final.md#7-resiliência-e-recuperação-operacional); liveness/readiness ainda usam o mesmo endpoint e falham sob saturação |
| Sinal de progresso do worker ausente | Checkpoints duráveis, estado SUCCEEDED, confirmação SQS e heartbeat identificados; heartbeat de posse não é prova de progresso | [Runbook](../../apps/kubernetes/RECUPERACAO.md#2-detecção-de-falha-e-progresso) |
| Mensagens tratadas como preservadas indefinidamente | Retenção 14 dias, visibilidade 300 s, renovação, maxReceiveCount 5 e limites de retomada documentados | [Filas](../../apps/kubernetes/RECUPERACAO.md#3-filas-e-indisponibilidade-prolongada); contenção entre grupos e alerta lento permanecem reprovados |

## 2. Testes e exatidão dos resultados

| Apontamento da Sprint 4 | Tratamento na Sprint 5 | Estado e evidência |
| --- | --- | --- |
| IT-UPLOAD com cliente HTTP simulado descrito como integração real | Na Sprint 5, testes com dependências simuladas são classificados como componentes; a integração real precisa indicar API, destino e pós-condição verificada | Correção de classificação no artefato atual; o relatório da Sprint 4 permanece histórico |
| Pós-condições em memória apresentadas como prova persistida | Contagens locais, recontagens AWS e confirmações S3/DynamoDB têm escopos separados | [Resultados atuais](../testes-carga-finais.md#41-critério--medição--veredito); sem atribuir a ports em memória uma prova AWS |
| Nível 2 declarado como cerca de 30 mil requisições | Corrigido para 9.564 HTTP emitidas e 18.307 chegadas descartadas | Tabela reconciliada abaixo; errata apresentada na Sprint 5, sem editar o relatório histórico |
| Checks globais descritos como 100% | Publicados totais e falhas globais; checks condicionais podem passar sem inspecionar corpo não-200 | Nível 2: 16.140 falhas; Nível 3: 378 falhas; sem aprovação global de corretude |
| Números incompatíveis com os brutos | Na Sprint 5, tabelas geradas dos JSON; auditor confere contadores globais, individuais e percentuais | [reconcile-evidence.py](../../apps/backend/api/loadtest/scripts/reconcile-evidence.py), executado também no CI |

Os apontamentos de UT04 duplicado e de valor limite dos testes funcionais
não estão sendo corrigidos nesta revisão: os dois artefatos da Sprint 5 não
reutilizam essas afirmações de cobertura. Não se declara nova aprovação de
casos unitários ou limites que não foram executados na bateria publicada.

## 3. Reconciliação numérica

<!-- BEGIN K6 RECONCILIATION -->
| Ambiente / rodada | Requisições HTTP | Checks aprovados / total | Checks falhos | Falha HTTP | p95 geral / HTTP 200 (ms) | Chegadas descartadas |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| [Sprint 4 / ECS / Nível 2](../../assets/testes-funcionais/2026-09-21/resumo-nivel2.json) | 9.564 | 17.729/33.869 (52,35%) | 16.140 | 84,38% | 60.000,23 / 27.368,00 | 18.307 |
| [Sprint 4 / ECS / Nível 3](../../assets/testes-funcionais/2026-09-21/resumo-nivel3.json) | 4.874 | 17.343/17.721 (97,87%) | 378 | 2,48% | 57.152,15 / não exportado | 19.077 |
| [Sprint 5 / EKS / API-137](../../assets/testes-carga/2026-10-06-fechamento-aws/eks-native/api-load-137/resumo-front-api-load.json) | 43.198 | 7.013/89.931 (7,80%) | 82.918 | 93,99% | 8.000,51 / 7.078,57 | 1.003 |
<!-- END K6 RECONCILIATION -->

No Nível 2, as 16.140 falhas se dividem em 8.070 checks de status/página e
8.070 de eco X-Request-Id. No Nível 3, são 257 de status/página e 121 de eco.
No cenário EKS API-137, são 41.459 de contrato e 41.459 de eco.
Isso não comprova corrupção dos dados: comprova falhas dos checks e impede
aprovar o conjunto. Os checks históricos de schema retornam verdadeiro quando
a resposta não é 200; seus passes incluem casos sem inspeção de conteúdo.
Portanto, zero falhas nesse subconjunto não comprova integridade de toda a
carga nem contagem dos dados persistidos. Recontagem é uma evidência separada.

O auditor reconcilia a tabela com o JSON e rejeita divergências. Os JSON
históricos permanecem intactos. O relatório
[reconciliacao-k6.json](../../assets/revisao-sprint5/2026-10-07/reconciliacao-k6.json)
preserva todos os checks falhos e hashes das fontes.

## 4. Verificação desta revisão

O auditor confere links/JSON/fontes e as tabelas reconciliadas. Quatro controles
negativos demonstram que contagem HTTP alterada, aprovação de checks inventada
e supressão de falhas são rejeitadas. Os 17 testes de renderização Kubernetes
passaram e o build Docker da nova base fixada do worker terminou com sucesso.
O [índice da revisão](../../assets/revisao-sprint5/2026-10-07/README.md) preserva
as saídas e o escopo de cada verificação.

Um teste funcional local exploratório, fora da bateria de carga, teve 3/4 casos
aprovados: um caso esperava 503 e recebeu 409. A
[saída integral](../../assets/revisao-sprint5/2026-10-07/api-local-e2e.txt)
foi preservada; a causa não foi investigada nesta revisão documental. Não se
declara aprovação dessa suíte ou integração AWS a partir desse resultado.
Relatórios e testes funcionais históricos não foram alterados.

## 5. Pendências de comprovação final

| Pendência | Aceite para encerrar |
| --- | --- |
| Vídeo em gravação | Link acessível, duração de 5 a 7 minutos, Docker e Kubernetes operando e falha provocada com recuperação |
| Integração AWS da revisão final | Registrar commit/digests, executar o fluxo completo e conferir pós-condição no DynamoDB/S3 reais |
| Desempenho EKS | Corrigir e repetir nominal 150 mil/900 s e API 137/s; resultados anteriores continuam reprovados |
| Ensaio de recuperação de dados | Ambiente isolado, backup prévio, reconciliação, troca de destino e tempos RPO/RTO medidos |
| Observabilidade de produção após integração | Séries dos quatro indicadores, IDs de correlação, queries válidas e medição de recuperação na mesma janela |

Esta revisão confere os dois artefatos da Sprint 5 e as evidências que eles
apresentam. Relatórios e testes da Sprint 4 permanecem como histórico. As
pendências acima só podem ser encerradas com evidência da execução correspondente; não são preenchidas com resultados de outro ambiente.
