"""Provisiona a tabela de telemetria no DynamoDB.

Uso:

    python scripts/create_dynamodb_table.py
    DYNAMODB_ENDPOINT_URL=http://localhost:8000 python scripts/create_dynamodb_table.py

A operação é idempotente: se a tabela já existir, nada é alterado.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import boto3  # noqa: E402

from app.config import Config  # noqa: E402
from app.repositories.dynamodb import create_table  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", default=Config.DYNAMODB_TABLE, help="nome da tabela")
    parser.add_argument("--region", default=Config.DYNAMODB_REGION, help="região da AWS")
    parser.add_argument(
        "--endpoint-url",
        default=Config.DYNAMODB_ENDPOINT_URL,
        help="endpoint alternativo (por exemplo, DynamoDB Local)",
    )
    parser.add_argument(
        "--billing-mode",
        default="PAY_PER_REQUEST",
        choices=("PAY_PER_REQUEST", "PROVISIONED"),
        help="modo de cobrança da tabela",
    )
    args = parser.parse_args()

    client = boto3.client("dynamodb", region_name=args.region, endpoint_url=args.endpoint_url)
    created = create_table(client, args.table, billing_mode=args.billing_mode)

    if created:
        print(f"Tabela `{args.table}` criada com o índice `trace-index` e TTL em `expires_at`.")
    else:
        print(f"Tabela `{args.table}` já existe; nada a fazer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
