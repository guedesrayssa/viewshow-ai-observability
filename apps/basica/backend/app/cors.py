"""Política de CORS da API.

O painel é servido por um bucket S3 e a API roda em uma instância EC2: são
origens diferentes, então o navegador só entrega a resposta ao JavaScript da
página se a própria API autorizar aquela origem. Sem isso a requisição chega a
sair e o servidor chega a responder, mas o `fetch` falha no cliente — o sintoma
clássico de "a API está no ar e a tela continua vazia".

Clientes que não são navegadores — Postman, curl e os testes automatizados —
ignoram CORS por completo e não são afetados por nada deste módulo.

A liberação vale apenas para as rotas da API v1; qualquer outra rota continua
sem cabeçalhos de CORS.
"""

from __future__ import annotations

from flask import Flask
from flask_cors import CORS

#: Valor que libera qualquer origem.
ALLOW_ALL = "*"

#: Rotas cobertas pela política. Cobre ingestão e analytics.
API_RESOURCE = r"/v1/*"


def parse_origins(raw: str) -> list[str] | str:
    """Interpreta o valor bruto de `CORS_ORIGINS`.

    Recebe em `raw` a string vinda da configuração, com as origens separadas
    por vírgula (por exemplo,
    `http://meu-bucket.s3-website-us-east-1.amazonaws.com,http://localhost:5173`).

    Devolve a lista de origens explícitas, já sem os espaços em volta de cada
    item, ou `"*"` quando a configuração libera todas — o que acontece se o
    valor for vazio ou se `*` estiver entre as origens.
    """
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    if not origins or ALLOW_ALL in origins:
        return ALLOW_ALL
    return origins


def init_app(app: Flask) -> None:
    """Registra os cabeçalhos de CORS nas rotas da API v1.

    Recebe em `app` a aplicação já configurada, de onde lê a chave
    `CORS_ORIGINS`. Não devolve valor: o efeito é o registro do handler no
    próprio `app`, que passa a responder às requisições de verificação prévia
    (`OPTIONS`) e a acrescentar `Access-Control-Allow-Origin` às respostas.

    Os métodos e cabeçalhos liberados são exatamente os que a aplicação usa:
    `GET` para as consultas do painel, `POST` para a ingestão e `Content-Type`
    junto de `Accept` no corpo da requisição.
    """
    CORS(
        app,
        resources={API_RESOURCE: {"origins": parse_origins(app.config["CORS_ORIGINS"])}},
        methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
        max_age=3600,
    )
