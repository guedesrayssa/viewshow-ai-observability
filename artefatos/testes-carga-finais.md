# Testes de carga finais do frontend

> **Data da execução:** 05/10/2026  
> **Branch:** `feat/teste-carga-front`  
> **Escopo:** frontend Next.js exportado estaticamente, experiência no navegador e chamadas da API geradas pelo painel.

## 1. Objetivo e resultado executivo

Este artefato evolui os testes não funcionais da Sprint 3 para a versão atual do
frontend. A avaliação foi dividida em três planos porque um único número não
representa o desempenho percebido pela pessoa usuária:

1. **entrega estática:** HTML, JavaScript, CSS e fontes servidos ao navegador;
2. **renderização:** FCP, LCP, TBT e CLS medidos pelo Lighthouse;
3. **dados do painel:** tráfego HTTP que o frontend produz contra a API, medido
   pela suíte k6 já vigente.

O código atual passou pelo gate de qualidade e pela carga nominal. Sob pico de
200 conexões, não perdeu requisições nem devolveu erro, mas a latência p97,5
subiu a 468 ms e reprovou o limite de 200 ms. Uma repetição imediatamente após
o pico voltou a 7 ms no p97,5, comprovando recuperação sem reinício. O RNF07
(FCP até 30 s) foi atendido com folga na rota pública medida: 0,947 s no pior
ensaio móvel e 0,428 s no pior desktop.

A conclusão geral é **“Chegou lá” para a entrega estática atual**, com
resiliência comprovada, e **parcial para a experiência completa autenticada**:
o código novo ainda não está publicado no Amplify, portanto gráficos com sessão
e dados reais não foram atribuídos indevidamente à nova versão.

## 2. Evolução em relação à Sprint 3

Na Sprint 3, o frontend tinha instrumentação RUM, mas nenhum relatório
controlado de navegador. Os testes de carga concentravam-se na API. A evolução
desta entrega é:

| Antes | Agora |
| --- | --- |
| RNF07 marcado como não executado | seis auditorias Lighthouse versionadas, três móveis e três desktop |
| Sem cenário para os arquivos do frontend | cenário Autocannon reproduzível para sete páginas e seus recursos estáticos |
| Carga e pico sem teste explícito de recuperação do frontend | smoke → carga → pico → smoke de recuperação |
| Resultado agregado sem separar CDN, navegador e API | três planos de medição com conclusões e limites próprios |
| Grafana configurado, sem decisão sobre o ciclo da métrica RUM | lacuna operacional identificada: RUM fica na memória da task e não há Grafana implantado na AWS |

As novas rotas de incidentes, feed, detalhe e importações entraram na mistura do
teste. Isso acompanha a mudança de navegação do frontend e evita continuar
testando somente as páginas antigas.

## 3. Critérios de aceitação

| Camada | Cenário | Critério | Justificativa |
| --- | --- | --- | --- |
| Build | lint, tipos, testes e exportação | todos concluídos sem erro | impede medir um artefato inválido |
| Estático | smoke e carga | zero erro de transporte, zero timeout, zero não-2xx e p97,5 < 200 ms | p97,5 é mais rigoroso que p95 e é publicado diretamente pelo Autocannon |
| Estático | pico | mesmas verificações, registrando degradação de latência | separa indisponibilidade de lentidão |
| Resiliência | smoke logo após o pico | voltar a p97,5 < 200 ms sem reinício | comprova recuperação, não apenas sobrevivência |
| Navegador | RNF07 | FCP amostral p95 ≤ 30 s | requisito definido na Sprint 1 |
| Navegador | referência Web Vitals | LCP ≤ 2,5 s, CLS ≤ 0,1 e TBT ≤ 200 ms | metas de diagnóstico, não substituem o RNF07 |
| API do painel | carga/soak | sucesso > 99,9%, p95 < 2 s e p99 < 5 s | contrato da suíte `front-api.js` |

Com apenas três repetições por perfil de navegador, o p95 amostral pelo método
nearest-rank é o maior valor. Essa escolha é conservadora e evita interpolar uma
precisão inexistente.

## 4. Ambiente e método

### 4.1 Código avaliado

- branch `feat/teste-carga-front`;
- commit-base `a89e6b6220d7b2c24714d3a450cf6d1bc0338a60`;
- Next.js 16.3.1 com `output: "export"` e 21 páginas estáticas;
- Node.js 24.14.1 e Chrome 154.0.8037.95;
- gerador local com Intel Core i5-1345U e 15,7 GiB de RAM.

O Turbopack não pôde carregar o módulo SWC nativo por uma política do Windows.
O build foi repetido com `next build --webpack`, alternativa indicada pelo
próprio Next.js, e concluiu com sucesso. Essa ocorrência é limitação do ambiente
de build, não falha de runtime do frontend.

### 4.2 Mistura da carga estática

O cenário abre sete páginas representativas:

- `/login/`;
- `/visao-geral/`;
- `/incidentes/`;
- `/incidentes/detalhe/`;
- `/incidentes/feed-eventos/`;
- `/monitoramento/`;
- `/dados/importacoes/`.

Antes de iniciar, ele lê os HTMLs, descobre os recursos de mesma origem em
`/_next/static/` e aborta se qualquer página não responder 200. Nesta versão,
foram 24 recursos estáticos e 31 variantes de requisição ao todo. Cada conexão
mantém keep-alive, usa timeout de 8 s e não usa pipelining.

| Perfil | Conexões | Duração | Papel |
| --- | ---: | ---: | --- |
| Smoke | 2 | 15 s | sanidade e linha de base |
| Carga | 50 | 60 s | uso concorrente nominal |
| Pico | 200 | 30 s | rajada e saturação |
| Recuperação | 2 | 15 s | retorno ao estado nominal após o pico |

O alvo local usa a exportação de produção e isola o peso do artefato. Ele não é
um benchmark do CDN. O smoke do Amplify é reportado separadamente justamente
para não misturar loopback, Internet e cache de borda.

### 4.3 Lighthouse

Foram feitas três auditorias móveis e três desktop em `/login/`, sempre sobre a
exportação atual. Cada JSON integral foi preservado. O perfil móvel aplica a
simulação padrão de rede e CPU do Lighthouse; o desktop não aplica a mesma
restrição.

## 5. Gate de qualidade

| Verificação | Resultado |
| --- | --- |
| ESLint | aprovado |
| TypeScript (`tsc --noEmit`) | aprovado |
| Vitest | 30 arquivos e 218 testes aprovados |
| Build de produção | aprovado com Webpack |
| Exportação | 21 rotas estáticas geradas |
| Tamanho do diretório `out/` | 154 arquivos, 2.230.355 bytes |

Os cinco maiores arquivos JavaScript variam de 112,6 KB a 241,5 KB. O maior
chunk tem 241.457 bytes. Esses números ajudam a explicar a diferença entre o
desempenho desktop e móvel, embora tamanho em disco não equivalha ao total
transferido após compressão do CDN.

## 6. Resultados da entrega estática

| Perfil | Requisições | Média req/s | p50 | p90 | p97,5 | p99 | Erros/timeouts/não-2xx | Resultado |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Smoke | 12.383 | 825,54 | 1 ms | 4 ms | 7 ms | 9 ms | 0 / 0 / 0 | **Aprovado** |
| Carga | 49.307 | 821,79 | 53 ms | 99 ms | 135 ms | 157 ms | 0 / 0 / 0 | **Aprovado** |
| Pico | 25.265 | 842,17 | 233 ms | 353 ms | 468 ms | 534 ms | 0 / 0 / 0 | **Reprovado em latência; resiliente em disponibilidade** |
| Recuperação | 10.554 | 703,60 | 2 ms | 4 ms | 7 ms | 10 ms | 0 / 0 / 0 | **Aprovado** |

### 6.1 Análise de desempenho

Com 50 conexões, o p97,5 ficou em 135 ms, 32,5% abaixo do limite, e 49.307
respostas foram entregues sem erro. A vazão permaneceu próxima de 822 req/s.
No pico, aumentar a concorrência em quatro vezes não elevou a vazão na mesma
proporção: ela ficou em 842 req/s, enquanto a mediana saltou de 53 para 233 ms.
Esse formato — vazão quase plana e fila crescendo — identifica o ponto de
saturação do servidor local de arquivos, não perda de integridade do artefato.

### 6.2 Análise de resiliência

Durante o pico, todas as 25.265 respostas foram 200 e não houve timeout. A
aplicação continuou disponível, mas lenta segundo o SLO adotado. Sem reiniciar
o servidor, o smoke seguinte voltou a 7 ms no p97,5. A recuperação de 468 para
7 ms representa redução de 98,5% na cauda e confirma que não ficou fila presa,
socket esgotado ou processo degradado depois da rajada.

### 6.3 Comparativo do Amplify

O smoke da publicação AWS entregou 715 respostas, 47,67 req/s, sem erro ou
timeout; p50 de 18 ms, p90 de 102 ms e p97,5 de 250 ms. Ele comprova saúde do
caminho Internet → Amplify, mas **não** valida o frontend novo: o job publicado
é manual, de 30/09/2026, e não registra commit. A diferença de latência para o
loopback inclui Internet, TLS e cache de borda.

Essa ausência de proveniência é uma descoberta arquitetural: resultados de
produção só devem ser promovidos a evidência da versão quando o deploy registrar
SHA do commit e hash do pacote.

## 7. Resultados de navegador

### 7.1 Desktop

| Rodada | Score | FCP | LCP | Speed Index | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 99 | 428 ms | 1.022 ms | 521 ms | 33 ms | 0,01 |
| 2 | 100 | 273 ms | 741 ms | 507 ms | 17 ms | 0,01 |
| 3 | 99 | 373 ms | 981 ms | 488 ms | 49 ms | 0,01 |
| **p95 amostral** | — | **428 ms** | **1.022 ms** | **521 ms** | **49 ms** | **0,01** |

Todos os indicadores de referência ficaram dentro dos limites. O FCP consumiu
apenas 1,43% do orçamento de 30 s do RNF07.

### 7.2 Móvel

| Rodada | Score | FCP | LCP | Speed Index | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 77 | 928 ms | 3.020 ms | 1.433 ms | 613 ms | 0,08 |
| 2 | 83 | 880 ms | 3.051 ms | 880 ms | 405 ms | 0,08 |
| 3 | 77 | 947 ms | 3.358 ms | 947 ms | 532 ms | 0,08 |
| **p95 amostral** | — | **947 ms** | **3.358 ms** | **1.433 ms** | **613 ms** | **0,08** |

O RNF07 passou: o pior FCP foi 31,7 vezes menor que o limite. Porém, o LCP
móvel ficou acima da referência de 2,5 s nas três rodadas, e o TBT ficou acima
de 200 ms. O Lighthouse apontou aproximadamente 300 ms de economia potencial
em JavaScript não utilizado em todas as rodadas. Portanto, “FCP aprovado” não
significa que a experiência móvel esteja concluída.

Prioridades de otimização:

1. adiar módulos que não participam da primeira pintura;
2. dividir componentes pesados por rota e carregar gráficos sob demanda;
3. revisar o chunk compartilhado de 241,5 KB;
4. repetir a auditoria na tela autenticada com gráficos e dados reais.

## 8. API acionada pelo frontend

O frontend é estático, mas a experiência após a pintura depende da API. A suíte
[`front-api.js`](../apps/backend/api/loadtest/k6/front-api.js) reproduz timeout
de 8 s, envelope `{data, meta}`, paginação e a mistura de rotas do painel. Os
resultados vigentes de 01/10/2026 não foram reexecutados como se fossem da nova
publicação; continuam sendo a referência da capacidade do backend:

| Cenário AWS | Resultado relevante |
| --- | --- |
| Load 10/s | 3.239 iterações, 100% da carga, p95/p99 de 32/124 ms, zero falha |
| Soak 15/s por 30 min | 27.001 iterações, 100% da carga, p95 de 33–38 ms após a partida, um timeout |
| Breakpoint | sem falha até 30/s; a 35/s, 24,9% de falha e p95 no timeout de 8 s |
| Spike 10→40/s | 42% de falha no pico; recuperação em cerca de um minuto |
| RNF14 a 137/s | 69% de falha no patamar e apenas 56% da carga emitida; reprovado com folga |

A entrega estática não é o gargalo do fluxo completo. A capacidade atual é
limitada pela CPU da task ECS de 0,25 vCPU e pelo autoscaling lento, conforme a
análise detalhada em
[`testes-de-carga-da-api.md`](sprint5/testes-de-carga-da-api.md).

## 9. Grafana, RUM e observabilidade

### 9.1 O que já existe

O frontend registra FCP, LCP, INP e CLS com `web-vitals` e envia as amostras a
`POST /api/v1/telemetry/rum`. A API transforma os eventos em métricas
Prometheus. O dashboard versionado do Grafana possui:

- taxa, latência p95 e erros/s da API;
- LCP p95 por caminho;
- erros do navegador e falhas de fetch;
- memória e CPU do processo;
- logs correlacionados e alertas disparando.

Isso permite correlacionar “a tela ficou lenta” com aumento de latência da API,
erro de fetch ou saturação de CPU, evitando atribuir toda lentidão ao bundle.

### 9.2 Lacuna encontrada

Na conta AWS consultada em 05/10/2026 existe somente o dashboard CloudWatch da
ingestão; a pilha Grafana/Prometheus é provisionada para execução local. Além
disso, as métricas RUM vivem no registry em memória da task da API. Com mais de
uma réplica, cada task enxerga somente sua parcela; quando a task é substituída,
as amostras desaparecem se não houver coleta externa.

Logo, o painel Grafana está tecnicamente correto, mas ainda não constitui
monitoramento contínuo de produção. Os relatórios Lighthouse desta entrega são
a evidência controlada; não devem ser apresentados como série Grafana.

### 9.3 Evolução recomendada

1. executar um coletor Prometheus gerenciado ou Alloy na AWS e fazer remote
   write para armazenamento persistente;
2. descobrir e raspar todas as tasks ECS, não apenas um endereço fixo;
3. manter os rótulos de RUM com baixa cardinalidade (`path` normalizado e
   `rating`), sem `metricId` como label;
4. criar painéis de FCP e INP além do LCP já existente;
5. alertar por janela e volume mínimo, para não reagir a uma única navegação;
6. adicionar anotação de deploy com SHA e comparar antes/depois.

## 10. Impactos nas decisões de arquitetura

| Decisão | Evidência | Consequência |
| --- | --- | --- |
| Manter exportação estática no Amplify | 49.307 respostas nominais sem erro; pico sem indisponibilidade | não há motivo de desempenho para introduzir servidor Next.js |
| Separar SLO de estático, navegador e API | estático recupera em milissegundos, enquanto a API falha acima de 30/s | um único “tempo da página” ocultaria o gargalo real |
| Priorizar redução de JavaScript móvel | LCP móvel de 3,02–3,36 s e TBT de 405–613 ms | usar divisão por rota e carregamento tardio antes de aumentar infraestrutura |
| Fortalecer a API antes de elevar tráfego | 69% de falha a 137/s e autoscaling tardio | aumentar capacidade mínima/CPU, reduzir custo por consulta e proteger health check |
| Persistir RUM fora da task | métricas atuais são locais ao processo e Grafana não está implantado na AWS | adotar coleta externa antes de usar RUM como SLO de produção |
| Vincular deploy à revisão | Amplify manual sem commit associado | registrar SHA/hash para que teste publicado seja auditável |

## 11. Reprodutibilidade

Na pasta `apps/frontend`:

```bash
npm ci
npm run lint
npm run typecheck
npm test
NEXT_PUBLIC_API_BASE_URL=/ npm run build
npx serve out --listen 4173
```

Em outro terminal:

```bash
BASE_URL=http://127.0.0.1:4173 PROFILE=smoke npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 PROFILE=load npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 PROFILE=spike npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 PROFILE=smoke RUN_LABEL=smoke-recovery npm run loadtest:static
```

No Windows usado nesta rodada, o build equivalente foi
`npm run build -- --webpack`. As instruções completas estão em
[`apps/frontend/loadtest/README.md`](../apps/frontend/loadtest/README.md).

## 12. Limitações e próximos passos

1. O alvo e o gerador local compartilham CPU; a carga local serve para regressão
   e saturação relativa, não para dimensionar o Amplify.
2. O Lighthouse avaliou `/login/`; a aprovação integral do RNF07 ainda exige a
   tela autenticada com gráficos e API integrada.
3. A versão nova não foi publicada, portanto o smoke do Amplify é apenas uma
   verificação da infraestrutura existente.
4. Não houve soak de várias horas na entrega estática nem injeção de falha de
   rede/CDN.
5. O mix de rotas é representativo do código, mas ainda não é ponderado por
   telemetria real de navegação.
6. A API precisa repetir o breakpoint com a imagem correspondente ao frontend
   final e massa realista antes de uma decisão de capacidade de produção.

Próxima rodada recomendada: publicar o commit em um ambiente de homologação,
registrar o SHA, executar Lighthouse móvel/desktop três vezes em
`/visao-geral`, `/incidentes` e `/incidentes/detalhe`, rodar `front-api.js` na
mesma janela e correlacionar Web Vitals, CPU, latência e erros no Grafana.

## 13. Evidências

- [Índice e condições da rodada de frontend](../assets/testes-carga/2026-10-05-frontend/README.md)
- [Smoke estático](../assets/testes-carga/2026-10-05-frontend/static-smoke.json)
- [Carga estática](../assets/testes-carga/2026-10-05-frontend/static-load.json)
- [Pico estático](../assets/testes-carga/2026-10-05-frontend/static-spike.json)
- [Recuperação](../assets/testes-carga/2026-10-05-frontend/static-smoke-recovery.json)
- [Smoke do Amplify](../assets/testes-carga/2026-10-05-frontend/static-aws-amplify-smoke.json)
- [Resultados vigentes da API](sprint5/testes-de-carga-da-api.md)
- [Plano histórico da Sprint 3](sprint3/testes-carga-inicial.md)
- [Dashboard Grafana versionado](../apps/fullstack/observability/grafana/provisioning/dashboards/json/view-show-overview.json)

## 14. Conclusão

O frontend atual atende a carga nominal da entrega estática com zero erro e
recupera imediatamente de uma rajada quatro vezes maior. O FCP da rota pública
atende o RNF07 com ampla margem. A principal oportunidade no cliente é reduzir
trabalho de JavaScript em dispositivos móveis; no fluxo completo, o risco maior
continua na capacidade e na reação do backend, não na hospedagem estática.

O artefato também transforma uma lacuna de observabilidade em decisão concreta:
Lighthouse permanece como evidência controlada até que o RUM seja coletado de
todas as tasks e persistido fora do processo. Essa separação entre o medido, o
inferido e o ainda pendente evita conclusões otimistas sem evidência.
