"""Fábrica da aplicação Flask."""

from __future__ import annotations

from typing import Any

from flask import Flask

from app import container
from app.config import Config
from app.errors import register_error_handlers


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    """Cria a aplicação, monta as dependências e registra os controllers da API v1."""
    app = Flask(__name__)
    app.config.from_object(Config)

    if test_config:
        app.config.update(test_config)

    container.init_app(app)
    register_error_handlers(app)
    _register_blueprints(app)

    return app


def _register_blueprints(app: Flask) -> None:
    # Importados aqui para que os controllers possam depender de `app.container`
    # sem criar ciclo de importação com este módulo.
    from app.controllers.analytics import analytics_bp
    from app.controllers.rca import rca_bp
    from app.controllers.telemetry import telemetry_bp

    app.register_blueprint(telemetry_bp)
    app.register_blueprint(analytics_bp)
    app.register_blueprint(rca_bp)
