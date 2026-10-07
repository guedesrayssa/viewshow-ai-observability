# Laboratório de fechamento dos RNFs

Este leito complementa as rodadas AWS existentes com controles reproduzíveis.
Não emula ECS, ALB, Athena, preço ou capacidade de produção. As duas instâncias
DynamoDB Local são separadas: uma para a API e outra para o fluxo contínuo.
O destino da API usa volume persistente; parar/iniciar o destino preserva os
itens e permite testar recuperação sem restaurar a massa nem reiniciar a API.

## Arquivos e responsabilidades

O inventário técnico completo está em
[artefatos/testes-carga-finais.md](../../../../../artefatos/testes-carga-finais.md#7-inventário-individual-dos-arquivos-de-implementação).
A configuração de coleta é declarativa. Os dashboards apontam para UIDs estáveis.
`collect-evidence.mjs` reprova painel sem valores numéricos, mesmo com HTTP 200.

## Preparação local

Requer Node 22, k6, Docker/Compose e Python 3.12. Na raiz do repositório:

```bash
python3.12 -m venv /tmp/g05-rnf-runtime
/tmp/g05-rnf-runtime/bin/pip install --require-hashes -r apps/backend/ingestion-data/requirements-dev.txt
cd apps/backend/api && npm ci && cd ../../..
docker compose -f apps/backend/api/loadtest/lab/compose.yml up -d
docker compose -p g05-rnf-mysql -f apps/backend/ingestion-data/docker-compose.test.yml up -d --wait
```

As portas publicadas dos contêineres ficam em loopback: 18001/18003 (DynamoDB persistente; 18002 reservado à tentativa inicial),
19090 (Prometheus) e 13002 (Grafana). API e exporter usam 13000 e 19101 no host,
com bind que permite o scrape pelo Docker. A conta Grafana `lab` e senha
`local-rnf-only` são exclusivamente desse leito local descartável.

## Timeout e chegada contínua

```bash
/tmp/g05-rnf-runtime/bin/python apps/backend/ingestion-data/scripts/rnf_local_evidence.py timeout --output assets/testes-carga/<data>-fechamento-local
/tmp/g05-rnf-runtime/bin/python apps/backend/ingestion-data/scripts/rnf_local_evidence.py stream --minutes 15 --output assets/testes-carga/<data>-fechamento-local
```

CT-02 bloqueia uma tabela real por outra conexão e usa o retry wrapper de
produção. O `finally` libera o lock. CT-01 oferece 1.000 eventos/6 s e usa o
normalizador e writer de produção contra DynamoDB Local. Ao final, uma query fortemente consistente
independente compara todas as chaves físicas esperadas/observadas; replay com
nova chave de idempotência exige written=0 e unchanged=1000. A taxa, as latências,
a CPU e o backlog são medições do experimento. Projeção/arquivamento não estão
nesse caminho; seu SLA deve continuar sendo avaliado nas execuções AWS.

## API e observabilidade

```bash
RESULTS_DIR="$PWD/assets/testes-carga/<data>-fechamento-local/api-battery" SOAK_DURATION=30m bash apps/backend/api/loadtest/lab/run-api.sh
RESULTS_DIR=assets/testes-carga/<data>-fechamento-local/observability node apps/backend/api/loadtest/lab/collect-evidence.mjs apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-local.json
```

Não editar um script shell enquanto ele está executando. Se precisar revisar o
runner, deixe a execução terminar e preserve seus brutos em pasta própria. A
bateria faz build/seed, smoke, carga a 137/s, parada real do destino, recuperação
no mesmo processo e soak. `exit=99` do k6 reprova thresholds; `exit=107` é erro
de setup/execução e não serve como resultado de capacidade.

Abra [Grafana](http://127.0.0.1:13002) e [Prometheus](http://127.0.0.1:19090).
Registre captura, janela UTC e query JSON correspondentes. Uma série zero de
falhas é válida quando o contador foi efetivamente coletado; ausência de série
não deve ser preenchida como zero para aprovar o painel.

## AWS: conta existente e credenciais temporárias

O state deve corresponder à conta atual. O runner recusa conta diferente e não
ativa o dataset candidato. A sessão assinada é preparada em memória; não mede
login Cognito sob carga. Nenhum segredo é salvo nas evidências.

`run-aws-evidence.mjs` e `run-nominal-repetitions.mjs` identificam o ambiente
ECS legado da coleta. Na revisão Kubernetes, não use esses runners como prova
de desempenho EKS nem aplique o Terraform novo no state ECS para executar
um teste. A bateria `run-api.sh` usa a configuração atual no host; seus nomes
Kubernetes satisfazem o bootstrap, mas chamadas ao plano de controle não são
simuladas nem validadas pela mistura HTTP medida.

```bash
TF_DIR=<diretorio-com-state-da-conta> EXPECTED_AWS_ACCOUNT_ID=<conta> DUMP=<dump-sintetico> EXPECTED_EVENTS=750000 SNAPSHOT_EXTRACTED_ON=<data> POLL_TIMEOUT_S=10800 RUN_LABEL=cg05-750000 RESULTS_DIR="$PWD/assets/testes-carga/<data>-fechamento-aws/cg05-750000" node apps/backend/api/loadtest/lab/run-aws-evidence.mjs
node apps/backend/api/loadtest/lab/provision-cloudwatch.mjs
RESULTS_DIR=assets/testes-carga/<data>-fechamento-aws/observability START_UTC=<inicio-UTC> END_UTC=<fim-UTC> node apps/backend/api/loadtest/lab/collect-evidence.mjs apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-aws.json
```

`provision-cloudwatch.mjs` usa o provider da AWS CLI, injeta a sessão temporária
no filesystem privado do contêiner Grafana e configura AWS SDK Default. O par
estático `accessKey/secretKey` não carrega session token e não autentica a sessão
do Learner Lab. Conta, região e famílias do dashboard desta coleta estão
explicitadas; para outra conta/stack, renderize a partir do runbook correspondente.

## Três repetições nominais com orçamento fixo

Gere massas diferentes para evitar o atalho de dataset já importado. Na raiz,
com o MySQL do projeto `g05-rnf-mysql` ativo:

```bash
for n in 1 2 3; do
  COMPOSE_PROJECT_NAME=g05-rnf-mysql /tmp/g05-rnf-runtime/bin/python apps/backend/ingestion-data/scripts/build_benchmark_snapshot.py \
    --rows 150000 --rows-per-window 150000 --snapshot-extracted-on 2026-10-06 \
    --variant rnf-nominal-r$n --output .artifacts/rnf-masses/nominal-r$n/argus_dump.sql.gz \
    --manifest .artifacts/rnf-masses/nominal-r$n/manifest.json
done
TF_DIR=<state-da-conta> EXPECTED_AWS_ACCOUNT_ID=239162056821 \
  BASE_URL=https://02vxi7ikcb.execute-api.us-east-1.amazonaws.com \
  RESULTS_DIR="$PWD/assets/testes-carga/<data>-fechamento-aws/nominal-repetitions" \
  node apps/backend/api/loadtest/lab/run-nominal-repetitions.mjs
```

Cada execução define 900 s antes de começar. Ao excedê-los, registra a etapa,
interrompe apenas a task cujo override `IMPORT_ID` corresponde ao teste e
aguarda o estado terminal. Antes da repetição seguinte respeita o TTL do lease.
O cancelamento é operacional: não simula um deadline implementado pelo servidor.
`outcome.json` é uma observação censurada quando não houve READY; não se calcula
média de conclusão ou percentil de duração end-to-end com essas observações.

## Integridade e síntese executiva

```bash
python3 apps/backend/api/loadtest/scripts/verify-rnf-artifact.py \
  --output assets/testes-carga/<data>-fechamento-local/artifact-audit.json
RNF_FONT_DIR=<diretorio-com-DejaVuSans-DejaVuSans-Bold-DejaVuSansMono> \
  python3 apps/backend/api/loadtest/scripts/build-rnf-executive-pdf.py
```

O auditor confere links locais, JSON, arquivos do inventário e gates de
observabilidade; registra SHA-256 das evidências, fontes entregues e PDF.
Ele verifica a consistência da entrega, não aprovação de RNFs ou nota acadêmica.
O builder requer ReportLab e fontes DejaVu; lê os brutos preservados e exporta
`output/pdf/sintese-testes-nao-funcionais.pdf`. Após gerar, renderize e confira
as quatro páginas. A síntese não substitui o inventário técnico no Markdown.

## Encerramento

Antes de desligar, exporte séries/consultas e as capturas. Para remover apenas o
leito de testes, mantendo o volume da API recuperável:

```bash
docker compose -f apps/backend/api/loadtest/lab/compose.yml down
docker compose -p g05-rnf-mysql -f apps/backend/ingestion-data/docker-compose.test.yml down
```

Isso não remove recursos AWS nem altera a stack de observabilidade habitual.
