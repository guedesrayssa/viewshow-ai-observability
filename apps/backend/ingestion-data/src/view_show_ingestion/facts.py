"""Mantém o caminho de importação original dos fatos do worker de análise.

A identidade canônica da série e o item de fato vivem em ``domain.analysis_facts``, que faz
parte da imagem da ingestão e é o único ponto de verdade do contrato com o worker.
"""

from domain.analysis_facts import SeriesIdentity, build_fact, canonical_series_identity, series_id

__all__ = ["SeriesIdentity", "build_fact", "canonical_series_identity", "series_id"]
