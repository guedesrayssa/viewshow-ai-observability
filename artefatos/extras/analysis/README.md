# Análise do dump Argus

Este laboratório explora uma cópia local do dump MySQL do Argus. Os notebooks
são somente de leitura, preservam a distinção entre UTC e BRT e limitam cada
DataFrame a 100.000 linhas. Execute todos os comandos abaixo a partir de
`artefatos/extras/analysis/`.

## Ambiente local

```bash
rtk python3 -m venv .venv
rtk .venv/bin/pip install -e '.[dev]'
rtk cp .env.example .env
rtk docker compose up -d mysql
```

Substitua apenas as senhas locais em `.env`; esse arquivo não é versionado.
`ARGUS_DATABASE_URL` aponta para o dump local, `ARGUS_TEST_DATABASE_URL` para
o banco isolado de teste, `ARGUS_MAX_ROWS` define o teto de resultados e
`ARGUS_DISPLAY_TIMEZONE` controla a apresentação. Credenciais de produção
nunca pertencem a exemplo de comando ou notebook.

## Importação manual do dump

A importação completa é manual e observável. Antes dela, confira os recursos:

```bash
rtk free -h
rtk gzip -dc ../../../../dados/argus_dump.sql.gz \
  | rtk mysql --host=127.0.0.1 --port=3307 --user=argus --password argus
```

Prefira o prompt de senha a colocá-la no histórico do shell. A importação e a
criação de índices exigem bastante disco e tempo. Não execute importação,
testes amplos e servidores ao mesmo tempo.

## Fixture isolado e smoke test

O fixture é sanitizado e recria somente tabelas mínimas em `argus_test`; ele
nunca aceita `argus` como alvo. Depois de configurar apenas as senhas locais em
`.env`, execute:

```bash
rtk docker compose up -d mysql
rtk .venv/bin/python scripts/load_test_fixture.py
ARGUS_TEST_DATABASE_URL=mysql+pymysql://root:change-root-me@127.0.0.1:3307/argus_test?charset=utf8mb4 \
  rtk .venv/bin/python -m pytest tests/integration/test_notebooks.py -v
```

A URL é estritamente local e deve corresponder ao `.env` não versionado do
desenvolvedor. Se `ARGUS_TEST_DATABASE_URL` estiver ausente, o smoke test é
explicitamente ignorado e mostra este comando de preparação.

## Notebooks

Execute em ordem: `00_catalogo_dataset`, `01_cobertura_qualidade`,
`02_sinais_normalizados`, `03_infraestrutura_qos`, `04_experiencia_qoe`,
`05_incidentes_rca`, `06_eventos_ao_vivo` e `07_contrato_ingestao`.

Para abrir o laboratório:

```bash
rtk .venv/bin/jupyter lab
```

Os arquivos versionados são gerados sem execução nem saídas. Para regenerar os
oito notebooks de forma determinística:

```bash
rtk .venv/bin/python scripts/build_notebooks.py all
```

Os testes de unidade e higiene rodam com `rtk .venv/bin/python -m pytest -q`.
