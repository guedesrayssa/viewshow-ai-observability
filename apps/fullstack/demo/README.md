# Ambiente local da demonstração da Sprint 5

Este ambiente reproduz o fluxo mostrado no vídeo com Compose: MySQL/ARGUS
sintético → ingestão Python → outbox/DynamoDB Local → ElasticMQ → Worker Node →
resultado na tabela operacional. A API também é construída e iniciada como
contêiner. Os endpoints são locais e as credenciais são fictícias.

```bash
docker compose -f apps/fullstack/demo/compose.yml build
docker compose -f apps/fullstack/demo/compose.yml up -d --wait dynamodb sqs mysql api
docker compose -f apps/fullstack/demo/compose.yml run --rm --entrypoint python ingestion /demo/seed_outbox.py setup
docker compose -f apps/fullstack/demo/compose.yml up -d worker
docker compose -f apps/fullstack/demo/compose.yml run --rm --entrypoint python ingestion /demo/seed_outbox.py seed
docker compose -f apps/fullstack/demo/compose.yml run --rm ingestion publish-outbox --limit 10
docker compose -f apps/fullstack/demo/compose.yml run --rm --entrypoint python ingestion /demo/seed_outbox.py verify
```

O último comando exige `SUCCEEDED`, cobertura 1, outbox `PUBLISHED` e fila
drenada. Para a falha demonstrada, execute `seed_outbox.py invalid` e depois
`seed_outbox.py dlq`; o Worker rejeita o JSON fora do contrato e a mensagem
termina na DLQ.

Os manifests em `apps/kubernetes/demo/manifests` são específicos do cluster
local. O HPA pode aparecer como `cpu: <unknown>/70%` durante a primeira coleta;
a escala mostrada no vídeo é manual e não deve ser descrita como escala
automática comprovada.
