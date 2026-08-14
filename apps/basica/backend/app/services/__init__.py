"""Serviços de aplicação: onde vive a regra de negócio da telemetria.

Cada serviço recebe suas dependências pelo construtor (repositório, relógio,
limiares), de modo que possa ser exercitado em teste sem contexto Flask.
"""
