from flask import Flask

from app.controllers.analytics import analytics_bp
from app.controllers.rca import rca_bp
from app.controllers.telemetry import telemetry_bp


def create_app(test_config: dict | None = None) -> Flask:
    """Cria a aplicação e registra os controllers da API v1."""
    app = Flask(__name__)
    app.config.from_mapping(TELEMETRY_STORE={"events": [], "errors": [], "heartbeats": []})

    if test_config:
        app.config.update(test_config)

    app.register_blueprint(telemetry_bp)
    app.register_blueprint(analytics_bp)
    app.register_blueprint(rca_bp)

    return app
