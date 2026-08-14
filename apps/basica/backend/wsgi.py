"""Ponto de entrada da aplicação.

Expõe a instância WSGI `app` consumida pelo servidor de produção e, quando
executado diretamente, sobe o servidor embutido do Flask para desenvolvimento.

    # desenvolvimento
    python wsgi.py

    # produção, na EC2
    gunicorn -w 3 -b 127.0.0.1:8000 wsgi:app

O arquivo se chama `wsgi.py`, e não `app.py`, porque o pacote da aplicação já
ocupa o nome `app`: um módulo homônimo ao lado dele seria ofuscado pelo pacote,
e `gunicorn app:app` carregaria o pacote em vez deste arquivo, falhando com
"Failed to find attribute 'app' in 'app'".
"""

import os

from app import create_app

#: Instância WSGI da aplicação, criada uma vez na importação do módulo.
app = create_app()


if __name__ == "__main__":
    # O modo debug expõe um console interativo: fica desligado por padrão e só
    # é habilitado explicitamente, com `FLASK_DEBUG=1 python wsgi.py`.
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "0") == "1",
    )
