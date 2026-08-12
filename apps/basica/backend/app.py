"""Ponto de entrada de desenvolvimento.

Em produção, sirva `app` com um servidor WSGI (por exemplo,
`gunicorn "app:app"`), e não com o servidor embutido do Flask.
"""

import os

from app import create_app

app = create_app()


if __name__ == "__main__":
    # O modo debug expõe um console interativo: fica desligado por padrão e só
    # é habilitado explicitamente, com `FLASK_DEBUG=1 python app.py`.
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "0") == "1",
    )
