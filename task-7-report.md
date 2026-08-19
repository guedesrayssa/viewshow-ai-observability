# Task 7 — Incidentes e RCA

## Entregas

- Implementado `dump_explorer.rca` com loaders limitados para tickets, rótulos,
  atribuição de erros, janelas de incidente e artefatos de dashboard.
- Adicionados gráficos de linha do tempo, proveniência e atribuição por camada.
- Gerado `analysis/notebooks/05_incidentes_rca.ipynb`, sem outputs nem contagens
  de execução.

## Garantias aplicadas

- `scope` é uma allowlist: `video` lê `incidents` e `platform` lê
  `incidents_platform`; os universos não são combinados.
- `opened_at` permanece a hora de abertura do ticket, explicitamente rotulada como
  diferente do início do incidente e acompanhada pela banda visual de ±40 minutos.
- A avaliação padrão carrega somente `rca-confirmed` e `team-confirmed`;
  `detector-derived` permanece disponível apenas para exibição com `circular=True`.
- Texto livre sanitizado, identificadores individuais e `error_name` não são
  consultados nem usados em hover data. JSON de `services` e `metrics_cited` é
  preservado com flags de parsing em caso de formato inválido.
- Consultas temporais são parametrizadas, usam `[start, end)` e `LIMIT` com o
  teto global de 100.000 linhas. Offsets de janelas aceitam apenas 15m, 30m, 1h,
  2h e 6h.
- Artefatos são consultados por nome exato, devem ser JSON com raiz mapping e não
  têm associação aproximada com rótulos humanos.

## Verificação

- RED observado para `tests/test_rca.py`: `ModuleNotFoundError:
  dump_explorer.rca`.
- RED observado para notebook 05: `ValueError: Notebook não suportado: 05`.
- GREEN: `.venv/bin/python -m pytest tests/test_rca.py tests/test_charts.py
  tests/test_notebook_builder.py -v` — 27 passed.
- Estilo: `ruff check` e `ruff format --check` sobre os quatro arquivos Python
  alterados — sem erros.
- Geração: `.venv/bin/python scripts/build_notebooks.py 05` — notebook criado
  sem outputs nem execução persistida.
