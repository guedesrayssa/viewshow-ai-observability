# Experimentos locais e de emulação — 30/09/2026

Medições feitas em uma máquina local (20 núcleos, Docker) com o `k6/front-api.js` revisado. Elas
complementam as rodadas na AWS de
[`2026-10-01-aws-gerador-na-regiao/`](../2026-10-01-aws-gerador-na-regiao/README.md) e dão suporte às
seções 5.4 e 6 de [`artefatos/sprint5/testes-de-carga-da-api.md`](../../../artefatos/sprint5/testes-de-carga-da-api.md).
Os números locais medem esta máquina e o DynamoDB Local, não a AWS; servem para comparar cenários
entre si.

Cada pasta tem `resumo-k6.json` (saída do k6), `sumario.txt` (sumário impresso, sem as linhas de
"Request Failed") e, quando o experimento mede CPU, `cpu.csv` (CPU acumulada do processo ou do contêiner
da API, amostrada a cada 5 s).

## Ambiente

- **API local:** `node dist/index.js` (Node 22, `NODE_ENV=test`, limite de taxa em 30.000/min) com
  DynamoDB Local 2.6.1 em Docker e o seed de `scripts/seed-carga.cjs`.
- **Emulação da task:** a imagem implantada na AWS (`view-show-iac-api:6d40f7e2e6b2`) com a CPU e a
  memória da task, falando com o mesmo DynamoDB Local:

  ```bash
  docker run -d --cpus=0.25 --memory=512m --memory-swap=512m -p 127.0.0.1:3100:3000 \
    -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=3000 \
    -e DYNAMODB_ENDPOINT=http://host.docker.internal:18000 \
    -e AWS_REGION=us-east-1 -e AWS_ACCESS_KEY_ID=local -e AWS_SECRET_ACCESS_KEY=local \
    -e OPERATIONAL_TABLE_NAME=<tabela local> -e RATE_LIMIT_PER_MINUTE=30000 \
    -e AUTH_COOKIE_SECRET=<32+ chars> -e CURSOR_SECRET=<32+ chars> -e IMPORT_CURSOR_SECRET=<32+ chars> \
    <demais variáveis IMPORT_* e INGESTION_* como em loadtest/local.sh> \
    <imagem>
  ```

## Experimentos

| Pasta | Experimento | Resultado |
| --- | --- | --- |
| `volume/n300`, `volume/n2500` | Soak de 50/s por 90 s na API local, com 300 e com 2.500 incidentes (`INCIDENTS_PER_HOUR` 12 e 100) | CPU por requisição de 3,86 para 8,16 ms; p95 de 9 para 20,5 ms |
| `emulacao-0-25-vcpu/breakpoint-rampas` | Breakpoint em rampas (10 a 150/s) na emulação, 300 incidentes | r10 p95 17 ms; r25 54 ms; r50 3,3 s com 1% de falha; r75 com 30% de falha; CPU do contêiner presa em 25% |
| `emulacao-0-25-vcpu/soak25-n300` | 25/s por 90 s na emulação, 300 incidentes | p95 de 41 a 151 ms por rota; 14 timeouts na partida a frio |
| `emulacao-0-25-vcpu/soak25-n2500` | 25/s por 90 s na emulação, 2.500 incidentes | 65% de timeouts; CPU em 24% (no teto) |
| `controles-negativos/dynamodb-fora-script-original` | Soak de 10/s; DynamoDB Local derrubado aos ~18 s; script original | Reprova (`exit 99`), mas `http_req_failed` marca 0% com 580 de 602 respostas em 503 |
| `controles-negativos/dynamodb-fora-script-revisado` | Mesmo cenário com o script revisado | 17 thresholds reprovados; ~76% de falha nas rotas que dependem do banco |
| `controles-negativos/limite-180-por-minuto` | Soak de 10/s com a API em `RATE_LIMIT_PER_MINUTE=180` | 404 de 605 respostas em 429; 22 thresholds reprovados |
| `limitador-xff` | `xff.mjs`: API com `NODE_ENV=production` (`trust proxy 1`) e limite de 180/min; cabeçalho `X-Forwarded-For: <cliente>, <egress>` | 200 clientes distintos atrás do mesmo egress: 180 respostas 401 e 20 respostas 429; um usuário novo atrás do mesmo egress também recebe 429; outro egress, 401 |

O último experimento mostra que, em produção, a chave do limitador é o endereço do último proxy e não
o do usuário. Atrás do API Gateway, todos os usuários que saem pelo mesmo endereço do gateway dividem o
mesmo balde. Isso foi verificado no código local; a topologia da AWS não foi confirmada com uma rajada.
