# Testes de carga finais do frontend

> **Complemento de fechamento:** a rodada local abaixo permanece válida no seu escopo. A entrega consolidada agora inclui [18 auditorias sequenciais de três telas autenticadas na AWS](../../assets/testes-carga/2026-10-06-fechamento-aws/lighthouse-authenticated/validation-summary.json), com sessão 200 e chamadas reais à API verificadas por relatório. Ver Seção 11.

## 1. Escopo e resultado

Este artefato aprimora os testes da Sprint 3 em três planos: entrega estática,
renderização no navegador e consultas à API. A rodada **vigente de 06/10/2026**
mede a exportação local da branch `feat/teste-carga-front`, integrada à develop.
Não comprova a experiência autenticada nem dimensiona o CDN Amplify.

Smoke, carga de 50 conexões, pico de 200 e recuperação novamente com **50 conexões**
aprovaram os thresholds. Houve zero erro HTTP, transporte, timeout ou conteúdo
inválido. A recuperação começou 0,42 s depois do pico, sem sleep: o intervalo
inclui inicialização e preflight. O mesmo servidor permaneceu vivo, conforme
PID e horários em environment.json.

As seis auditorias Lighthouse foram repetidas **sequencialmente**, com Chrome
isolado e três amostras por perfil. O pior FCP móvel foi 757 ms; o LCP móvel ficou
em aproximadamente 2,26 s e o TBT em até 13 ms. Esses números aprovam o RNF07
**somente na rota pública /login/**. Telas com sessão e dados reais continuam
fora do escopo desta medição.

## 2. Evolução e correções da revisão

| Antes | Agora |
| --- | --- |
| HTTP 200 bastava para aprovar um chunk, inclusive HTML de fallback | Preflight de páginas/recursos; MIME/corpo verificados por resposta; SHA-256 contra OUT_DIR |
| Lighthouse de 05/10 com cinco traces sobrepostos | Runner sequencial e seis amostras sem sobreposição; horários, versões, configurações e hashes registrados |
| Auditor podia terminar com métrica ausente | NO_LCP, valores não finitos/ausentes ou métricas principais com erro interrompem o runner |
| Recuperação com 2 conexões e pausa de 19,728 s | Recuperação a 50 conexões durante 60 s, após 0,42 s, no mesmo processo |
| Links apontavam para diretórios incorretos ou outro artefato | Evidências e relatórios com caminhos relativos verificados |

As [evidências de 05/10](../../assets/testes-carga/2026-10-05-frontend/README.md)
foram preservadas como históricas. A concorrência impede usar seus LCP/TBT
como referência isolada. Não se conclui melhora comparando máquinas,
navegador, auditor e logging diferentes.

## 3. Critérios de aceitação

| Plano | Critério |
| --- | --- |
| Qualidade | lint, TypeScript, 218 testes de frontend e controles negativos aprovados; build/exportação completos |
| Estático | zero erro de transporte, timeout, não-2xx ou conteúdo; p97,5 < 200 ms |
| Integridade do alvo | MIME/corpo válidos; com OUT_DIR, SHA-256 baixado igual ao arquivo exportado |
| Recuperação | critérios da carga, a 50 conexões por 60 s, depois do pico sem reiniciar servidor |
| RNF07 | FCP amostral p95 ≤ 30 s na rota medida |
| Diagnóstico de navegador | LCP ≤ 2,5 s; CLS ≤ 0,1; TBT ≤ 200 ms |

O p97,5 do Autocannon é mais rigoroso que p95. Com três auditorias, o p95
amostral nearest-rank é o máximo; isso não prova o percentil da população.
O cenário HTTP mede requisições independentes em conexões persistentes,
não sessões completas com gráficos e API.

## 4. Ambiente e proveniência

| Item | Valor |
| --- | --- |
| Revisão da coleta | `d7eaff123955a49dad53018f63d4c80d6f3cc24a` |
| Host | Apple M5, 16 GiB RAM, darwin |
| Node | v24.19.0 |
| Next.js | 16.3.1, output export, Webpack e API_BASE_URL=/ |
| Autocannon / servidor | 8.0.0 / serve 14.2.5; sem request logging e sem troca automática de porta |
| Lighthouse / Chrome | 13.5.0 / Chrome for Testing 153.0.8010.36 |
| Exportação | 152 arquivos; 2.271.961 bytes; 21 páginas estáticas |
| Alvo | http://127.0.0.1:43173 |
| Workload | sete páginas, 28 recursos Next.js, 35 variantes |
| Fingerprint da exportação | `699c1ae421fd7f92c8f6b3adf2ae19d7c708d830934f0583ea234d650f3cbc22` |

O [manifesto da rodada](../../assets/testes-carga/2026-10-06-frontend/environment.json)
registra SHA-256 por arquivo, revisão, host, PID e cada perfil. Os resumos
registram os recursos efetivamente baixados. As
[execuções Lighthouse](../../assets/testes-carga/2026-10-06-frontend/lighthouse-executions.json)
registram início/fim de cada Chrome, configuração e hash do relatório.

Lighthouse 12.8.2 produziu NO_LCP nesta combinação local; suas tentativas não
foram usadas como amostras válidas. A versão fixada 13.5.0 publicou métricas
principais finitas e nenhuma auditoria com scoreDisplayMode=error. Ela ainda
emitiu diagnóstico interno LanternError: NO_LCP do trace engine; a mensagem
não substitui o estado estruturado das auditorias nem foi usada para inventar
LCP. Não houve warnings nos seis LHR aceitos.

## 5. Resultados da entrega estática

| Perfil | Conexões | Respostas | Req/s médio | p50 | p97,5 | p99 | Erros/timeout/não-2xx/conteúdo | Resultado |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| smoke | 2 | 30.017 | 2.001,14 | 0 ms | 1 ms | 1 ms | 0/0/0/0 | Aprovado |
| load | 50 | 421.340 | 7.022,74 | 6 ms | 11 ms | 12 ms | 0/0/0/0 | Aprovado |
| spike | 200 | 182.751 | 6.092,4 | 30 ms | 54 ms | 60 ms | 0/0/0/0 | Aprovado |
| load-recovery | 50 | 407.924 | 6.799,34 | 6 ms | 12 ms | 14 ms | 0/0/0/0 | Aprovado |

Todas as respostas concluídas foram verificadas pelo callback de conteúdo.
Requisições em voo no encerramento aparecem na diferença requests.sent −
requests.total; isso não é comprovante de perda de dados. Não há taxa aberta
de usuários e a fila interna do servidor não foi instrumentada.

O pico manteve a latência abaixo do limite neste leito. A recuperação voltou a
p97,5 de 12 ms, próximo dos 11 ms da carga inicial, com a mesma concorrência.
Esses resultados caracterizam regressão do artefato e servidor local,
não capacidade ou disponibilidade do Amplify. Não houve injeção de falha de rede/CDN.

## 6. Auditorias sequenciais de navegador

### Desktop

| Rodada | Score | FCP | LCP | Speed Index | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 205 ms | 530 ms | 205 ms | 0 ms | 0.015 |
| 2 | 100 | 206 ms | 532 ms | 206 ms | 0 ms | 0.015 |
| 3 | 100 | 205 ms | 529 ms | 205 ms | 0 ms | 0.015 |
| p95 amostral | — | 206 ms | 532 ms | 206 ms | 0 ms | 0.015 |

### Móvel

| Rodada | Score | FCP | LCP | Speed Index | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 97 | 756 ms | 2261 ms | 756 ms | 11 ms | 0.079 |
| 2 | 97 | 757 ms | 2264 ms | 757 ms | 13 ms | 0.079 |
| 3 | 97 | 754 ms | 2258 ms | 754 ms | 13 ms | 0.079 |
| p95 amostral | — | 757 ms | 2264 ms | 757 ms | 13 ms | 0.079 |

Os máximos ficaram dentro das referências nessa rota. O perfil móvel usa
simulação de rede/CPU; não é uma medição num telefone. O login não executou
autenticação: /auth/session e /api/v1/telemetry/rum não têm backend neste
servidor estático. Os números não atestam a experiência após login.

## 7. API e observabilidade

A capacidade da API permanece descrita em
[Testes de Carga da API](./testes-de-carga-da-api.md), com o cenário
[front-api.js](../../apps/backend/api/loadtest/k6/front-api.js). Execuções AWS
não foram reatribuídas à coleta local desta contribuição.

O frontend já envia RUM via web-vitals e o
[dashboard Grafana](../../apps/fullstack/observability/grafana/provisioning/dashboards/json/view-show-overview.json)
possui métricas de API e LCP. Configuração não equivale a coleta: a rodada não
produziu séries Grafana/Prometheus com sessão e dados reais e não substitui
esse item da entrega consolidada. Persistência externa do RUM, scrape de
réplicas e comparação com SHA do deploy continuam necessários.

## 8. Impactos arquiteturais e limites

| Achado | Consequência |
| --- | --- |
| Exportação aprovada no servidor local | Preservar o modelo estático enquanto a CDN não demonstrar limitação; não dimensionar por loopback |
| HTML de fallback passava com 200 | Validar conteúdo junto a status/latência antes de aceitar publicação |
| Host, auditor e concorrência alteram números | Fixar versões e isolar coleta; registrar condições antes de atribuir ganho ao código |
| Recuperação em menor carga ocultava capacidade residual | Repetir carga nominal depois do pico, registrando o intervalo real |
| Apenas /login auditado | Homologação seguinte deve medir telas autenticadas, gráficos, API e RUM na mesma janela |

Não foram medidos soak de horas, falhas de rede/banco/CDN ou produção. O mix
não é ponderado por navegação real. A aprovação se restringe aos perfis e alvo
registrados; o RNF07 completo permanece parcial.

## 9. Reprodução

Na pasta apps/frontend, consulte o [README do loadtest](../../apps/frontend/loadtest/README.md):

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:loadtest
NEXT_PUBLIC_API_BASE_URL=/ npm run build -- --webpack
npx serve out --listen tcp://127.0.0.1:4173 --no-request-logging --no-port-switching
```

Em outro terminal, Lighthouse primeiro e depois a bateria, sem paralelismo:

```bash
LIGHTHOUSE_URL=http://127.0.0.1:4173/login/ RESULTS_DIR=../../assets/testes-carga/<data>-frontend npm run loadtest:lighthouse
BASE_URL=http://127.0.0.1:4173 OUT_DIR=out SERVER_PID=<pid-do-servidor> RESULTS_DIR=../../assets/testes-carga/<data>-frontend npm run loadtest:battery
```

Quando necessário, configure CHROME_PATH para Chrome for Testing. Cada coleta
usa um perfil novo e o Chrome termina antes da seguinte. Métricas principais
inválidas abortam a coleta. A bateria preserva a reprovação e mede recuperação
mesmo se o pico reprovou.

## 10. Evidências

- [Rodada vigente](../../assets/testes-carga/2026-10-06-frontend/README.md)
- [Manifesto de ambiente e exportação](../../assets/testes-carga/2026-10-06-frontend/environment.json)
- [Cronologia das auditorias](../../assets/testes-carga/2026-10-06-frontend/lighthouse-executions.json)
- [Smoke](../../assets/testes-carga/2026-10-06-frontend/static-smoke.json)
- [Carga](../../assets/testes-carga/2026-10-06-frontend/static-load.json)
- [Pico](../../assets/testes-carga/2026-10-06-frontend/static-spike.json)
- [Recuperação nominal](../../assets/testes-carga/2026-10-06-frontend/static-load-recovery.json)
- [Histórico](../../assets/testes-carga/2026-10-05-frontend/README.md)
- [Sprint 3](../sprint3/testes-carga-inicial.md)

## 11. Complemento AWS: páginas autenticadas e API real

Em 06/10/2026, 23:33:22–23:37:19 UTC, foram executadas sequencialmente três
auditorias por perfil (desktop/móvel) nas rotas Visão Geral, Incidentes e
Monitoramento do Amplify. Cada relatório confirmou `GET /auth/session = 200`,
permanência na rota protegida e chamadas `/api/v1/` reais. A sessão é de operador
sintético, assinada em memória; login Cognito não foi exercitado. Cookies foram
removidos dos relatórios antes da preservação.

| Tela | FCP p95 desktop | FCP p95 móvel | LCP p95 móvel | TBT máximo móvel | CLS máximo móvel |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visão Geral | 337 ms | 1.068 ms | 2.568 ms | 47 ms | 0,079 |
| Incidentes | 306 ms | 1.066 ms | 2.570 ms | 53 ms | 0,011 |
| Monitoramento | 225 ms | 1.173 ms | 2.672 ms | 16 ms | 0,010 |

O FCP atende RNF07 nas três telas medidas. A referência diagnóstica LCP≤2,5 s
reprova no móvel; isso não é ocultado pelo FCP aprovado. Com três amostras, o
p95 nearest-rank é o máximo amostral. As auditorias detectaram 503 da API de
monitoramento; carregar o estado de erro da tela não aprova sua funcionalidade.
O host executava testes de componentes concomitantemente; nenhuma diferença
frente ao loopback é atribuída a uma otimização do código.

A imagem da API, a conta e a sequência estão em
[executions.json](../../assets/testes-carga/2026-10-06-fechamento-aws/lighthouse-authenticated/executions.json).
O deploy Amplify é manual e não publicou commit no job. O
[fingerprint dos recursos servidos](../../assets/testes-carga/2026-10-06-fechamento-aws/lighthouse-authenticated/deployed-assets-fingerprint.json)
identifica URLs, MIME, tamanho, ETag e SHA-256 dos JS/CSS observados nas auditorias;
não é apresentado como SHA Git. O
[resumo de validação](../../assets/testes-carga/2026-10-06-fechamento-aws/lighthouse-authenticated/validation-summary.json)
confere hashes, sessão, rede, métricas finitas e os seis grupos de três amostras.
A [entrega consolidada](../testes-carga-finais.md) relaciona essa extensão aos
planos, observabilidade e decisões arquiteturais.
