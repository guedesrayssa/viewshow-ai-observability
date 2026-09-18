"""Identifica os utilitários operacionais e de manutenção da ingestão.

Papel no fluxo:
    Este arquivo é uma ferramenta operacional executada fora do worker principal e valida todas
    as entradas antes de produzir efeitos externos.

Garantias e limites:
    A saída contém somente evidências não sensíveis que podem ser preservadas para auditoria ou
    consumidas pela etapa operacional seguinte.
"""
