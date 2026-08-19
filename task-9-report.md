# Task 9 — Contrato lógico e notebook 07

## Entregas

- Criado `dump_explorer.contract` com `LogicalField`, `ContractIssue`, catálogo
  tabular, validação de mapeamento físico e exportação CSV confinada a
  `analysis/outputs`.
- O catálogo cobre apenas domínios documentados: tickets ServiceNow e agregados
  NPAW/Youbora. Todos os nomes físicos de BigQuery permanecem literalmente como
  `não fornecido`.
- As seis colunas lógicas de `frontend_events_sample` estão separadas sob
  `source_system="amostra frontend; origem BigQuery não comprovada"`; elas não
  são apresentadas como fonte BigQuery confirmada.
- Gerado `analysis/notebooks/07_contrato_ingestao.ipynb`, sem outputs nem
  contagens de execução. A exportação é opt-in (`export_csv = False`) e usa o
  diretório de outputs definido pelo módulo.

## Garantias aplicadas

- `player_hourly.hour_ts` registra timestamp do evento e atraso NPAW de `~28h`.
- `incidents.opened_at` é documentado como hora de abertura do ticket, não início
  do incidente; a incerteza de +5-40 minutos permanece explícita.
- A validação reporta tabela/coluna BigQuery, partição, watermark e semântica de
  update ausentes, além de campos candidatos a chave natural duplicados.
- A exportação resolve o caminho e rejeita qualquer destino fora de
  `analysis/outputs`.
- O notebook finaliza com as perguntas de contrato para a Globo: project/dataset/table,
  partição, watermark, chave natural, late arrivals, corrections/deletes, schema
  evolution, PII e query quotas.

## Verificação

- RED observado: `tests/test_contract.py` falhou com `ModuleNotFoundError:
  dump_explorer.contract` antes da implementação.
- RED observado: a geração de notebook 07 falhou inicialmente com `ValueError:
  Notebook não suportado: 07`; o teste de CLI também falhou até adicionar `07`
  às escolhas do parser.
- GREEN: `python -m pytest tests/test_contract.py -v` — 8 passed.
- Estilo: `ruff check src/dump_explorer/contract.py tests/test_contract.py
  scripts/build_notebooks.py` — sem erros.
- Geração: `python scripts/build_notebooks.py 07` — 12 células, sem outputs ou
  estado de execução persistido.
- Regressão: `python -m pytest -v` — 98 passed, execução serial.
