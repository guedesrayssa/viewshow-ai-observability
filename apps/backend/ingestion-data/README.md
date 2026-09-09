# Ingestion Data — not implemented

Ownership: time de ingestão de dados.

Este diretório reserva a fronteira do futuro processo batch que lerá as novas
fontes e publicará read models versionados (`VIEW#...`, incidentes, checkpoints
e runs) segundo os contratos em `artefatos/contratos`. Esta entrega não contém
worker, endpoint, scheduler, seed, leitor MySQL, normalizador ou projeção.

O backend operacional é somente consumidor. A PR futura deve respeitar
proveniência, measurement, cobertura, freshness e a inexistência de fila no
pipeline batch atual.
