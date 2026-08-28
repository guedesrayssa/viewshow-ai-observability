# Teste de desempenho — API de consulta

Roteiro do teste de carga da API do View Show, seguindo o encontro
**S04 · Testes de desempenho**. O entregável da sprint é: script versionado,
rodado de uma EC2 na mesma região da API, com thresholds derivados do SLA,
`--summary-export` anexado ao relatório e a leitura do servidor durante a rodada.

## O que está sendo testado

**A API de consulta e diagnóstico** (`apps/backend/api`, branch `feat/backend-2`),
em ECS Fargate no cluster `data-ingestion-cluster`.

> ⚠️ **Não é a API de ingestão.** O exemplo da aula (`POST /events`) é do MVP da
> Sprint 1. Esta branch **não expõe endpoint de ingestão** — as rotas são
> consulta (`/incidents`, `/dashboard/summary`), diagnóstico (`/diagnose`) e
> curadoria (`/golden-set`). O SLA aplicável muda de RNF03 para **RNF14**.

## As quatro perguntas do slide 20

| Pergunta | Resposta | Fonte |
| --- | --- | --- |
| Quantos e de onde vem o número? | **137 req/s** = 4,1 M sessões simultâneas ÷ 1.000 | `entendimento_negocio.md:661`; o fator de escala é declarado |
| Qual endpoint e payload? | `GET /api/v1/incidents?window=24h` — 25 Queries paralelas, o pior caso real | `src/services/evidenceService.js` |
| Quais thresholds? | `p(95) < 2000 ms`, `erro < 1%`, vazão `> 130/s` | **RNF14** e **RNF09** |
| De onde roda e quanto custa? | EC2 `c7a.large` (x86, desempenho fixo) em `us-east-1` · **US$ 0,017** por rodada de 10 min | `deploy-aws.md` fixa a região |

## Dimensionamento real da API

Da `apps/backend/api/deploy/task-definition.json`:

```json
"cpu": "256", "memory": "512"     // 0,25 vCPU · 0,5 GB
```

É **um quarto** do que a estimativa de custo assumia. Espere saturação cedo — e
é justamente esse número que o teste existe para confirmar.

## Antes de rodar: semear

O `scripts/seed.js` cria **4 incidentes**. Testar contra isso mede um caminho
quase vazio. Use o `seed-carga.js` deste diretório:

```bash
cp artefatos/testes-carga/seed-carga.js apps/backend/api/scripts/
cd apps/backend/api
node scripts/seed-carga.js          # 300 incidentes ≈ 2.500 itens
```

> ⚠️ **O seed envelhece.** Os buckets são calculados no instante do seed, e a
> consulta calcula os dela no instante da requisição. `window=15m` varre só
> 2 buckets de hora — **passada ~1 h do seed, ele devolve lista vazia**.
> Semeie imediatamente antes da rodada.

| `window` | Buckets varridos | Cobertura |
| --- | ---: | --- |
| `15m` / `1h` | 2 | ~1 h |
| *(ausente)* | 7 | ~6 h |
| `24h` | **25** | ~25 h |

## O gerador de carga

O k6 roda de uma **EC2 nova**, criada só para isso — não há host no Fargate para
logar, e testar do notebook mede a rede do Inteli, não a API (slide 22, item 4).
Nas medições de linha de base, ~135 ms dos ~580 ms eram só RTT.

| Item | Valor |
| --- | --- |
| Tipo | `c7a.large` — 2 vCPU, x86, **desempenho fixo** |
| Região | `us-east-1`, a mesma da API |
| AMI | Amazon Linux 2023 |
| Security group | SSH `22` apenas do IP da equipe |
| Custo | ~US$ 0,017 por rodada de 10 min |

Desempenho fixo importa: numa instância *burstable* (`t3`) os créditos de CPU se
esgotam durante o `soak` de 2 h e o gerador vira o gargalo — o teste passaria a
medir o k6, não a API.

```bash
sudo dnf install -y https://dl.k6.io/rpm/x86_64/k6-latest.x86_64.rpm
k6 version
```

## Pré-voo: provar que a EC2 está na região certa

O que importa **não** é estar na mesma VPC — o ALB é `internet-facing`, e o DNS
dele resolve para IPs públicos mesmo quando chamado de dentro da VPC. O que
importa é a **região**, porque é ela que elimina o RTT.

Rode na EC2 antes de qualquer coisa:

```bash
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/availability-zone

H=http://data-ingestion-alb-1869738103.us-east-1.elb.amazonaws.com
for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{time_connect}\n' "$H/health"; done
```

| `time_connect` | Leitura |
| --- | --- |
| ~0,001–0,003 s | ✅ mesma região — pode rodar |
| ~0,020–0,040 s | ⚠️ outra região dos EUA |
| ~0,130 s | ❌ fora da AWS — foi o valor medido de fora, e um terço do p(95) seria rede |

**Anexe esse número ao relatório.** Ele é a prova de que o teste não mediu a
rede do Inteli (slide 22, item 4).

## Rodando

```bash
export BASE_URL=http://data-ingestion-alb-1869738103.us-east-1.elb.amazonaws.com
export INCIDENT_COUNT=300

k6 run -e BASE_URL=$BASE_URL -e MODE=smoke k6/consultas.js
k6 run -e BASE_URL=$BASE_URL -e MODE=load  --summary-export=resumo-load.json k6/consultas.js
```

| # | `MODE` | Duração | O que responde |
| --- | --- | --- | --- |
| 1 | `smoke` | 30 s | script e API funcionam antes de gastar carga |
| 2 | `load` | 3m45s | **passa no RNF14?** É a rodada do relatório |
| 3 | `breakpoint` | 5 min | o joelho da curva — onde a vazão para de crescer |
| 4 | `spike` | 3 min | salto de 137 → 1.000 req/s (gol na Copa) |
| 5 | `soak` | 2 h | vazamento de memória e TTL |
| 6 | `diagnose` | 1 min | ⚠️ **escreve no banco** — rodada isolada, taxa baixa |

**`POST /diagnose` não é leitura.** O orquestrador chama `saveHypothesis` a cada
invocação: a 137 req/s seriam ~25 mil escritas e a tabela cresceria durante o
teste. Por isso ele tem cenário próprio a 5 req/s.

**`PATCH /incidents/:id/hypothesis/review` fica fora do teste** — quando o status
é `confirmed`, promove o caso à golden set. Carga aqui corromperia dado curado.

## Leitura do servidor durante a rodada

O k6 mostra o sintoma do lado do cliente; a causa está no servidor. O relatório
precisa das duas leituras lado a lado.

| Onde olhar | O que anotar |
| --- | --- |
| CloudWatch → ECS → `CPUUtilization` | satura em 100% de 0,25 vCPU? |
| CloudWatch → ECS → `MemoryUtilization` | 512 MB bastam para o Node? |
| CloudWatch → DynamoDB → `ThrottledRequests` | **se > 0, o gargalo é o banco, não a API** |
| CloudWatch → DynamoDB → `SuccessfulRequestLatency` | latência por Query |
| CloudWatch Logs → `/ecs/monitoracao-api` | erro 500 aparece antes da saturação? |

## Como ler o resumo

- **Percentil, não média.** Reporte `p(95)` e `p(99)`. Uma média de 180 ms
  convive tranquilamente com 5% acima de 3 s — e esses 5% são quem abre chamado.
- **VU não é usuário.** Com `constant-arrival-rate` a carga é a taxa, não o
  número de VUs. Se `dropped_iterations` aparecer, o k6 não conseguiu sustentar
  a taxa: aumente `maxVUs` ou a instância geradora é o gargalo, não a API.
- **O sinal de alerta:** a vazão para de crescer enquanto a taxa alvo sobe.
  Quando o erro aparece, o sistema já saturou uma rodada antes.

## Limitações a declarar no relatório

1. **Volume de dados sintético.** 300 incidentes num seed determinístico não
   reproduzem a distribuição real; o teste mede o custo de *fan-out* da API, não
   o de volume no DynamoDB.
2. **Poucas partições.** IDs ordinais concentram leitura em poucas partições —
   o teste **não** exercita hot-spotting.
3. **`BEDROCK_ENABLED=false`.** O `/diagnose` não chama LLM de verdade; a
   latência medida é do caminho determinístico, não da camada agêntica real.
4. **O p(95) de 2 s vem do RNF14**, que fala de "busca filtrada" no dashboard.
   Se o parceiro quiser um SLA específico para esta API, o número muda.
