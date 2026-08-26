# Auditoria: contrato do dashboard versus implementação atual

Data da auditoria: 2026-08-26  
Contrato de referência: dashboard-api-contract.md  
Backend auditado: origin/feat/backend-2, commit 0d31802  
Frontend auditado: origin/develop, commit fbf28c2

## 1. Objetivo

Este documento compara, sem alterar a definição oficial do contrato:

- O que o frontend operacional precisa consumir.
- O que a branch feat/backend-2 disponibiliza atualmente.
- Quais diferenças precisam ser consideradas numa futura integração.
- Quais dados ainda não possuem uma fonte produtiva confirmada.

Este arquivo não redefine endpoints nem DTOs. Em caso de divergência, o
contrato oficial está em dashboard-api-contract.md.

## 2. Escopo auditado

Backend Node:

- apps/backend/api/src/routes
- apps/backend/api/src/services
- apps/backend/api/src/db
- apps/backend/api/src/orchestrator
- apps/backend/api/src/agent
- apps/backend/api/scripts/seed.js
- apps/backend/api/deploy/task-definition.json
- artefatos/decisoes.md

Frontend:

- Visão Geral.
- Incidentes.
- Evidências.
- Eventos.
- Monitoramento.
- Dados mockados e tipos locais dessas telas.
- Protótipos exportados em assets.
- Documentação de UX e histórias de usuário.

Dados:

- Documentação e schema do dataset Argus.
- Artefatos agregados registrados em dashboard_artifact.
- Amostras CSV das seis categorias de evento.
- Documentação da ingestão e cobertura.

Fora da comparação:

- Flask inicial, exceto para confirmar que sua tabela telemetry é legada.
- Autenticação e Configurações.
- BigQuery, pois não possui registros da Globo e não será usado nesta versão.

## 3. Estado das branches remotas

Na última atualização do remoto:

| Branch | Commit | Situação |
|---|---|---|
| origin/develop | fbf28c2 | Frontend mais completo; inclui Eventos |
| origin/feat/backend-2 | 0d31802 | Backend Node e frontend sem os arquivos novos de Eventos |
| origin/feat/frontend-evidencias | db0e038 | Já incorporada ao frontend mais recente |
| origin/feat/frontend-incidentes | 435ff9d | Já incorporada ao frontend mais recente |

Não existe branch remota adicional com uma página dinâmica de detalhe de
incidente. As branches de frontend auditadas já estão contidas em develop.

## 4. Rotas existentes em feat/backend-2

Rotas públicas ou atualmente expostas:

| Método | Caminho atual |
|---|---|
| GET | /health |
| POST | /auth/login |
| POST | /auth/sso |
| GET | /api/v1/incidents |
| GET | /api/v1/incidents/:id |
| GET | /api/v1/incidents/:id/evidence |
| GET | /api/v1/incidents/:id/hypothesis |
| PATCH | /api/v1/incidents/:id/hypothesis/review |
| POST | /api/v1/incidents/:id/diagnose |
| GET | /api/v1/dashboard/summary |
| GET | /api/v1/golden-set |
| POST | /api/v1/ml/analyze |

O contrato-alvo consolida leituras fragmentadas e mantém golden set, ML e
diagnóstico disparado como responsabilidades internas.

## 5. Matriz de aderência por endpoint

| Contrato-alvo | Estado atual | Aderência | Diferença principal |
|---|---|---:|---|
| GET /dashboard/overview | GET /dashboard/summary | Parcial | O atual agrega incidentes, mas não entrega KPIs reais, série, anomalias, frescor ou facetas |
| GET /incidents | GET /incidents | Parcial | Faltam paginação, busca ampliada, facetas, filtros, série empilhada e envelope comum |
| GET /incidents/{id}/diagnosis | GET /incidents/{id}, /evidence e /hypothesis | Parcial | Três leituras, uma hipótese, sem séries, concentração, timeline ou qualidade |
| PATCH /incidents/{id}/hypotheses/{hypothesisId}/review | PATCH /incidents/{id}/hypothesis/review | Parcial | Falta hypothesisId, inconclusive, nota, versionamento e conflito otimista |
| GET /incidents/{id}/events | Inexistente | Ausente | Frontend inteiro usa mock |
| GET /incidents/{id}/events/{eventId} | Inexistente | Ausente | Não há detalhe normalizado ou raw sanitizado |
| GET /monitoring/overview | Inexistente | Ausente | Frontend inteiro usa mock |

## 6. Visão Geral

### Implementação atual

GET /api/v1/dashboard/summary deriva informações dos incidentes armazenados.
O código soma o campo devices e apresenta esse resultado como sessões
afetadas.

### Necessidade do frontend

- Erros por minuto.
- Latência p95.
- Sessões afetadas e participação nas sessões observadas.
- Comparação com baseline.
- Série de saúde da experiência.
- Janela de anomalia.
- Incidentes recentes.
- Filtros e facetas.
- Frescor e parcialidade.

### Lacunas

- A soma de devices não pode ser chamada de sessões.
- Não existem erros por minuto ou latência p95 reais.
- Não existe linha de base.
- Não existem séries temporais.
- A resposta retorna strings prontas para exibição em alguns fluxos.
- Não existe envelope data/meta.

## 7. Incidentes

### Implementação atual

GET /api/v1/incidents aceita window, deviceType, region e appVersion.
O serviço consulta buckets horários na tabela operacional e devolve os itens
do DynamoDB.

### Necessidade do frontend

- Busca.
- Prioridade e status.
- Dispositivo, sistema, versão, região, UF, ISP, CDN, conteúdo, componente e
  tipo de evento.
- Ordenação por prioridade, impacto e mais recente.
- Paginação por cursor.
- Facetas derivadas dos dados existentes.
- Série de impacto verdadeiramente empilhada por prioridade.
- Estado de impacto medido, estimado ou desconhecido.
- Estado resumido do diagnóstico.

### Lacunas

- A resposta atual não possui paginação.
- Não existem facetas.
- Parte relevante dos filtros não existe.
- O serviço retorna o formato persistido, sem DTO público dedicado.
- Campos como startedMinutesAgo, timeAgo, segment e sessions já estão
  formatados.
- Não há separação confiável entre dispositivos e sessões.
- O frontend cria o gráfico de impacto a partir de mocks.
- A busca não possui índice ou tokens normalizados.

## 8. Diagnóstico e evidências

### Implementação atual

O backend possui:

- Detalhe de incidente.
- Lista de evidências.
- Hipótese mais recente.
- Disparo de diagnóstico.
- Revisão confirmed/refuted.

### Necessidade do frontend

- Uma fotografia consistente do incidente e diagnóstico.
- Múltiplas hipóteses ordenadas.
- Probabilidades e hipótese principal.
- Evidências relacionadas às hipóteses.
- Relação supports, contradicts ou context.
- Série de buffering e baseline.
- Concentração por dispositivo, região e outras dimensões.
- Timeline de deploys e anomalias.
- Estado de qualidade e cobertura.
- Revisão inconclusive e concorrência otimista.

### Lacunas

- O backend retorna somente a hipótese mais recente.
- A tela precisa coordenar três requests para montar um contexto parcial.
- Não há buffering, concentração ou timeline.
- Não há versionamento da revisão.
- O body atual aceita somente confirmed ou refuted.
- Não existe estado inconclusive.
- Evidências atuais possuem descrição livre e campos mínimos.
- O endpoint POST /diagnose está exposto publicamente, embora seja uma
  operação de orquestração e não uma leitura do dashboard.

## 9. Eventos

### Frontend atual

A tela de Eventos existe no commit mais recente de develop e usa mocks para:

- Seis categorias: request, vitals, screen_view, video_view, session e error.
- Contagem por categoria.
- Série de volume e janela anômala.
- Busca e filtros.
- Dado normalizado e origem.
- Qualidade: vinculado, normalizado, atrasado e possível duplicata.

A rota do frontend é global, /eventos, mas o recorte inicial está fixado no
INC-4821.

### Backend atual

Não existem endpoints de Eventos em feat/backend-2.

### Dados disponíveis

Foram encontrados seis CSVs de exemplo, um por categoria. Eles contêm campos
úteis para definir schemas, mas não há mapeamento confirmado de uma fonte
produtiva.

O Argus auditado é predominantemente agregado. Não é possível reconstruir
eventos individuais completos a partir de agregados.

### Lacunas e restrições

- Falta endpoint de listagem e detalhe.
- Falta fonte produtiva das seis categorias.
- Falta correlação estável com incidentId.
- Falta sanitização de payload bruto.
- As amostras contêm IDs e campos semelhantes a authorization; não podem ser
  expostas diretamente.
- A página precisa receber incidentId explicitamente, sem incidente padrão.
- Até existir a fonte, capabilities deve declarar individualEvents como
  partial ou unavailable.

## 10. Monitoramento

### Frontend atual

A tela usa mocks para:

- Taxa de ingestão.
- Latência de processamento.
- Profundidade da fila.
- DLQ.
- Gráfico por etapa.
- Estado, cobertura e atualização das fontes.
- Concentração geográfica.

### Backend atual

Não existe endpoint de monitoramento em feat/backend-2.

### Disponibilidade das fontes

O Argus pode fornecer:

- Cobertura e atualização.
- Métricas agregadas de QoE.
- Concentração geográfica.
- Artefatos coverage, coverage_alert, geo_map, geo_hourly e collector_run.

O Argus não fornece diretamente:

- Profundidade da fila SQS.
- DLQ.
- Estado de ECS workers.
- Latência interna de cada etapa do pipeline.

Essas métricas precisam ser materializadas pela infraestrutura do pipeline a
partir de SQS, ECS, CloudWatch ou mecanismo equivalente.

### Lacunas

- Endpoint inteiro ausente.
- Nomes mockados de fontes não correspondem necessariamente às fontes reais.
- O frontend atual simplifica o mapa em cinco regiões.
- O protótipo e os dados Argus permitem e indicam granularidade por UF.
- Os limites de saúde estão fixados no mock do frontend.

## 11. Frontend: situação de integração

Somente a camada de autenticação atual executa fetch. Todas as telas
operacionais usam dados hardcoded.

| Tela | Dados reais | Observação |
|---|---:|---|
| Visão Geral | Não | Importa dashboard-data.ts |
| Incidentes | Não | Filtros e gráfico processam arrays locais |
| Evidências | Não | Hipótese, evidências e gráficos são mocks |
| Eventos | Não | Tela mais recente está somente em develop |
| Monitoramento | Não | KPIs, fontes, fluxo e mapa são mocks |

Também foi identificada uma navegação para /incidentes/{id}, mas não existe
uma rota dinâmica correspondente no App Router.

## 12. Persistência DynamoDB observada

O backend Node referencia:

- monitoracao-operacional.
- monitoracao-golden-set.

O MVP Flask referencia uma terceira tabela, telemetry, que está fora do novo
contrato e deve permanecer isolada.

Convenção atual da operacional:

~~~text
pk = INC#<hora UTC>
sk = INCIDENT#<id>
   | INCIDENT#<id>#EVIDENCE#<sequência>
   | INCIDENT#<id>#HYPOTHESIS#<sequência>
~~~

O seed contém quatro incidentes demonstrativos, cinco evidências e hipóteses
mockadas. Os itens incluem strings de apresentação copiadas do frontend.

O modelo atual atende a demonstração das rotas existentes, mas ainda não
contém:

- Snapshots da Visão Geral.
- Séries e facetas.
- Diagnóstico agregado.
- Eventos.
- Monitoramento.
- Checkpoints e frescor do Argus.

Esta observação não altera o contrato HTTP. Ela apenas identifica os dados
necessários para que as respostas possam ser populadas.

## 13. Materiais disponíveis e faltantes

### Disponíveis

- Código completo das telas operacionais.
- Exportações locais dos protótipos de alta fidelidade.
- Documentação de UX e histórias de usuário.
- Schema e amostras do Argus.
- Artefatos agregados de dashboard.
- Amostras das seis categorias de evento.
- Código e documentação de feat/backend-2.

O acesso ao Figma não é bloqueador para escrever o contrato.

### Faltantes

- Fonte produtiva confirmada dos eventos individuais.
- Mapeamento físico dessa fonte para as seis categorias.
- Métricas produtivas de SQS/ECS/CloudWatch do pipeline.
- Confirmação de SLA por fonte para classificar fresh e delayed.

Esses pontos não impedem o contrato. Eles impedem apenas que algumas
respostas sejam integralmente preenchidas no primeiro momento.

## 14. Impacto esperado por prioridade

### Obrigatório para retirar mocks das telas

- Visão Geral completa.
- Listagem de incidentes com DTO público.
- Diagnóstico agregado.
- Monitoramento.
- Facetas, séries e frescor.

### Obrigatório antes de habilitar revisão

- Identidade de sessão no servidor.
- Versão da revisão.
- Estado inconclusive.
- Auditoria e escrita condicionada.

### Dependente de fonte externa ainda não confirmada

- Eventos individuais das seis categorias.
- Payload bruto sanitizado.
- Linha do tempo completa de uma sessão.

## 15. Conclusão da auditoria

feat/backend-2 contém uma base funcional de API para incidentes, evidências,
hipótese, revisão, diagnóstico e golden set. Ela não contém, na revisão
auditada, todos os endpoints e DTOs necessários para retirar os mocks do
dashboard operacional.

O frontend mais atual cobre visualmente as telas previstas, mas ainda não está
integrado aos dados operacionais. O contrato oficial pode ser implementado de
forma incremental sem depender do Flask ou de BigQuery, usando Argus como
origem inicial e representando explicitamente capacidades parciais.
