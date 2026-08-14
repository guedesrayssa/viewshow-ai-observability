"""Popula a API com telemetria sintética para demonstração.

O painel só tem o que mostrar depois que existem eventos, erros e heartbeats na
janela consultada. Este script produz um conjunto plausível e envia pelos
próprios endpoints públicos de ingestão — nada é escrito direto no
repositório —, então serve tanto para preparar a gravação do vídeo quanto para
evidenciar, no relatório de testes, que os `POST` alimentam os `GET`.

O envio usa apenas a biblioteca padrão: o script roda na máquina do
desenvolvedor ou na própria instância EC2 sem instalar nada.

Uso:

    python scripts/seed_demo.py
    python scripts/seed_demo.py --base-url http://54.90.12.34

Atenção à retenção: a aplicação descarta registros com mais de 24 horas, e a
tabela do DynamoDB apaga os itens vencidos pelo TTL. Semeie no mesmo dia da
gravação ou dos testes.
"""

from __future__ import annotations

import argparse
import json
import random
import urllib.error
import urllib.request
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

# Mantido abaixo de `MAX_BATCH_SIZE` (500) para que cada envio caiba em um lote.
CHUNK_SIZE = 250

# Aparelhos representativos do parque da TV conectada.
DEVICES = (
    ("OLED55C7P", "webos", "3.5", "5.12.0"),
    ("OLED65B8", "webos", "4.0", "5.11.4"),
    ("UN55MU6100", "tizen", "3.0", "5.12.0"),
    ("L43S6500", "linux", "unknown", "5.12.0"),
    ("PTV43G70", "netrange", "unknown", "5.10.2"),
)

CDNS = ("akamai", "cloudfront", "fastly")

# Catálogo de falhas: código, mensagem, se derruba a sessão, módulo de origem e
# peso relativo. A mistura de fatais e não fatais é o que faz o ranking do
# painel exibir as duas cores de severidade.
ERROR_CATALOG = (
    ("DNS_RESOLVE_FAIL", "getaddrinfo ENOTFOUND cdn.globo.com", True, "player", 34),
    ("PLAYER_TIMEOUT", "manifest request timed out after 30s", False, "player", 23),
    ("DRM_LICENSE_DENIED", "widevine license request returned 403", True, "drm", 17),
    ("ANR_MAIN_THREAD", "main thread blocked for 6.2s", False, "ui", 12),
    ("MANIFEST_PARSE_ERROR", "unexpected token in HLS manifest", False, "player", 9),
    ("AUTH_TOKEN_EXPIRED", "token expired 412s ago", False, "auth", 6),
)


def iso(moment: datetime) -> str:
    """Formata uma data no padrão ISO 8601 com sufixo `Z`.

    Recebe em `moment` um horário com fuso e devolve o texto aceito pelo campo
    `timestamp` dos payloads de ingestão, sem microssegundos.
    """
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def context(index: int, rng: random.Random) -> tuple[dict[str, str], dict[str, str]]:
    """Monta os blocos `device` e `network` de um registro.

    Recebe em `index` a posição do registro, usada para percorrer a lista de
    aparelhos de forma determinística, e em `rng` a fonte de aleatoriedade.
    Devolve a dupla `(device, network)` pronta para entrar no payload.
    """
    model, operating_system, os_version, app_version = DEVICES[index % len(DEVICES)]
    device = {
        "model": model,
        "os": operating_system,
        "os_version": os_version,
        "app_version": app_version,
    }
    network = {
        "isp": rng.choice(("isp-alpha", "isp-beta", "isp-gama")),
        "cdn": CDNS[index % len(CDNS)],
        "connection_type": rng.choice(("wifi", "ethernet", "wifi")),
    }
    return device, network


def build_events(
    count: int, sessions: int, span: timedelta, now: datetime, rng: random.Random
) -> list[dict[str, Any]]:
    """Gera os eventos de reprodução.

    Recebe a quantidade em `count`, o número de sessões distintas em
    `sessions`, o intervalo coberto em `span`, o horário de referência em `now`
    e a fonte de aleatoriedade em `rng`. Devolve a lista de payloads de
    `/v1/telemetry/events`.

    O tempo de início segue uma distribuição normal em torno de 1,9 s, com piso
    de 300 ms, para que os percentis do painel fiquem distintos entre si em vez
    de todos caírem no mesmo valor.
    """
    minutes = int(span.total_seconds() // 60)
    events = []
    for index in range(count):
        device, network = context(index, rng)
        events.append(
            {
                "session_id": f"sess-{index % sessions:04d}",
                "event_type": "playback_start",
                "timestamp": iso(now - timedelta(minutes=rng.randint(1, minutes))),
                "content_id": f"globoplay-ep-{rng.randint(1000, 9999)}",
                "startup_time_ms": max(300, int(rng.gauss(1900, 700))),
                "rebuffer_duration_ms": max(0, int(rng.gauss(900, 1400))),
                "rebuffer_count": rng.choice((0, 0, 0, 1, 2)),
                "playback_duration_ms": rng.randint(120_000, 3_600_000),
                "bitrate_kbps": rng.choice((1800, 2600, 3400, 4200, 5200)),
                "device": device,
                "network": network,
            }
        )
    return events


def build_errors(
    sessions: int, span: timedelta, now: datetime, rng: random.Random
) -> list[dict[str, Any]]:
    """Gera as ocorrências de erro a partir de `ERROR_CATALOG`.

    Recebe o número de sessões distintas em `sessions`, o intervalo coberto em
    `span`, o horário de referência em `now` e a fonte de aleatoriedade em
    `rng`. Devolve a lista de payloads de `/v1/telemetry/errors`, cuja
    quantidade por código segue o peso declarado no catálogo.

    Cada erro recebe um `trace_id`, o que permite consultar a rota de trace da
    API a partir de qualquer ocorrência.
    """
    minutes = int(span.total_seconds() // 60)
    errors = []
    index = 0
    for code, message, fatal, module, weight in ERROR_CATALOG:
        for _ in range(weight):
            device, network = context(index, rng)
            index += 1
            errors.append(
                {
                    "session_id": f"sess-{index % sessions:04d}",
                    "error_code": code,
                    "message": message,
                    "fatal": fatal,
                    "module": module,
                    "service": "playback-api",
                    "trace_id": f"trace-{index:04x}",
                    "timestamp": iso(now - timedelta(minutes=rng.randint(1, minutes))),
                    "device": device,
                    "network": network,
                }
            )
    return errors


def build_heartbeats(
    sessions: int, span: timedelta, now: datetime, rng: random.Random
) -> list[dict[str, Any]]:
    """Gera um heartbeat por sessão.

    Recebe o número de sessões em `sessions`, o intervalo coberto em `span`, o
    horário de referência em `now` e a fonte de aleatoriedade em `rng`. Devolve
    a lista de payloads de `/v1/telemetry/heartbeat`, que é a base do total de
    sessões usado nas taxas de erro e de sessões sem falha.
    """
    minutes = int(span.total_seconds() // 60)
    return [
        {
            "session_id": f"sess-{index:04d}",
            "timestamp": iso(now - timedelta(minutes=rng.randint(1, minutes))),
        }
        for index in range(sessions)
    ]


def post(base_url: str, path: str, payload: Any, timeout: float = 30.0) -> dict[str, Any]:
    """Envia um payload JSON para um endpoint da API.

    Recebe o endereço base em `base_url`, o caminho do endpoint em `path`, o
    corpo já em estruturas Python em `payload` e o limite de espera em
    `timeout`. Devolve o corpo da resposta convertido em dicionário.

    Levanta `RuntimeError` quando a API responde fora da faixa 2xx, repassando
    a mensagem devolvida pelo servidor para que a causa apareça no terminal.
    """
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{path} respondeu {exc.code}: {exc.read().decode()}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Não foi possível alcançar {base_url}: {exc.reason}") from exc


def send(base_url: str, path: str, items: Sequence[dict[str, Any]]) -> int:
    """Envia uma coleção de registros em lotes.

    Recebe o endereço base em `base_url`, o caminho do endpoint em `path` e os
    registros em `items`, que são fatiados em blocos de `CHUNK_SIZE` para
    respeitar o limite de lote da ingestão. Devolve o total de registros que a
    API declarou ter aceitado.
    """
    accepted = 0
    for start in range(0, len(items), CHUNK_SIZE):
        chunk = items[start : start + CHUNK_SIZE]
        result = post(base_url, path, list(chunk))
        accepted += int(result.get("accepted", 0))
    print(f"{path}: {accepted}/{len(items)} aceitos")
    return accepted


def main() -> int:
    """Lê os argumentos da linha de comando, gera a massa e a envia à API.

    Devolve `0` quando todos os lotes são aceitos e `1` quando algum envio
    falha, para que a execução possa ser encadeada em scripts de implantação.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="http://localhost:5000",
        help="endereço da API, por exemplo http://<IP-DA-EC2>",
    )
    parser.add_argument("--events", type=int, default=420, help="quantidade de eventos")
    parser.add_argument("--sessions", type=int, default=180, help="sessões distintas")
    parser.add_argument(
        "--hours",
        type=float,
        default=23.0,
        help="quantas horas para trás espalhar os registros (a retenção é de 24h)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=11,
        help="semente da aleatoriedade; o mesmo valor reproduz a mesma massa",
    )
    args = parser.parse_args()

    rng = random.Random(args.seed)
    now = datetime.now(timezone.utc)
    span = timedelta(hours=args.hours)

    events = build_events(args.events, args.sessions, span, now, rng)
    errors = build_errors(args.sessions, span, now, rng)
    heartbeats = build_heartbeats(args.sessions, span, now, rng)

    try:
        send(args.base_url, "/v1/telemetry/events", events)
        send(args.base_url, "/v1/telemetry/errors", errors)
        send(args.base_url, "/v1/telemetry/heartbeat", heartbeats)
    except RuntimeError as exc:
        print(f"Falha ao semear: {exc}")
        return 1

    print(f"Massa semeada em {args.base_url}. Consulte o painel com `window=24h`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
