"""Fábrica da aplicação Flask."""

from __future__ import annotations

import sys
from typing import Any

from flask import Flask

from app import container, cors
from app.config import Config
from app.errors import register_error_handlers

#: Versão mínima do interpretador, também declarada em `pyproject.toml`.
MINIMUM_PYTHON = (3, 10)

# A verificação acontece na importação, e não em tempo de execução das rotas,
# porque as incompatibilidades desta faixa de versão são silenciosas na subida:
# a aplicação inicia normalmente e só falha quando alguém abre a série temporal
# ou o detalhe de um erro. Falhar aqui transforma um erro de demonstração em um
# erro de instalação, que aparece no `systemctl status`.
#
# O caso concreto é o Amazon Linux 2023, cujo `python3` é 3.9 e assim
# permanecerá: na instância, o ambiente virtual precisa ser criado com
# `python3.11 -m venv`.
if sys.version_info < MINIMUM_PYTHON:
    raise RuntimeError(
        "A aplicação exige Python "
        f"{MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} ou mais recente; "
        f"em uso: {sys.version_info[0]}.{sys.version_info[1]}. "
        "No Amazon Linux 2023, instale `python3.11` e recrie o ambiente "
        "virtual com `python3.11 -m venv .venv`."
    )


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    """Cria a aplicação, monta as dependências e registra os controllers da API v1."""
    app = Flask(__name__)
    app.config.from_object(Config)

    if test_config:
        app.config.update(test_config)

    _validate_load_test_fault_config(app)

    container.init_app(app)
    cors.init_app(app)
    register_error_handlers(app)
    _register_blueprints(app)

    return app


def _validate_load_test_fault_config(app: Flask) -> None:
    if not app.config["LOAD_TEST_FAULTS_ENABLED"]:
        return
    if not app.config["LOAD_TEST_FAULT_TOKEN"]:
        raise RuntimeError(
            "LOAD_TEST_FAULT_TOKEN é obrigatório quando LOAD_TEST_FAULTS_ENABLED=1."
        )
    delay_ms = app.config["LOAD_TEST_TIMEOUT_DELAY_MS"]
    if not isinstance(delay_ms, int) or not 0 <= delay_ms <= 5_000:
        raise RuntimeError("LOAD_TEST_TIMEOUT_DELAY_MS deve estar entre 0 e 5000.")


def _register_blueprints(app: Flask) -> None:
    # Importados aqui para que os controllers possam depender de `app.container`
    # sem criar ciclo de importação com este módulo.
    from app.controllers.analytics import analytics_bp
    from app.controllers.rca import rca_bp
    from app.controllers.telemetry import telemetry_bp

    app.register_blueprint(telemetry_bp)
    app.register_blueprint(analytics_bp)
    app.register_blueprint(rca_bp)
